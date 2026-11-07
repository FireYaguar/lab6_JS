import { asSeq, type EntityId, type Seq } from 'shared/brand.ts'
import { Bus } from 'shared/bus.ts'
import { decodeSnapshot } from 'shared/net/binary.ts'
import { codecs } from 'shared/net/codec.ts'
import { STEP, SUBSTEPS, TICK_MS } from 'shared/net/constants.ts'
import type {
  EntityState,
  InputMessage,
  RoomInfo,
  ShipState,
  Snapshot,
} from 'shared/net/protocol.ts'
import { type Arena, createArena, lerpWrapped, wrap } from 'shared/sim/arena.ts'
import { type Bullet, Explosion } from 'shared/sim/entity.ts'
import { mulberry32 } from 'shared/sim/random.ts'
import { Ship } from 'shared/sim/ship.ts'
import { assertNever } from 'shared/sim/types.ts'
import { Vector2 } from 'shared/sim/vector.ts'
import { stepShip, type WorldEvents } from 'shared/sim/world.ts'
import { type Input, readControls } from '../input.ts'
import { lerpAngle, type RenderItem } from '../render/draw.ts'
import type { Connection } from './connection.ts'
import type { NetSettings } from './net-panel.ts'

// Мережева гра (Lab 5). Сервер авторитетний; клієнт:
//  • шле input з seq кожен тік (30/с), ніколи не координати;
//  • ПЕРЕДБАЧАЄ свій корабель тим самим stepShip, що й сервер;
//  • на знімку — ЗВІРКА: стан сервера + повторне програвання непідтверджених input, поправка згладжується ~100 мс;
//  • чужі сутності малює В МИНУЛОМУ — інтерполяція між двома знімками (interpDelay);
//  • свої кулі показує одразу (передбачені), серверні копії своїх куль ховає.

const SMOOTH_TAU = 0.033 // с: за 100 мс лишається ~5% поправки
const SNAP_LIMIT = 200 // px: більший стрибок (респаун, загортання) не згладжуємо, а ставимо одразу
const CHAOS = 25 // px/с випадкового шуму в передбаченні — експеримент «Math.random() в integrate»

interface Buffered {
  time: number
  map: Map<EntityId, EntityState>
}
interface NetStats {
  rtt: number
  snapshotAt: number
  snapshotsPerSec: number
  downBps: number
  upBps: number
  correction: number
  correctionMax: number
  corrections: [ms: number, px: number][] // за останні 3 с — для графіка
  inputLatency: number | null
  tick: number
  entities: number
}

export interface NetGame {
  readonly arena: Arena
  readonly bus: Bus<WorldEvents>
  readonly me: Ship
  readonly stats: NetStats
  readonly settings: NetSettings
  readonly pending: number
  readonly entityCount: number
  simulate(): void
  items(alpha: number): RenderItem[]
}

function wrappedDelta(d: number, size: number): number {
  if (d > size / 2) return d - size
  if (d < -size / 2) return d + size
  return d
}

// Запис знімка (дві точки в часі) → RenderItem. switch за kind: новий тип сутності без рендеру → помилка tsc.
function stateItem(
  a: EntityState,
  b: EntityState,
  t: number,
  arena: Arena,
  mine: boolean,
): RenderItem | null {
  const x = lerpWrapped(a.x, b.x, t, arena.width)
  const y = lerpWrapped(a.y, b.y, t, arena.height)
  switch (b.kind) {
    case 'ship':
      return {
        kind: 'ship',
        x,
        y,
        angle: a.kind === 'ship' ? lerpAngle(a.angle, b.angle, t) : b.angle,
        mine,
        look: b,
      }
    case 'asteroid':
      return {
        kind: 'asteroid',
        x,
        y,
        angle: a.kind === 'asteroid' ? lerpAngle(a.angle, b.angle, t) : b.angle,
        radius: b.radius,
        shape: b.shape,
        homing: b.homing,
      }
    case 'bullet':
      return { kind: 'bullet', x, y, homing: b.homing }
    case 'pickup':
      return { kind: 'pickup', x, y, effect: b.effect }
    case 'explosion':
      return null // частинки — клієнтська косметика (Explosion нижче)
    default:
      return assertNever(b)
  }
}

export function createNetGame({
  conn,
  room,
  name,
  input,
  settings,
}: {
  conn: Connection
  room: RoomInfo
  name: string
  input: Input
  settings: NetSettings
}): NetGame {
  const arena = createArena(room.arena.width, room.arena.height)
  const codec = codecs[settings.codec]
  const bus = new Bus<WorldEvents>() // ті самі події, що в локальному режимі: звук і HUD не знають про мережу

  const me = new Ship({ name }) // передбачений свій корабель (локальний id ≠ серверний)
  me.solid = false // до першого знімка не малюємо
  let shipId: EntityId | null = null // id корабля на сервері
  let seq = 0
  const pending: InputMessage[] = [] // input, які сервер ще не підтвердив
  const prev = { x: 0, y: 0, angle: 0 } // стан перед останнім тіком — для інтерполяції рендеру
  const smooth = { x: 0, y: 0 } // візуальна поправка, що згасає до 0
  const myBullets = new Map<Seq, { bullet: Bullet; seen: boolean }>()
  const explosions = new Map<EntityId, Explosion>() // косметика клієнта
  const buffer: Buffered[] = [] // останні знімки
  let latest: Snapshot | null = null
  let clockOffset: number | null = null // серверний час − performance.now()
  let lastFrame = performance.now()

  const stats: NetStats = {
    rtt: 0,
    snapshotAt: 0,
    snapshotsPerSec: 0,
    downBps: 0,
    upBps: 0,
    correction: 0,
    correctionMax: 0,
    corrections: [],
    inputLatency: null,
    tick: 0,
    entities: 0,
  }

  // ---------- мережа ----------
  conn.on('match', (m) => {
    shipId = m.shipId
  })
  conn.on('pong', (m) => {
    stats.rtt = performance.now() - m.t
  })
  conn.on('binary', (data) => {
    try {
      onSnapshot(decodeSnapshot(data))
    } catch (err: unknown) {
      console.warn('[net] битий знімок', err) // декодер — валідатор: краще пропустити кадр, ніж упасти
    }
  })
  conn.on('snapshot', (snap) => onSnapshot(snap)) // ?codec=json — уже пройшов схему в Connection
  conn.on('open', () => {
    pending.length = 0 // новий сокет — новий корабель на сервері
    latest = null
    buffer.length = 0
    conn.send({ type: 'netsim', lag: settings.lag, jitter: settings.jitter, drop: settings.drop })
  })

  let snapsThisSecond = 0
  let lastIn = 0
  let lastOut = 0
  setInterval(() => conn.send({ type: 'ping', t: performance.now() }), 500)
  setInterval(() => {
    stats.snapshotsPerSec = snapsThisSecond
    snapsThisSecond = 0
    stats.downBps = conn.bytesIn - lastIn
    stats.upBps = conn.bytesOut - lastOut
    lastIn = conn.bytesIn
    lastOut = conn.bytesOut
  }, 1000)

  function predict(cmd: InputMessage): Bullet | null {
    const bullet = stepShip(me, cmd, STEP, arena)
    if (settings.chaos && me.solid) {
      // НАВМИСНО недетерміновано: клієнт рахує не так, як сервер → поправки ростуть
      me.vel = me.vel.add(new Vector2((Math.random() - 0.5) * CHAOS, (Math.random() - 0.5) * CHAOS))
    }
    return bullet
  }

  function reconcile(own: ShipState, ack: Seq): void {
    const old = {
      x: me.pos.x,
      y: me.pos.y,
      hp: me.hp,
      score: me.score,
      shield: me.shield,
      rapid: me.rapid,
      homing: me.homingShots,
      solid: me.solid,
    }
    me.syncFrom(own) // 1. «насправді ти був тут» (стан після input #ack); ShipState підходить як ShipSync структурно
    while ((pending[0]?.seq ?? Number.POSITIVE_INFINITY) <= ack) pending.shift() // 2. підтверджене — викинути
    if (settings.prediction && settings.reconcile) {
      for (const cmd of pending) for (let s = 0; s < SUBSTEPS; s++) predict(cmd) // 3. переграти решту
    }
    if (!settings.prediction) return

    const dx = wrappedDelta(me.pos.x - old.x, arena.width)
    const dy = wrappedDelta(me.pos.y - old.y, arena.height)
    const dist = Math.hypot(dx, dy)
    if (old.solid && me.solid && dist < SNAP_LIMIT) {
      // візуально нічого не стрибає: зсув переносимо в smooth, який згасне за ~100 мс
      smooth.x -= dx
      smooth.y -= dy
      prev.x += dx
      prev.y += dy
    } else {
      smooth.x = 0
      smooth.y = 0
      prev.x = me.pos.x
      prev.y = me.pos.y
      prev.angle = me.angle
    }
    if (old.solid && me.solid) {
      stats.correction = dist
      stats.corrections.push([performance.now(), dist])
    }

    // події для звуку й HUD — з різниці станів
    if (me.hp < old.hp)
      bus.emit('hit', { targetId: me.id, sourceId: me.id, damage: old.hp - me.hp, blocked: false })
    if (me.score > old.score)
      bus.emit('scored', { shipId: me.id, points: me.score - old.score, total: me.score })
    if (me.shield > old.shield + 1 && old.solid && me.solid)
      bus.emit('picked', { shipId: me.id, effect: 'shield' })
    if (me.rapid > old.rapid + 1) bus.emit('picked', { shipId: me.id, effect: 'rapid' })
    if (me.homingShots > old.homing + 1) bus.emit('picked', { shipId: me.id, effect: 'homing' })
  }

  function onSnapshot(snap: Snapshot): void {
    if (latest && snap.tick <= latest.tick) return // розкид затримки переставив порядок — старе ігноруємо
    latest = snap
    snapsThisSecond += 1
    stats.snapshotAt = performance.now()
    stats.tick = snap.tick
    stats.entities = snap.entities.length

    const time = snap.tick * TICK_MS
    const sample = time - performance.now()
    // орієнтуємось на НАЙШВИДШУ доставку; якщо затримка зросла — повільно підлаштовуємось
    clockOffset =
      clockOffset === null ? sample : Math.max(sample, clockOffset + (sample - clockOffset) * 0.02)
    const map = new Map<EntityId, EntityState>()
    for (const e of snap.entities) map.set(e.id, e)
    buffer.push({ time, map })
    while (buffer.length > 60) buffer.shift()

    const own = shipId !== null ? map.get(shipId) : undefined
    if (own?.kind === 'ship') reconcile(own, snap.ack)

    // свої передбачені кулі ↔ серверні (за seq input-у)
    const onServer = new Set<Seq>()
    for (const e of snap.entities)
      if (e.kind === 'bullet' && e.ownerId === shipId) onServer.add(e.seq)
    for (const [s, rec] of myBullets) {
      if (onServer.has(s)) rec.seen = true
      else if (rec.seen || s <= snap.ack) myBullets.delete(s) // сервер її знищив (влучання) або не випустив
    }
  }

  // ---------- тік клієнта (30/с) ----------
  let turnWas = 0
  let latencyProbe: { t0: number; angle: number | null } | null = null // затримка input → екран (поворот)

  function simulate(): void {
    const cmd: InputMessage = { v: 1, type: 'input', ...readControls(input), seq: asSeq(++seq) }
    input.consume()
    conn.sendRaw(codec.encodeInput(cmd))
    pending.push(cmd)
    if (pending.length > 120) pending.shift()

    // поворот, а не газ: кутової інерції немає, тож кут змінюється ЛИШЕ від input
    if (cmd.turn !== 0 && turnWas === 0 && shipId !== null)
      latencyProbe = { t0: performance.now(), angle: null }
    turnWas = cmd.turn

    prev.x = me.pos.x
    prev.y = me.pos.y
    prev.angle = me.angle
    if (settings.prediction && shipId !== null) {
      for (let s = 0; s < SUBSTEPS; s++) {
        const bullet = predict(cmd)
        if (bullet) {
          myBullets.set(cmd.seq, { bullet, seen: false })
          bus.emit('fired', { shipId: me.id, x: bullet.pos.x, y: bullet.pos.y })
        }
      }
    }
    for (const [s, rec] of myBullets) {
      const b = rec.bullet
      b.savePrev()
      for (let i = 0; i < SUBSTEPS; i++) {
        b.update(STEP)
        b.pos = wrap(b.pos, arena)
      }
      if (!b.alive) myBullets.delete(s)
    }
  }

  // ---------- рендер ----------
  function interpolated(): { a: Buffered; b: Buffered; t: number } | null {
    const first = buffer[0]
    if (!first || clockOffset === null) return null
    const renderTime = performance.now() + clockOffset - settings.interpDelay
    let a = first
    let b = first
    for (let i = buffer.length - 1; i >= 0; i--) {
      const cur = buffer[i]
      if (cur && cur.time <= renderTime) {
        a = cur
        b = buffer[i + 1] ?? cur // новішого ще немає — тримаємо останній (без екстраполяції)
        break
      }
    }
    const t =
      b.time > a.time ? Math.min(1, Math.max(0, (renderTime - a.time) / (b.time - a.time))) : 0
    return { a, b, t }
  }

  function items(alpha: number): RenderItem[] {
    const now = performance.now()
    const dt = (now - lastFrame) / 1000
    lastFrame = now
    const k = Math.exp(-dt / SMOOTH_TAU)
    smooth.x *= k
    smooth.y *= k

    const list: RenderItem[] = []
    const pair = interpolated()
    if (pair) {
      for (const e of pair.b.map.values()) {
        const mineShip = e.id === shipId
        if (settings.prediction && (mineShip || (e.kind === 'bullet' && e.ownerId === shipId)))
          continue
        if (e.kind === 'explosion') {
          if (!explosions.has(e.id)) {
            explosions.set(e.id, new Explosion({ x: e.x, y: e.y, rng: mulberry32(e.id) }))
            bus.emit('exploded', { x: e.x, y: e.y })
          }
          continue
        }
        const ea = pair.a.map.get(e.id)
        if (!ea) continue // з’явилась лише в новішому знімку — почекаємо, поки буде пара
        const item = stateItem(ea, e, pair.t, arena, mineShip)
        if (item) list.push(item)
      }
    }
    for (const [id, ex] of explosions) {
      ex.update(dt)
      if (!ex.alive) explosions.delete(id)
      else list.push({ kind: 'explosion', particles: ex.particles, ttl: ex.ttl })
    }
    let mine: { x: number; y: number; angle: number } | null = null
    if (settings.prediction) {
      for (const { bullet } of myBullets.values()) {
        list.push({
          kind: 'bullet',
          x: lerpWrapped(bullet.prevX, bullet.pos.x, alpha, arena.width),
          y: lerpWrapped(bullet.prevY, bullet.pos.y, alpha, arena.height),
          homing: bullet.homing !== null,
        })
      }
      if (me.solid) {
        mine = {
          x: lerpWrapped(prev.x, me.pos.x, alpha, arena.width) + smooth.x,
          y: lerpWrapped(prev.y, me.pos.y, alpha, arena.height) + smooth.y,
          angle: lerpAngle(prev.angle, me.angle, alpha),
        }
        list.push({ kind: 'ship', ...mine, mine: true, look: me })
      }
    } else {
      for (const item of list) if (item.kind === 'ship' && item.mine) mine = item
    }

    if (latencyProbe && mine) {
      if (latencyProbe.angle === null) latencyProbe.angle = mine.angle
      else if (Math.abs(mine.angle - latencyProbe.angle) > 0.001) {
        stats.inputLatency = now - latencyProbe.t0
        latencyProbe = null
      }
    }
    while ((stats.corrections[0]?.[0] ?? now) < now - 3000) stats.corrections.shift()
    stats.correctionMax = stats.corrections.reduce((m, c) => Math.max(m, c[1]), 0)
    return list
  }

  return {
    arena,
    bus,
    me,
    stats,
    settings,
    get pending() {
      return pending.length
    },
    get entityCount() {
      return stats.entities
    },
    simulate,
    items,
  }
}
