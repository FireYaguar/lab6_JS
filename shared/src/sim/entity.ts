import { asEntityId, asSeq, type EntityId, type Seq } from '../brand.ts'
import { dcos, dsin } from './dmath.ts'
import { type Rng, range } from './random.ts'
import type { Effect, EntityKind } from './types.ts'
import { Vector2 } from './vector.ts'

// Компоненти (композиція з Lab 2) — звичайні дані.
export interface Homing {
  readonly targets: readonly EntityKind[]
  readonly turnRate: number
  readonly range: number
}
export interface PickupData {
  readonly effect: Effect
}

export interface EntityOptions<K extends EntityKind> {
  kind: K
  x?: number
  y?: number
  vx?: number
  vy?: number
  angle?: number
  radius?: number
  ttl?: number
}

// Базова сутність, узагальнена за kind: Entity<'bullet'> має kind типу 'bullet', а не просто string.
// Це робить AnyEntity (нижче) розрізнюваним об’єднанням: switch (e.kind) звужує тип.
export class Entity<K extends EntityKind = EntityKind> {
  static #nextId = 1
  readonly #id: EntityId = asEntityId(Entity.#nextId++)

  readonly kind: K
  pos: Vector2
  vel: Vector2
  angle: number
  radius: number
  ttl: number // секунд до самознищення; Infinity — живе вічно
  alive = true // false → World прибере наприкінці кроку
  solid = true // бере участь у колізіях
  wraps = true // загортається по краях арени
  homing: Homing | null = null
  pickup: PickupData | null = null
  prevX: number
  prevY: number
  prevAngle: number

  constructor({
    kind,
    x = 0,
    y = 0,
    vx = 0,
    vy = 0,
    angle = 0,
    radius = 10,
    ttl = Infinity,
  }: EntityOptions<K>) {
    this.kind = kind
    this.pos = new Vector2(x, y)
    this.vel = new Vector2(vx, vy)
    this.angle = angle
    this.radius = radius
    this.ttl = ttl
    this.prevX = x
    this.prevY = y
    this.prevAngle = angle
  }

  get id(): EntityId {
    return this.#id
  }

  savePrev(): void {
    this.prevX = this.pos.x
    this.prevY = this.pos.y
    this.prevAngle = this.angle
  }

  update(dt: number): void {
    this.pos = this.pos.addScaled(this.vel, dt)
    if (this.ttl !== Infinity) {
      this.ttl -= dt
      if (this.ttl <= 0) this.alive = false
    }
  }
}

export class Bullet extends Entity<'bullet'> {
  static readonly SPEED = 620
  static readonly DAMAGE = 25
  readonly ownerId: EntityId
  readonly damage = Bullet.DAMAGE
  seq: Seq = asSeq(0) // seq input-у, яким випущено (клієнт зіставляє зі своєю передбаченою кулею)

  constructor({
    x,
    y,
    vx,
    vy,
    ownerId,
  }: { x: number; y: number; vx: number; vy: number; ownerId: EntityId }) {
    super({ kind: 'bullet', x, y, vx, vy, radius: 3, ttl: 1.1 })
    this.ownerId = ownerId
  }
}

export class Asteroid extends Entity<'asteroid'> {
  readonly spin: number
  readonly shapeSeed: number // форма «каменя» для рендеру

  constructor({ x, y, rng }: { x: number; y: number; rng: Rng }) {
    const speed = range(rng, 20, 70)
    const dir = range(rng, 0, Math.PI * 2)
    super({
      kind: 'asteroid',
      x,
      y,
      vx: dcos(dir) * speed,
      vy: dsin(dir) * speed,
      angle: dir,
      radius: range(rng, 20, 38),
    })
    this.spin = range(rng, -1, 1)
    this.shapeSeed = Math.floor(rng() * 1e9)
  }

  override update(dt: number): void {
    super.update(dt)
    this.angle += this.spin * dt
  }
}

export interface Particle {
  x: number
  y: number
  readonly vx: number
  readonly vy: number
}

// Вибух: багато короткоживучих частинок (саме вони стануть «гарячою точкою» GC у Lab 7).
export class Explosion extends Entity<'explosion'> {
  readonly particles: Particle[]

  constructor({ x, y, rng, count = 18 }: { x: number; y: number; rng: Rng; count?: number }) {
    super({ kind: 'explosion', x, y, ttl: 0.8 })
    this.solid = false
    this.wraps = false
    this.particles = Array.from({ length: count }, () => {
      const a = range(rng, 0, Math.PI * 2)
      const s = range(rng, 40, 220)
      return { x, y, vx: dcos(a) * s, vy: dsin(a) * s }
    })
  }

  override update(dt: number): void {
    super.update(dt)
    for (const p of this.particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
  }
}

// Pickup — не клас (композиція, Lab 2): звичайний Entity<'pickup'>, у якого компонент pickup точно є.
export type PickupEntity = Entity<'pickup'> & { pickup: PickupData }
