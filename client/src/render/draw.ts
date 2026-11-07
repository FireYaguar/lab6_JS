import { type Arena, lerpWrapped } from 'shared/sim/arena.ts'
import type { Particle } from 'shared/sim/entity.ts'
import { mulberry32 } from 'shared/sim/random.ts'
import { assertNever, type Effect } from 'shared/sim/types.ts'
import type { AnyEntity, World } from 'shared/sim/world.ts'
import type { Sprites } from '../assets/loader.ts'
import type { Stats } from '../loop.ts'
import type { View } from './canvas.ts'

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// Кут коротким шляхом по колу: між 359° і 1° — 2°, а не 358° навпаки.
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

// Що малювати — розрізнюване об’єднання за kind. Позиції вже інтерпольовані тим, хто його зібрав
// (локальний світ — drawWorld; мережа — net/netgame.ts). До TS тут був «src: сутність АБО запис знімка»
// і вгадування полів (src.effect ?? src.pickup.effect) — тепер кожне джерело явно перетворюється в RenderItem.
export interface ShipLook {
  readonly solid: boolean
  readonly thrust: boolean
  readonly shield: number
  readonly hp: number
}
export type RenderItem =
  | { kind: 'ship'; x: number; y: number; angle: number; mine: boolean; look: ShipLook }
  | {
      kind: 'asteroid'
      x: number
      y: number
      angle: number
      radius: number
      shape: number
      homing: boolean
    }
  | { kind: 'bullet'; x: number; y: number; homing: boolean }
  | { kind: 'pickup'; x: number; y: number; effect: Effect }
  | { kind: 'explosion'; particles: readonly Particle[]; ttl: number }

interface Star {
  x: number
  y: number
  r: number
  a: number
}
let stars: Star[] | null = null
function getStars(arena: Arena): Star[] {
  if (stars) return stars
  const rnd = mulberry32(42)
  stars = Array.from({ length: 220 }, () => ({
    x: rnd() * arena.width,
    y: rnd() * arena.height,
    r: rnd() * 1.4 + 0.3,
    a: rnd() * 0.6 + 0.3,
  }))
  return stars
}

// Масштаб «світ → екран»: арена вписується у вікно, по центру.
export function fitArena(
  view: View,
  arena: Arena,
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(view.width / arena.width, view.height / arena.height)
  return {
    scale,
    offsetX: (view.width - arena.width * scale) / 2,
    offsetY: (view.height - arena.height * scale) / 2,
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, arena: Arena): void {
  ctx.fillStyle = '#0a0d1a'
  ctx.fillRect(0, 0, arena.width, arena.height)

  ctx.strokeStyle = 'rgba(90, 120, 200, 0.12)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 0; x <= arena.width; x += 100) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x, arena.height)
  }
  for (let y = 0; y <= arena.height; y += 100) {
    ctx.moveTo(0, y)
    ctx.lineTo(arena.width, y)
  }
  ctx.stroke()

  for (const s of getStars(arena)) {
    ctx.globalAlpha = s.a
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  ctx.strokeStyle = 'rgba(120, 160, 255, 0.5)'
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, arena.width, arena.height)
}

// Спрайт з атласу: кадр центрується в (x, y), повертається на angle; k — додатковий масштаб.
// atlas.scale — світових одиниць на піксель спрайта (спрайти намальовані 2×, для retina).
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprites: Sprites,
  name: string,
  x: number,
  y: number,
  angle = 0,
  k = 1,
): void {
  const f = sprites.atlas.frames[name]
  if (!f) return // noUncheckedIndexedAccess: кадру може не бути в атласі — не малюємо, а не падаємо
  const w = f.w * sprites.atlas.scale * k
  const h = f.h * sprites.atlas.scale * k
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.drawImage(sprites.image, f.x, f.y, f.w, f.h, -w / 2, -h / 2, w, h)
  ctx.restore()
}

const SHIP_RADIUS = 14

function drawShip(
  ctx: CanvasRenderingContext2D,
  sprites: Sprites,
  x: number,
  y: number,
  angle: number,
  ship: ShipLook,
  frame: string,
): void {
  if (ship.thrust) {
    const flicker = 10 + Math.random() * 8 // косметика рендеру, у симуляцію не потрапляє
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.fillStyle = '#ffb347'
    ctx.beginPath()
    ctx.moveTo(-10, -5)
    ctx.lineTo(-10 - flicker, 0)
    ctx.lineTo(-10, 5)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  drawSprite(ctx, sprites, frame, x, y, angle)
  if (ship.shield > 0) {
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.8)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x, y, SHIP_RADIUS + 8, 0, Math.PI * 2)
    ctx.stroke()
  }
  // смужка hp над кораблем
  ctx.fillStyle = 'rgba(255,255,255,0.15)'
  ctx.fillRect(x - 18, y - 30, 36, 4)
  ctx.fillStyle = ship.hp > 30 ? '#6f6' : '#f55'
  ctx.fillRect(x - 18, y - 30, (36 * ship.hp) / 100, 4)
}

function drawAsteroid(
  ctx: CanvasRenderingContext2D,
  sprites: Sprites,
  a: Extract<RenderItem, { kind: 'asteroid' }>,
): void {
  const k = a.radius / (sprites.atlas.asteroidRadiusPx * sprites.atlas.scale)
  drawSprite(ctx, sprites, `asteroid_${a.shape}`, a.x, a.y, a.angle, k)
  if (a.homing) {
    // «мисливець» з homing — червоне кільце
    ctx.strokeStyle = 'rgba(255, 107, 107, 0.8)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(a.x, a.y, a.radius + 4, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawExplosion(
  ctx: CanvasRenderingContext2D,
  particles: readonly Particle[],
  ttl: number,
): void {
  ctx.globalAlpha = Math.max(0, ttl / 0.8)
  ctx.fillStyle = '#ffae42'
  for (const p of particles) ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3)
  ctx.globalAlpha = 1
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  view: View,
  arena: Arena,
  items: readonly RenderItem[],
  sprites: Sprites,
  time: number,
): void {
  ctx.fillStyle = '#05060c'
  ctx.fillRect(0, 0, view.width, view.height)

  const { scale, offsetX, offsetY } = fitArena(view, arena)
  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)
  ctx.beginPath()
  ctx.rect(0, 0, arena.width, arena.height)
  ctx.clip()
  drawBackground(ctx, arena)

  for (const item of items) {
    switch (item.kind) {
      case 'ship':
        if (item.look.solid)
          drawShip(
            ctx,
            sprites,
            item.x,
            item.y,
            item.angle,
            item.look,
            item.mine ? 'ship_player' : 'ship_enemy',
          )
        break
      case 'asteroid':
        drawAsteroid(ctx, sprites, item)
        break
      case 'bullet':
        drawSprite(ctx, sprites, item.homing ? 'bullet_homing' : 'bullet', item.x, item.y)
        break
      case 'pickup':
        drawSprite(
          ctx,
          sprites,
          `pickup_${item.effect}`,
          item.x,
          item.y,
          0,
          1 + Math.sin(time * 6) * 0.1,
        )
        break
      case 'explosion':
        drawExplosion(ctx, item.particles, item.ttl)
        break
      default:
        assertNever(item) // новий kind без малювання → помилка tsc
    }
  }
  ctx.restore()
}

// Сутність локального світу → RenderItem (позиція й кут уже інтерпольовані).
export function entityItem(
  e: AnyEntity,
  x: number,
  y: number,
  angle: number,
  mine: boolean,
): RenderItem {
  switch (e.kind) {
    case 'ship':
      return { kind: 'ship', x, y, angle, mine, look: e }
    case 'asteroid':
      return {
        kind: 'asteroid',
        x,
        y,
        angle,
        radius: e.radius,
        shape: e.shapeSeed % 3,
        homing: e.homing !== null,
      }
    case 'bullet':
      return { kind: 'bullet', x, y, homing: e.homing !== null }
    case 'pickup':
      return { kind: 'pickup', x, y, effect: e.pickup.effect }
    case 'explosion':
      return { kind: 'explosion', particles: e.particles, ttl: e.ttl }
    default:
      return assertNever(e)
  }
}

// Локальний режим (Lab 1–3): інтерполяція між попереднім і поточним кроком симуляції.
export function drawWorld(
  ctx: CanvasRenderingContext2D,
  view: View,
  world: World,
  alpha: number,
  playerId: AnyEntity['id'],
  sprites: Sprites,
): void {
  const { arena } = world
  const items: RenderItem[] = []
  for (const e of world) {
    const x = lerpWrapped(e.prevX, e.pos.x, alpha, arena.width)
    const y = lerpWrapped(e.prevY, e.pos.y, alpha, arena.height)
    items.push(entityItem(e, x, y, lerpAngle(e.prevAngle, e.angle, alpha), e.id === playerId))
  }
  drawScene(ctx, view, arena, items, sprites, world.time)
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  stats: Stats,
  extra: readonly string[] = [],
): void {
  const lines = [
    `steps/s  ${stats.stepsPerSec.toFixed(1)}`,
    `frames/s ${stats.framesPerSec.toFixed(1)}`,
    `frame ms ${stats.frameMs.toFixed(2)}  (js ${stats.workMs.toFixed(2)})`,
    ...extra,
  ]
  ctx.font = '13px ui-monospace, Menlo, Consolas, monospace'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(8, 8, 270, lines.length * 18 + 10)
  ctx.fillStyle = '#9fffb0'
  lines.forEach((line, i) => {
    ctx.fillText(line, 14, 14 + i * 18)
  })
}
