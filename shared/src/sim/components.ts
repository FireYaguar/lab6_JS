import { datan2, dcos, dsin } from './dmath.ts'
import { Entity, type Homing, type PickupEntity } from './entity.ts'
import type { Ship } from './ship.ts'
import { assertNever, type Effect, type EntityKind } from './types.ts'
import type { AnyEntity, World } from './world.ts'

// Композиція: поведінка — шматок даних у полі сутності + система, що його обробляє.
// homing чіпляється і до Bullet, і до Asteroid; pickup — до звичайного Entity. Жодного нового extends.

// ---------- homing ----------
export function homing({
  targets,
  turnRate,
  range,
}: {
  targets: readonly EntityKind[]
  turnRate: number
  range: number
}): Homing {
  return { targets, turnRate, range }
}

function nearestTarget(world: World, e: AnyEntity, h: Homing): AnyEntity | null {
  // TS: ownerId є лише в кулі; у JS для астероїда тут порівнювалося з undefined
  const ownerId = e.kind === 'bullet' ? e.ownerId : null
  let best: AnyEntity | null = null
  let bestDist = h.range
  for (const kind of h.targets) {
    for (const t of world.ofKind(kind)) {
      if (t === e || !t.solid || t.id === ownerId) continue
      const d = t.pos.sub(e.pos).length()
      if (d < bestDist) {
        best = t
        bestDist = d
      }
    }
  }
  return best
}

// Система: повертає швидкість кожної «самонавідної» сутності до найближчої цілі,
// не більше ніж на turnRate рад/с. Модуль швидкості не змінюється.
export function steerHoming(world: World, dt: number): void {
  for (const e of world) {
    const h = e.homing
    if (!h || !e.alive) continue
    const target = nearestTarget(world, e, h)
    if (!target) continue
    const want = target.pos.sub(e.pos).angle()
    let diff = want - e.vel.angle()
    diff = datan2(dsin(diff), dcos(diff)) // у межах (−π, π]
    const maxTurn = h.turnRate * dt
    e.vel = e.vel.rotate(Math.max(-maxTurn, Math.min(maxTurn, diff)))
  }
}

// ---------- pickup ----------
export const PICKUP_EFFECTS: readonly Effect[] = ['shield', 'rapid', 'homing']
const EFFECT_SECONDS: Record<Effect, number> = { shield: 5, rapid: 6, homing: 8 }

// Pickup — не клас і не корабель: звичайна нерухома сутність із компонентом pickup.
export function createPickup({
  x,
  y,
  effect,
}: {
  x: number
  y: number
  effect: Effect
}): PickupEntity {
  // поле pickup уже є (null) з конструктора — Object.assign перезаписує, «форма» об’єкта не змінюється
  return Object.assign(new Entity({ kind: 'pickup', x, y, radius: 12, ttl: 12 }), {
    pickup: { effect },
  })
}

export function applyPickup(ship: Ship, effect: Effect): void {
  const seconds = EFFECT_SECONDS[effect]
  switch (effect) {
    case 'shield':
      ship.shield = seconds
      return
    case 'rapid':
      ship.rapid = seconds
      return
    case 'homing':
      ship.homingShots = seconds
      return
    default:
      assertNever(effect) // новий ефект без обробника → помилка tsc
  }
}
