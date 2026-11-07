import { homing } from './components.ts'
import { dcos, dsin } from './dmath.ts'
import { Bullet, Entity } from './entity.ts'
import type { Command } from './types.ts'
import { Vector2 } from './vector.ts'

// Корабель — Ship extends Entity<'ship'> (рівно один рівень наслідування).

export const SHIP = {
  turnRate: 3.6, // рад/с
  thrust: 320, // px/с²
  drag: 0.55, // частка швидкості, що губиться за секунду
  maxSpeed: 420, // px/с
  radius: 14,
  maxHp: 100,
  cooldown: 0.25, // с між пострілами
  rapidCooldown: 0.08,
  respawnDelay: 2,
} satisfies Record<string, number>

// Що звірка бере зі знімка сервера. ShipState протоколу підходить сюди структурно.
export interface ShipSync {
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly angle: number
  readonly hp: number
  readonly solid: boolean
  readonly thrust: boolean
  readonly cooldown: number
  readonly shield: number
  readonly rapid: number
  readonly homingShots: number
  readonly respawnIn: number
  readonly score: number
}

export class Ship extends Entity<'ship'> {
  #hp = SHIP.maxHp
  name: string
  thrust = false
  score = 0
  cooldown = 0
  respawnIn = 0 // > 0 — корабель знищено, чекає респауну
  shield = 0 // таймери ефектів від pickup (секунди)
  rapid = 0
  homingShots = 0

  constructor({
    x = 0,
    y = 0,
    angle = -Math.PI / 2,
    name = 'ship',
  }: { x?: number; y?: number; angle?: number; name?: string } = {}) {
    super({ kind: 'ship', x, y, angle, radius: SHIP.radius })
    this.name = name
  }

  get hp(): number {
    return this.#hp
  }

  control(command: Command, dt: number): void {
    if (!this.solid) return
    this.angle += command.turn * SHIP.turnRate * dt
    // кут завжди в (−π, π]: однаково на обох сторонах і влазить у Int16 протоколу
    if (this.angle > Math.PI) this.angle -= Math.PI * 2
    else if (this.angle <= -Math.PI) this.angle += Math.PI * 2
    this.thrust = command.thrust
    if (command.thrust) {
      this.vel = new Vector2(
        this.vel.x + dcos(this.angle) * SHIP.thrust * dt,
        this.vel.y + dsin(this.angle) * SHIP.thrust * dt,
      )
    }
    this.vel = this.vel.scale(1 - SHIP.drag * dt)
    const speed = this.vel.length()
    if (speed > SHIP.maxSpeed) this.vel = this.vel.scale(SHIP.maxSpeed / speed)
  }

  // Повертає нову кулю або null (кулдаун / корабель знищено). Спавнить її World.
  // this: Ship — явний параметр this (стирається під час збірки). Без нього TS НЕ помітить баг з Lab 2:
  // addEventListener('keydown', ship.fire) компілювався б, а this у рантаймі був би window.
  fire(this: Ship): Bullet | null {
    if (!this.solid || this.cooldown > 0) return null
    this.cooldown = this.rapid > 0 ? SHIP.rapidCooldown : SHIP.cooldown
    const dirX = dcos(this.angle)
    const dirY = dsin(this.angle)
    const bullet = new Bullet({
      x: this.pos.x + dirX * (this.radius + 4), // з носа
      y: this.pos.y + dirY * (this.radius + 4),
      vx: this.vel.x + dirX * Bullet.SPEED, // успадкована швидкість корабля
      vy: this.vel.y + dirY * Bullet.SPEED,
      ownerId: this.id,
    })
    if (this.homingShots > 0)
      bullet.homing = homing({ targets: ['asteroid', 'ship'], turnRate: 4, range: 380 })
    return bullet
  }

  // true — корабель знищено цим ударом
  takeDamage(amount: number): boolean {
    if (!this.solid || this.shield > 0) return false
    this.#hp = Math.max(0, this.#hp - amount)
    if (this.#hp > 0) return false
    this.solid = false
    this.thrust = false
    this.respawnIn = SHIP.respawnDelay
    return true
  }

  respawn(x: number, y: number): void {
    this.#hp = SHIP.maxHp
    this.solid = true
    this.respawnIn = 0
    this.pos = new Vector2(x, y)
    this.vel = new Vector2()
    this.angle = -Math.PI / 2
    this.shield = 1.5 // коротка невразливість після появи
    this.savePrev() // не інтерполювати з місця загибелі
  }

  // Звірка (Lab 5): поставити корабель точно в стан зі знімка сервера.
  syncFrom(s: ShipSync): void {
    this.pos = new Vector2(s.x, s.y)
    this.vel = new Vector2(s.vx, s.vy)
    this.angle = s.angle
    this.#hp = s.hp
    this.solid = s.solid
    this.thrust = s.thrust
    this.cooldown = s.cooldown
    this.shield = s.shield
    this.rapid = s.rapid
    this.homingShots = s.homingShots
    this.respawnIn = s.respawnIn
    this.score = s.score
  }

  override update(dt: number): void {
    if (!this.solid) return
    super.update(dt)
    this.cooldown = Math.max(0, this.cooldown - dt)
    this.shield = Math.max(0, this.shield - dt)
    this.rapid = Math.max(0, this.rapid - dt)
    this.homingShots = Math.max(0, this.homingShots - dt)
  }
}
