import type { EntityId } from 'shared/brand.ts'
import type { ServerMessage, Snapshot } from 'shared/net/protocol.ts'

export interface SendOptions {
  readonly critical?: boolean // некритичне (чат, знімки) повільному клієнту можна не надіслати
}

// Гравець очима кімнати й матчу: вони не знають про WebSocket, лише кличуть send.
export interface Player {
  readonly id: string
  readonly name: string
  shipId: EntityId | null
  send(message: ServerMessage, options?: SendOptions): void
  sendRaw(data: string, options?: SendOptions): void // уже серіалізоване (broadcast серіалізує один раз)
  sendSnapshot(snapshot: Snapshot): void
}

export type LeaveReason = 'leave' | 'disconnect'
type PlayerRef = { readonly id: string; readonly name: string }

// Запис логу матчу — розрізнюване об’єднання за type.
export type MatchEvent =
  | { t: number; room: string; type: 'join'; player: PlayerRef }
  | { t: number; room: string; type: 'leave'; player: PlayerRef; reason: LeaveReason }
  | { t: number; room: string; type: 'chat'; player: PlayerRef; text: string }

// Події кімнати: ім’я → кортеж аргументів слухача. EventEmitter<RoomEvents> перевіряє і emit, і on.
export type RoomEvents = {
  join: [player: Player]
  leave: [player: Player, reason: LeaveReason]
  chat: [player: Player, text: string]
  event: [record: MatchEvent]
  empty: []
  matchEnd: []
  error: [err: Error]
}
