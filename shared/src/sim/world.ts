import { asSeq, type EntityId } from '../brand.ts'
import { Bus } from '../bus.ts'
import { type Arena, wrap } from './arena.ts'
import { findCollisions, resolveCollisions } from './collision.ts'
import { createPickup, homing, PICKUP_EFFECTS, steerHoming } from './components.ts'
import { dlength } from './dmath.ts'
import { Asteroid, type Bullet, Explosion, type PickupEntity } from './entity.ts'
import { mulberry32, pick, type Rng, range } from './random.ts'
import type { Ship } from './ship.ts'
import type { Command, Effect, EntityKind } from './types.ts'

// Будь-яка сутність світу — розрізнюване об’єднання за kind.
export type AnyEntity = Ship | Bullet | Asteroid | Explosion | PickupEntity
export type EntityOfKind<K extends EntityKind> = Extract<AnyEntity, { kind: K }>

export function isKind<K extends EntityKind>(e: AnyEntity, kind: K): e is EntityOfKind<K> {
  return e.kind === kind
}

// Події світу: ім’я → форма payload. Звук, HUD і мережа підписуються ззовні, симуляція їх не імпортує.
export type WorldEvents = {
  fired: { shipId: EntityId; x: number; y: number }
  hit: { targetId: EntityId; sourceId: EntityId; damage: number; blocked: boolean }
  exploded: { x: number; y: number; kind?: 'ship' | 'asteroid' }
  scored: { shipId: EntityId; points: number; total: number }
  picked: { shipId: EntityId; effect: Effect }
}

const IDLE: Command = { thrust: false, turn: 0, fire: false }
const HOMING_ASTEROID_EVERY = 4 // кожен 4-й астероїд — «мисливець»

// Один крок корабля: керування → (постріл) → рух → загортання. Однаково виконується на сервері
// (applyInput) і на клієнті (передбачення та повторне програвання input). Повертає нову кулю або null.
export function stepShip(ship: Ship, command: Command, dt: number, arena: Arena): Bullet | null {
  ship.control(command, dt)
  const bullet = command.fire ? ship.fire() : null
  if (bullet) bullet.seq = command.seq ?? asSeq(0)
  ship.update(dt)
  if (ship.solid) ship.pos = wrap(ship.pos, arena)
  return bullet
}

// Менеджер сутностей: Map<id, сутність>, крок симуляції, прибирання мертвих.
export class World {
  readonly #entities = new Map<EntityId, AnyEntity>()
  readonly #spawnQueue: AnyEntity[] = [] // спавн під час кроку — після нього, щоб не змінювати Map посеред обходу
  #stepping = false
  #asteroidTimer = 0
  #pickupTimer = 3
  #asteroidsSpawned = 0
  readonly arena: Arena
  readonly rng: Rng
  readonly asteroidCount: number
  readonly events = new Bus<WorldEvents>()
  time = 0

  constructor(arena: Arena, seed = 1, { asteroids = 6 }: { asteroids?: number } = {}) {
    this.arena = arena
    this.rng = mulberry32(seed)
    this.asteroidCount = asteroids
  }

  emit<K extends keyof WorldEvents>(type: K, detail: WorldEvents[K]): void {
    this.events.emit(type, detail)
  }

  get size(): number {
    return this.#entities.size
  }

  spawn<T extends AnyEntity>(entity: T): T {
    if (this.#stepping) this.#spawnQueue.push(entity)
    else this.#entities.set(entity.id, entity)
    return entity
  }

  // Відкладене видалення: лише позначка, фізично прибирає #sweep() наприкінці кроку.
  despawn(id: EntityId): void {
    const e = this.#entities.get(id)
    if (e) e.alive = false
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id)
  }

  *[Symbol.iterator](): Generator<AnyEntity> {
    yield* this.#entities.values()
  }

  *ofKind<K extends EntityKind>(kind: K): Generator<EntityOfKind<K>> {
    for (const e of this) if (isKind(e, kind)) yield e
  }

  explode(x: number, y: number, kind: 'ship' | 'asteroid'): void {
    this.spawn(new Explosion({ x, y, rng: this.rng }))
    this.emit('exploded', { x, y, kind })
  }

  // Локальний режим (Lab 1–3): усі кораблі й увесь світ за один крок.
  step(dt: number, commands: ReadonlyMap<EntityId, Command> = new Map()): void {
    this.#stepping = true
    for (const e of this) e.savePrev()
    for (const ship of this.ofKind('ship')) this.applyInput(ship, commands.get(ship.id) ?? IDLE, dt)
    this.stepOthers(dt)
  }

  // Сервер (Lab 5): один input одного корабля. Кораблі рухаються лише тоді, коли сервер обробив їхній input.
  applyInput(ship: Ship, command: Command, dt: number): void {
    const bullet = stepShip(ship, command, dt, this.arena)
    if (bullet) {
      this.spawn(bullet)
      this.emit('fired', { shipId: ship.id, x: bullet.pos.x, y: bullet.pos.y })
    }
  }

  // Усе, крім керування кораблями: homing, рух решти сутностей, колізії, респаун, прибирання.
  stepOthers(dt: number): void {
    this.#stepping = true
    this.time += dt
    steerHoming(this, dt)
    for (const e of this) {
      if (e.kind === 'ship') continue // кораблі рухає applyInput / stepShip
      e.update(dt)
      if (e.wraps) e.pos = wrap(e.pos, this.arena)
    }
    resolveCollisions(this, findCollisions(this))
    this.#maintain(dt)
    this.#sweep()

    this.#stepping = false
    for (const e of this.#spawnQueue) this.#entities.set(e.id, e)
    this.#spawnQueue.length = 0
  }

  #sweep(): void {
    for (const [id, e] of this.#entities) if (!e.alive) this.#entities.delete(id)
  }

  // Респаун кораблів через 2 с, підтримка кількості астероїдів і pickup.
  #maintain(dt: number): void {
    for (const ship of this.ofKind('ship')) {
      if (ship.solid) continue
      ship.respawnIn -= dt
      if (ship.respawnIn <= 0) {
        const p = this.safeSpot()
        ship.respawn(p.x, p.y)
      }
    }

    this.#asteroidTimer -= dt
    if (this.#asteroidTimer <= 0 && this.#count('asteroid') < this.asteroidCount) {
      this.spawnAsteroid()
      this.#asteroidTimer = 1.5
    }

    this.#pickupTimer -= dt
    if (this.#pickupTimer <= 0 && this.#count('pickup') === 0) {
      const p = this.safeSpot()
      this.spawn(createPickup({ x: p.x, y: p.y, effect: pick(this.rng, PICKUP_EFFECTS) }))
      this.#pickupTimer = 6
    }
  }

  spawnAsteroid(): Asteroid {
    const p = this.safeSpot()
    const asteroid = this.spawn(new Asteroid({ x: p.x, y: p.y, rng: this.rng }))
    this.#asteroidsSpawned += 1
    if (this.#asteroidsSpawned % HOMING_ASTEROID_EVERY === 0) {
      asteroid.homing = homing({ targets: ['ship'], turnRate: 0.7, range: 450 })
    }
    return asteroid
  }

  #count(kind: EntityKind): number {
    let n = 0
    for (const _ of this.ofKind(kind)) n += 1
    return n
  }

  // Випадкова точка, далека від кораблів і астероїдів (до 30 спроб).
  safeSpot(minDist = 180): { x: number; y: number } {
    let x = 0
    let y = 0
    for (let tries = 0; tries < 30; tries++) {
      x = range(this.rng, 0, this.arena.width)
      y = range(this.rng, 0, this.arena.height)
      let ok = true
      for (const e of this) {
        if (!e.solid || (e.kind !== 'ship' && e.kind !== 'asteroid')) continue
        if (dlength(e.pos.x - x, e.pos.y - y) < minDist + e.radius) {
          ok = false
          break
        }
      }
      if (ok) break
    }
    return { x, y }
  }
}
