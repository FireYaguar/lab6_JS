import { Bus } from 'shared/bus.ts'
import { type RoomInfo, RoomsResponse } from 'shared/net/protocol.ts'
import { loadJson } from '../assets/loader.ts'

// Дані лобі без DOM: список кімнат, періодичне оновлення, вхід. Рендер — lobby-view.ts.
// Lab 6: замість EventTarget + CustomEvent (detail: any) — типізована шина; замість ручного parseRooms — схема Zod.

export type LobbyEvents = {
  loading: undefined
  rooms: readonly RoomInfo[]
  error: unknown // з мережі може прилетіти будь-що — хай слухач звужує
  join: { room: RoomInfo; name: string }
}

export class Lobby extends Bus<LobbyEvents> {
  readonly #url: string
  readonly #intervalMs: number
  readonly #timeoutMs: number
  #timer = 0
  #controller: AbortController | null = null // живий, поки лобі на екрані; abort() — гравець пішов
  rooms: readonly RoomInfo[] = []

  constructor({
    url = 'api/rooms',
    intervalMs = 5000,
    timeoutMs = 3000,
  }: { url?: string; intervalMs?: number; timeoutMs?: number } = {}) {
    super()
    this.#url = url
    this.#intervalMs = intervalMs
    this.#timeoutMs = timeoutMs
  }

  enter(): void {
    if (this.#controller) return
    this.#controller = new AbortController()
    void this.refresh() // refresh сам ловить усі помилки — проміс свідомо не чекаємо
    this.#timer = window.setInterval(() => void this.refresh(), this.#intervalMs)
  }

  async refresh(): Promise<void> {
    const controller = this.#controller // запам’ятати: після leave() поле вже null
    if (!controller) return
    // кожен запит: скасування при виході АБО таймаут
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.#timeoutMs)])
    this.emit('loading', undefined)
    try {
      const data = await loadJson(this.#url, RoomsResponse, { signal })
      if (controller.signal.aborted) return // відповідь «з того світу» — екрана вже немає
      this.rooms = data.rooms
      this.emit('rooms', this.rooms)
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      this.emit('error', error)
    }
  }

  leave(): void {
    clearInterval(this.#timer)
    this.#controller?.abort()
    this.#controller = null
  }

  join(roomId: string | null, rawName: string): void {
    const room = this.rooms.find((r) => r.id === roomId)
    const name = rawName.trim().slice(0, 16)
    if (!room) throw new Error('Оберіть кімнату')
    if (!name) throw new Error('Введіть ім’я')
    if (room.players >= room.maxPlayers) throw new Error('Кімната заповнена')
    this.leave()
    this.emit('join', { room, name })
  }
}
