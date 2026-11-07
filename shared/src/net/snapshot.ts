import type { Seq, Tick } from '../brand.ts'
import { assertNever, type Effect, type EntityKind } from '../sim/types.ts'
import type { AnyEntity, World } from '../sim/world.ts'
import type { EntityState, Snapshot } from './protocol.ts'

// Знімок світу як звичайні дані (без класів) — його кодують обидва кодеки, JSON і бінарний.

export const KIND_CODES: Record<EntityKind, number> = {
  ship: 1,
  bullet: 2,
  asteroid: 3,
  pickup: 4,
  explosion: 5,
}
export const KIND_BY_CODE: readonly (EntityKind | undefined)[] = [
  undefined,
  'ship',
  'bullet',
  'asteroid',
  'pickup',
  'explosion',
]
export const EFFECT_CODES: Record<Effect, number> = { shield: 0, rapid: 1, homing: 2 }
export const EFFECT_BY_CODE: readonly (Effect | undefined)[] = ['shield', 'rapid', 'homing']

export function entityState(e: AnyEntity): EntityState {
  const { id } = e
  const x = e.pos.x
  const y = e.pos.y
  switch (e.kind) {
    case 'ship':
      return {
        id,
        x,
        y,
        kind: 'ship',
        angle: e.angle,
        vx: e.vel.x,
        vy: e.vel.y,
        hp: e.hp,
        solid: e.solid,
        thrust: e.thrust,
        cooldown: e.cooldown,
        shield: e.shield,
        rapid: e.rapid,
        homingShots: e.homingShots,
        respawnIn: e.respawnIn,
        score: e.score,
      }
    case 'bullet':
      return { id, x, y, kind: 'bullet', homing: e.homing !== null, ownerId: e.ownerId, seq: e.seq }
    case 'asteroid':
      return {
        id,
        x,
        y,
        kind: 'asteroid',
        angle: e.angle,
        radius: e.radius,
        shape: e.shapeSeed % 3,
        homing: e.homing !== null,
      }
    case 'pickup':
      return { id, x, y, kind: 'pickup', effect: e.pickup.effect }
    case 'explosion':
      return { id, x, y, kind: 'explosion' } // частинки клієнт малює сам
    default:
      return assertNever(e) // новий kind без кодування → помилка tsc
  }
}

// tick — номер тіку сервера; ack — останній оброблений seq input-у ЦЬОГО клієнта.
export function buildSnapshot(world: World, tick: Tick, ack: Seq): Snapshot {
  const entities: EntityState[] = []
  for (const e of world) entities.push(entityState(e))
  return { type: 'snapshot', tick, ack, entities }
}
