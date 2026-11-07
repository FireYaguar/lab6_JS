import type { EntityId } from 'shared/brand.ts'
import type { Bus } from 'shared/bus.ts'
import type { WorldEvents } from 'shared/sim/world.ts'

// Web Audio. AudioContext можна створити одразу (буфери декодуються під час завантаження),
// але грати він почне лише після жесту гравця — unlock() на клік «Join» / першу клавішу.

export interface Audio {
  readonly ctx: AudioContext
  setBuffers(map: ReadonlyMap<string, AudioBuffer>): void
  unlock(): Promise<void>
  play(name: string, options?: { volume?: number; rate?: number }): void
}

export function createAudio(): Audio {
  const ctx = new AudioContext()
  const master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)
  let buffers: ReadonlyMap<string, AudioBuffer> = new Map()

  return {
    ctx,
    setBuffers(map) {
      buffers = map
    },
    unlock() {
      return ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
    },
    play(name, { volume = 1, rate = 1 } = {}) {
      const buffer = buffers.get(name)
      if (!buffer || ctx.state !== 'running') return // немає звуку → гра все одно йде
      const source = ctx.createBufferSource() // одноразовий вузол, буфер — багаторазовий
      source.buffer = buffer
      source.playbackRate.value = rate
      const gain = ctx.createGain()
      gain.gain.value = volume
      source.connect(gain).connect(master)
      source.start()
    },
  }
}

// Підписка на шину подій симуляції. Сим не знає про цей модуль — лише bus.emit.
export function connectAudio(bus: Bus<WorldEvents>, audio: Audio, playerId: EntityId): void {
  const mine = (id: EntityId): number => (id === playerId ? 1 : 0.4)
  bus.on('fired', (e) => audio.play('shoot', { volume: 0.5 * mine(e.shipId) }))
  bus.on('hit', () => audio.play('hit', { volume: 0.7 }))
  bus.on('exploded', (e) => audio.play('explode', { rate: e.kind === 'ship' ? 0.8 : 1.1 }))
  bus.on('picked', () => audio.play('pickup'))
}
