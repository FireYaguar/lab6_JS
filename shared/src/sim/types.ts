import type { Seq } from '../brand.ts'

export type EntityKind = 'ship' | 'bullet' | 'asteroid' | 'pickup' | 'explosion'
export type Effect = 'shield' | 'rapid' | 'homing'
export type Turn = -1 | 0 | 1

// Команда для симуляції. Структурна типізація: input-повідомлення протоколу ({ v, type, seq, … })
// підходить сюди без перетворень — зайві поля не заважають, важлива форма.
export interface Command {
  readonly seq?: Seq
  readonly thrust: boolean
  readonly turn: Turn
  readonly fire: boolean
}

export function assertNever(value: never): never {
  throw new Error(`unexpected variant: ${JSON.stringify(value)}`)
}
