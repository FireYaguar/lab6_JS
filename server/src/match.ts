import { asSeq, asTick, type Seq } from 'shared/brand.ts'
import { STEP, SUBSTEPS, TICK_MS, TICK_RATE } from 'shared/net/constants.ts'
import type { InputMessage, RoomInfo } from 'shared/net/protocol.ts'
import { buildSnapshot } from 'shared/net/snapshot.ts'
import { createArena } from 'shared/sim/arena.ts'
import { Ship } from 'shared/sim/ship.ts'
import type { Command } from 'shared/sim/types.ts'
import { World } from 'shared/sim/world.ts'
import type { Player } from './types.ts'

// Авторитетна гра кімнати. Клієнти шлють input, сервер — єдине джерело правди про стан світу.
//
// Кожен тік (30/с): для кожного гравця обробляємо input із черги (по одному на «кредит»), потім крок
// решти світу і знімок кожному клієнту з його ack (останній оброблений seq).
// Кредити: +1 за тік, максимум 4. Клієнт, що шле input частіше за 30/с (speedhack), швидше не полетить.

const MAX_CREDITS = 4
const MAX_QUEUE = 16
const STATS_WINDOW = 300 // останні 10 с тіків
const DRONE_COMMAND: Command = { thrust: false, turn: 1, fire: false }

interface Slot {
  readonly player: Player
  readonly ship: Ship
  readonly queue: InputMessage[]
  credits: number
  ack: Seq
}

export interface MatchStats {
  tickRate: number
  tick: number
  players: number
  entities: number
  tickMs: { p50: number; p99: number }
  lateMs: { p50: number; p99: number }
}

export class Match {
  #timer: NodeJS.Timeout | null = null
  #next = 0
  readonly #durations = new Float64Array(STATS_WINDOW)
  readonly #lateness = new Float64Array(STATS_WINDOW)
  readonly #slots = new Map<string, Slot>()
  readonly world: World
  readonly drone: Ship
  tick = 0

  constructor(arenaInfo: RoomInfo['arena']) {
    const { width, height, seed, asteroids } = arenaInfo
    this.world = new World(createArena(width, height), seed, { asteroids })
    // мішень без пілота, як у локальному режимі
    this.drone = this.world.spawn(new Ship({ x: width * 0.8, y: height * 0.3, name: 'drone' }))
    for (let i = 0; i < Math.min(5, asteroids); i++) this.world.spawnAsteroid()
  }

  get playerCount(): number {
    return this.#slots.size
  }

  addPlayer(player: Player): Ship {
    const p = this.world.safeSpot()
    const ship = this.world.spawn(new Ship({ x: p.x, y: p.y, name: player.name }))
    ship.shield = 1.5
    this.#slots.set(player.id, { player, ship, queue: [], credits: 1, ack: asSeq(0) })
    return ship
  }

  removePlayer(playerId: string): void {
    const slot = this.#slots.get(playerId)
    if (!slot) return
    this.world.despawn(slot.ship.id)
    this.#slots.delete(playerId)
  }

  pushInput(playerId: string, input: InputMessage): void {
    const slot = this.#slots.get(playerId)
    if (!slot || input.seq <= slot.ack) return // застарілий або дубль (розкид затримки міняє порядок)
    const q = slot.queue
    if (q.some((i) => i.seq === input.seq)) return
    let i = q.length
    while (i > 0 && (q[i - 1]?.seq ?? 0) > input.seq) i--
    q.splice(i, 0, input) // черга завжди впорядкована за seq
    if (q.length > MAX_QUEUE) q.shift()
  }

  start(): void {
    this.#next = performance.now()
    this.#schedule()
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  // Не setInterval: кожен тік ставиться на АБСОЛЮТНИЙ цільовий час start + n·33.3 мс.
  #schedule(): void {
    this.#next += TICK_MS
    this.#timer = setTimeout(() => this.#tick(), Math.max(0, this.#next - performance.now()))
  }

  #tick(): void {
    const start = performance.now()
    const late = start - this.#next
    this.tick += 1

    for (const slot of this.#slots.values()) {
      slot.credits = Math.min(MAX_CREDITS, slot.credits + 1)
      let input = slot.queue[0]
      while (slot.credits >= 1 && input) {
        slot.queue.shift()
        slot.credits -= 1
        for (let s = 0; s < SUBSTEPS; s++) this.world.applyInput(slot.ship, input, STEP) // input підходить як Command структурно
        slot.ack = input.seq
        input = slot.queue[0]
      }
    }
    for (let s = 0; s < SUBSTEPS; s++) {
      this.world.applyInput(this.drone, DRONE_COMMAND, STEP)
      this.world.stepOthers(STEP)
    }

    const base = buildSnapshot(this.world, asTick(this.tick), asSeq(0))
    for (const slot of this.#slots.values()) slot.player.sendSnapshot({ ...base, ack: slot.ack })

    const i = this.tick % STATS_WINDOW
    this.#durations[i] = performance.now() - start
    this.#lateness[i] = late
    // сервер відстав більш ніж на 5 тіків (CPU зайнятий) — не «надолужуємо» пачкою, а йдемо від «зараз»
    if (performance.now() - this.#next > TICK_MS * 5) this.#next = performance.now()
    this.#schedule()
  }

  stats(): MatchStats {
    const n = Math.min(this.tick, STATS_WINDOW)
    const pct = (arr: Float64Array, p: number): number => {
      const xs = Array.from(arr.subarray(0, n)).sort((a, b) => a - b)
      const v = xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]
      return v === undefined ? 0 : Number(v.toFixed(3))
    }
    return {
      tickRate: TICK_RATE,
      tick: this.tick,
      players: this.#slots.size,
      entities: this.world.size,
      tickMs: { p50: pct(this.#durations, 0.5), p99: pct(this.#durations, 0.99) },
      lateMs: { p50: pct(this.#lateness, 0.5), p99: pct(this.#lateness, 0.99) },
    }
  }
}
