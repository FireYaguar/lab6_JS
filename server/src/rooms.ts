import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { TICK_RATE } from 'shared/net/constants.ts'
import type { RoomInfo, ServerMessage } from 'shared/net/protocol.ts'
import type { ServerConfig } from './config.ts'
import { startMatchLog } from './log/matchlog.ts'
import { errorMessage, log } from './log.ts'
import { Match } from './match.ts'
import type { LeaveReason, MatchEvent, Player, RoomEvents, SendOptions } from './types.ts'

export type RoomErrorCode = 'not_found' | 'full' | 'limit'
export class RoomError extends Error {
  readonly code: RoomErrorCode
  constructor(code: RoomErrorCode, message: string) {
    super(message)
    this.name = 'RoomError'
    this.code = code
  }
}

type Arena = RoomInfo['arena']
// Звичайний Omit над об’єднанням злипає варіанти в один тип; умовний тип застосовує його до кожного окремо
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
interface RoomOptions {
  id: string
  name: string
  maxPlayers: number
  arena: Arena
  persistent?: boolean
}

// Кімната — типізований EventEmitter: room.emit('chat', player) без тексту не скомпілюється.
// Lab 5: у кімнати з гравцями є Match (створюється на першому join, зупиняється, коли порожньо).
export class Room extends EventEmitter<RoomEvents> {
  readonly players = new Map<string, Player>()
  match: Match | null = null
  logging = false
  readonly id: string
  readonly name: string
  readonly maxPlayers: number
  readonly arena: Arena
  readonly persistent: boolean // стандартні кімнати не видаляються, коли спорожніють

  constructor({ id, name, maxPlayers, arena, persistent = false }: RoomOptions) {
    super()
    this.id = id
    this.name = name
    this.maxPlayers = maxPlayers
    this.arena = arena
    this.persistent = persistent
  }

  get size(): number {
    return this.players.size
  }

  toJSON(): RoomInfo {
    const { id, name, maxPlayers, arena } = this
    return { id, name, players: this.size, maxPlayers, arena }
  }

  #record(event: DistributiveOmit<MatchEvent, 't' | 'room'>): void {
    this.emit('event', { ...event, t: Date.now(), room: this.id })
  }

  broadcast(msg: ServerMessage, options?: SendOptions): void {
    const data = JSON.stringify(msg) // серіалізуємо один раз на всіх
    for (const p of this.players.values()) p.sendRaw(data, options)
  }

  #roster(): void {
    const players = [...this.players.values()].map(({ id, name, shipId }) => ({
      id,
      name,
      shipId: shipId ?? undefined,
    }))
    this.broadcast({ type: 'roster', players })
  }

  join(player: Player): void {
    if (this.size >= this.maxPlayers) throw new RoomError('full', 'room is full')
    this.players.set(player.id, player)
    if (!this.match) {
      this.match = new Match(this.arena)
      this.match.start()
    }
    player.shipId = this.match.addPlayer(player).id
    player.send({ type: 'match', shipId: player.shipId, tickRate: TICK_RATE, arena: this.arena })
    this.emit('join', player) // слухачі виконуються синхронно, тут — старт логу матчу
    this.#record({ type: 'join', player: { id: player.id, name: player.name } })
    this.broadcast({ type: 'system', text: `${player.name} приєднався` }, { critical: false })
    this.#roster()
  }

  leave(playerId: string, reason: LeaveReason = 'leave'): void {
    const player = this.players.get(playerId)
    if (!player) return
    this.players.delete(playerId)
    this.match?.removePlayer(playerId)
    this.emit('leave', player, reason)
    this.#record({ type: 'leave', player: { id: player.id, name: player.name }, reason })
    this.broadcast({ type: 'system', text: `${player.name} вийшов` }, { critical: false })
    this.#roster()
    if (this.size === 0) {
      this.match?.stop()
      this.match = null
      this.emit('matchEnd') // закриває лог матчу
      this.emit('empty')
    }
  }

  chat(playerId: string, text: string): void {
    const player = this.players.get(playerId)
    if (!player) return
    this.emit('chat', player, text)
    this.#record({ type: 'chat', player: { id: player.id, name: player.name }, text })
    // чат некритичний: повільному клієнту його можна не надіслати
    this.broadcast(
      { type: 'chat', from: { id: player.id, name: player.name }, text, t: Date.now() },
      { critical: false },
    )
  }
}

const DEFAULT_ROOMS: readonly Omit<RoomOptions, 'maxPlayers'>[] = [
  { id: 'classic', name: 'Classic', arena: { width: 1600, height: 900, asteroids: 6, seed: 2026 } },
  {
    id: 'belt',
    name: 'Asteroid Belt',
    arena: { width: 1800, height: 1000, asteroids: 14, seed: 7 },
  },
  { id: 'duel', name: 'Duel (small)', arena: { width: 1100, height: 650, asteroids: 3, seed: 42 } },
]
const DUEL_PLAYERS = 2
const UNUSED_ROOM_TTL_MS = 60_000

export interface CreateRoom {
  id?: string
  name: string
  arena: Arena
  maxPlayers?: number | undefined
  persistent?: boolean
}

export class RoomManager {
  readonly #rooms = new Map<string, Room>()
  readonly #logs = new Set<Promise<void>>() // проміси pipeline логів, що ще пишуться
  readonly #config: Pick<ServerConfig, 'maxRooms' | 'maxPlayersPerRoom' | 'logDir'>

  constructor(config: Pick<ServerConfig, 'maxRooms' | 'maxPlayersPerRoom' | 'logDir'>) {
    this.#config = config
  }

  createDefaults(): void {
    for (const r of DEFAULT_ROOMS) {
      this.create({
        ...r,
        persistent: true,
        maxPlayers: r.id === 'duel' ? DUEL_PLAYERS : undefined,
      })
    }
  }

  get size(): number {
    return this.#rooms.size
  }

  get playerCount(): number {
    let n = 0
    for (const r of this.#rooms.values()) n += r.size
    return n
  }

  list(): Room[] {
    return [...this.#rooms.values()]
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id)
  }

  create({ id, name, arena, maxPlayers, persistent = false }: CreateRoom): Room {
    if (this.#rooms.size >= this.#config.maxRooms) throw new RoomError('limit', 'too many rooms')
    const room = new Room({
      id: id ?? randomUUID().slice(0, 8),
      name,
      arena,
      maxPlayers: Math.min(
        maxPlayers ?? this.#config.maxPlayersPerRoom,
        this.#config.maxPlayersPerRoom,
      ),
      persistent,
    })
    // EventEmitter без слухача 'error' кидає виняток і валить процес — слухач є завжди
    room.on('error', (err) => log('error', 'room.error', { room: room.id, err: err.message }))
    room.on('join', () => this.#ensureMatchLog(room))
    room.on('empty', () => {
      if (!room.persistent) this.delete(room.id)
    })
    if (!persistent) {
      // кімната, в яку так ніхто й не зайшов, теж не живе вічно
      setTimeout(() => room.size === 0 && this.delete(room.id), UNUSED_ROOM_TTL_MS).unref()
    }
    this.#rooms.set(room.id, room)
    log('info', 'room.created', { room: room.id })
    return room
  }

  #ensureMatchLog(room: Room): void {
    if (room.logging) return
    room.logging = true
    room.once('matchEnd', () => {
      room.logging = false // наступний join почне новий файл, навіть поки старий ще дописується
    })
    const { file, done } = startMatchLog(room, this.#config.logDir)
    log('info', 'matchlog.start', { room: room.id, file })
    const tracked: Promise<void> = done
      .then(() => log('info', 'matchlog.closed', { room: room.id, file }))
      .catch((err: unknown) =>
        log('error', 'matchlog.error', { room: room.id, err: errorMessage(err) }),
      )
      .finally(() => this.#logs.delete(tracked))
    this.#logs.add(tracked)
  }

  delete(id: string): void {
    const room = this.#rooms.get(id)
    if (!room) return
    this.#rooms.delete(id)
    room.match?.stop()
    room.emit('matchEnd')
    log('info', 'room.deleted', { room: id })
  }

  // Для graceful shutdown: закінчити всі матчі й дочекатися, поки логи допишуться на диск.
  async closeAll(): Promise<void> {
    for (const room of this.#rooms.values()) {
      room.match?.stop()
      room.emit('matchEnd')
    }
    await Promise.allSettled([...this.#logs])
  }
}
