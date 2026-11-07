import { asSeq, type EntityId } from '../brand.ts'
import { createArena } from './arena.ts'
import { Ship } from './ship.ts'
import type { Command } from './types.ts'
import { World } from './world.ts'

// Хеш стану світу (FNV-1a по байтах Float64). id не враховуються — лічильник id залежить від того,
// скільки сутностей уже створив процес, а не від симуляції.
export function hashWorld(world: World): string {
  const f64 = new Float64Array(1)
  const bytes = new Uint8Array(f64.buffer)
  let h = 0x811c9dc5
  const mix = (v: number): void => {
    f64[0] = v
    for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0
  }
  for (const e of world) {
    for (const ch of e.kind) mix(ch.charCodeAt(0))
    mix(e.pos.x)
    mix(e.pos.y)
    mix(e.vel.x)
    mix(e.vel.y)
    mix(e.angle)
    if (e.kind === 'ship') {
      mix(e.hp)
      mix(e.score)
    }
  }
  return h.toString(16).padStart(8, '0')
}

export interface DeterminismResult {
  steps: number
  hash: string
  entities: number
  scoreA: number
  scoreB: number
  hashes?: string[] // з trace: хеш після кожного кроку — щоб знайти перший крок розбіжності
}

// Lab 5: однаковий скриптований input → однаковий хеш у Node і в браузері.
export function runDeterminism(
  steps = 1000,
  seed = 2026,
  { trace = false } = {},
): DeterminismResult {
  const hashes: string[] = []
  const world = new World(createArena(), seed, { asteroids: 6 })
  const a = world.spawn(new Ship({ x: 500, y: 450 }))
  const b = world.spawn(new Ship({ x: 1100, y: 450, angle: Math.PI / 2 }))
  for (let i = 0; i < 5; i++) world.spawnAsteroid()
  const commands = new Map<EntityId, Command>()
  for (let i = 0; i < steps; i++) {
    const turnA = (Math.floor(i / 40) % 3) - 1
    commands.set(a.id, {
      seq: asSeq(i),
      thrust: i % 90 < 50,
      turn: turnA === -1 ? -1 : turnA === 0 ? 0 : 1,
      fire: i % 7 === 0,
    })
    commands.set(b.id, {
      seq: asSeq(i),
      thrust: i % 60 < 20,
      turn: i % 200 < 100 ? 1 : 0,
      fire: i % 11 === 0,
    })
    world.step(1 / 60, commands)
    if (trace) hashes.push(hashWorld(world))
  }
  const result: DeterminismResult = {
    steps,
    hash: hashWorld(world),
    entities: world.size,
    scoreA: a.score,
    scoreB: b.score,
  }
  if (trace) result.hashes = hashes
  return result
}
