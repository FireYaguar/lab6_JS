import type { EntityId } from '../brand.ts'
import { applyPickup } from './components.ts'
import type { Ship } from './ship.ts'
import type { AnyEntity, World } from './world.ts'

// Система колізій окремо від World: спочатку знаходимо пари, потім застосовуємо правила.
// Наївний O(n²) — свідомо; у Lab 7 findCollisions заміниться на spatial hash без змін у правилах.

export function* findCollisions(world: World): Generator<[AnyEntity, AnyEntity]> {
  const list: AnyEntity[] = []
  for (const e of world) if (e.solid && e.alive) list.push(e)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      if (!a || !b) continue // noUncheckedIndexedAccess: індекс завжди в межах, але компілятор цього не знає
      const dx = a.pos.x - b.pos.x
      const dy = a.pos.y - b.pos.y
      const r = a.radius + b.radius
      if (dx * dx + dy * dy <= r * r) yield [a, b]
    }
  }
}

const SCORE = { asteroid: 10, ship: 100 }
const RAM_DAMAGE = 30

function credit(world: World, ownerId: EntityId, points: number): void {
  const owner = world.get(ownerId)
  // TS: world.get повертає будь-яку сутність, а score є лише в корабля
  if (owner?.kind !== 'ship') return
  owner.score += points
  world.emit('scored', { shipId: ownerId, points, total: owner.score })
}

function damage(world: World, ship: Ship, amount: number, sourceId: EntityId): boolean {
  const killed = ship.takeDamage(amount)
  world.emit('hit', { targetId: ship.id, sourceId, damage: amount, blocked: ship.shield > 0 })
  if (killed) world.explode(ship.pos.x, ship.pos.y, 'ship')
  return killed
}

// Пари впорядковано за kind (asteroid < bullet < pickup < ship), тож кожну комбінацію перевіряємо в одному порядку.
// Перевірки a.kind / b.kind звужують типи: всередині if a — Asteroid, b — Bullet тощо.
export function resolveCollisions(world: World, pairs: Iterable<[AnyEntity, AnyEntity]>): void {
  for (const [p, q] of pairs) {
    const [a, b] = p.kind <= q.kind ? [p, q] : [q, p]
    if (!a.alive || !b.alive || !a.solid || !b.solid) continue // уже знищено в цьому кроці

    if (a.kind === 'asteroid' && b.kind === 'bullet') {
      a.alive = false
      b.alive = false
      world.explode(a.pos.x, a.pos.y, 'asteroid')
      credit(world, b.ownerId, SCORE.asteroid)
    } else if (a.kind === 'bullet' && b.kind === 'ship') {
      if (a.ownerId === b.id) continue // своя куля не б’є
      a.alive = false
      if (damage(world, b, a.damage, a.ownerId)) credit(world, a.ownerId, SCORE.ship)
    } else if (a.kind === 'asteroid' && b.kind === 'ship') {
      a.alive = false
      world.explode(a.pos.x, a.pos.y, 'asteroid')
      damage(world, b, RAM_DAMAGE, a.id)
    } else if (a.kind === 'pickup' && b.kind === 'ship') {
      a.alive = false
      applyPickup(b, a.pickup.effect)
      world.emit('picked', { shipId: b.id, effect: a.pickup.effect })
    }
    // інші пари (asteroid:asteroid, bullet:bullet, bullet:pickup…) — ігноруємо
  }
}
