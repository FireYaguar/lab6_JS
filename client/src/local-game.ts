import type { EntityId } from 'shared/brand.ts'
import type { RoomInfo } from 'shared/net/protocol.ts'
import { createArena } from 'shared/sim/arena.ts'
import { Ship } from 'shared/sim/ship.ts'
import type { Command } from 'shared/sim/types.ts'
import { World } from 'shared/sim/world.ts'
import type { Sprites } from './assets/loader.ts'
import { type Audio, connectAudio } from './audio.ts'
import { createHud } from './hud.ts'
import { createInput, readControls } from './input.ts'
import type { Stats } from './loop.ts'
import type { View } from './render/canvas.ts'
import { drawHud, drawWorld } from './render/draw.ts'

// Локальний режим (Lab 1–3): уся симуляція в браузері. Його вмикає ?exp=… або ?offline=1.
export interface LocalGame {
  readonly world: World
  readonly player: Ship
  readonly hud: string[] // додаткові рядки HUD (експерименти)
  simulate(dt: number, command?: Command): void
  render(alpha: number, stats: Stats): void
}

export function createLocalGame(
  ctx: CanvasRenderingContext2D,
  view: View,
  room: RoomInfo,
  name: string,
  sprites: Sprites,
  audio: Audio,
): LocalGame {
  const { width, height, seed, asteroids } = room.arena
  const world = new World(createArena(width, height), seed, { asteroids })
  const player = world.spawn(new Ship({ x: width / 2, y: height / 2, name }))
  // мішень: другий корабель без пілота — на ньому видно шкоду кулями, вибух і респаун
  world.spawn(new Ship({ x: width * 0.8, y: height * 0.3, name: 'drone' }))
  for (let i = 0; i < Math.min(5, asteroids); i++) world.spawnAsteroid()

  const input = createInput(window)
  const commands = new Map<EntityId, Command>()
  const hud = createHud(world.events, player)
  connectAudio(world.events, audio, player.id)
  const extra: string[] = []

  return {
    world,
    player,
    hud: extra,
    simulate(dt, command = readControls(input)) {
      commands.set(player.id, command)
      world.step(dt, commands)
      input.consume()
    },
    render(alpha, stats) {
      drawWorld(ctx, view, world, alpha, player.id, sprites)
      drawHud(ctx, stats, [`room     ${room.name}`, ...hud.lines(world), ...extra])
    },
  }
}
