import { Bus } from 'shared/bus.ts'
import { type ClientMessage, ServerMessage } from 'shared/net/protocol.ts'
import { assertNever } from 'shared/sim/types.ts'

// Обгортка WebSocket: черга send, поки з’єднання немає; розбір повідомлень за type;
// повторне підключення з дедалі довшою паузою (exponential backoff + jitter).
// Lab 6: кожне JSON-повідомлення проходить схему ServerMessage; події типізовані — on('roster', m => m.players)
// знає форму m без жодних перевірок.

// { roster: RosterMessage, chat: ChatMessage, … } — виводиться зі схеми через перейменування ключів
type ServerEvents = { [M in ServerMessage as M['type']]: M }
export type ConnectionStatus =
  | { state: 'connecting' | 'open' }
  | { state: 'reconnecting'; delay: number; attempt: number }
  | { state: 'closed'; code: number; reason: string }
export type ConnectionEvents = ServerEvents & {
  status: ConnectionStatus
  open: undefined
  close: { code: number; reason: string }
  binary: ArrayBuffer // знімок (Lab 5)
}

// Звичайний Omit над об’єднанням злипає варіанти — умовний тип застосовує його до кожного окремо
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type Outgoing = DistributiveOmit<Exclude<ClientMessage, { type: 'input' }>, 'v'>

const NO_RECONNECT = new Set([1000, 4400, 4404, 4408, 4409]) // нормальне закриття або наша помилка — повтор не допоможе
const MAX_QUEUE = 100

export function wsUrl(path = '/ws'): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

export class Connection extends Bus<ConnectionEvents> {
  readonly #url: string
  #ws: WebSocket | null = null
  readonly #queue: string[] = []
  #attempt = 0
  #timer = 0
  #stopped = false
  readonly #baseMs: number
  readonly #maxMs: number
  bytesIn = 0 // лічильники для netgraph (корисне навантаження, без заголовків кадрів WebSocket)
  bytesOut = 0

  constructor(url: string, { baseMs = 500, maxMs = 10_000 } = {}) {
    super()
    this.#url = url
    this.#baseMs = baseMs
    this.#maxMs = maxMs
  }

  // Звуження за type: TS не вміє «emit(msg.type, msg)» для об’єднання (ключ і payload незалежні),
  // тож кожен варіант — окремий case, а never у default ловить новий тип повідомлення.
  #dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.emit('welcome', msg)
        break
      case 'match':
        this.emit('match', msg)
        break
      case 'roster':
        this.emit('roster', msg)
        break
      case 'chat':
        this.emit('chat', msg)
        break
      case 'system':
        this.emit('system', msg)
        break
      case 'pong':
        this.emit('pong', msg)
        break
      case 'shutdown':
        this.emit('shutdown', msg)
        break
      case 'snapshot':
        this.emit('snapshot', msg)
        break
      default:
        assertNever(msg)
    }
  }

  #onText(text: string): void {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      console.warn('[net] битий JSON від сервера')
      return // сервер теж може помилитись — не валимо клієнт
    }
    const parsed = ServerMessage.safeParse(json)
    if (parsed.success) this.#dispatch(parsed.data)
    else console.warn('[net] повідомлення не пройшло схему', parsed.error.issues[0])
  }

  connect(): void {
    if (this.#stopped) return
    const ws = new WebSocket(this.#url)
    ws.binaryType = 'arraybuffer' // бінарні кадри одразу як ArrayBuffer → DataView
    this.#ws = ws
    this.emit('status', { state: 'connecting' })

    ws.addEventListener('open', () => {
      this.#attempt = 0
      this.emit('status', { state: 'open' })
      this.emit('open', undefined) // гра шле join тут — він піде раніше за накопичену чергу
      for (const data of this.#queue.splice(0)) ws.send(data)
    })
    ws.addEventListener('message', (e: MessageEvent<unknown>) => {
      const data = e.data // MessageEvent<any> за замовчуванням — явно просимо unknown і звужуємо
      if (data instanceof ArrayBuffer) {
        this.bytesIn += data.byteLength
        this.emit('binary', data)
      } else if (typeof data === 'string') {
        this.bytesIn += data.length // JSON у нас ASCII → символи ≈ байти
        this.#onText(data)
      }
    })
    ws.addEventListener('close', (e) => {
      this.emit('close', { code: e.code, reason: e.reason })
      if (this.#stopped || NO_RECONNECT.has(e.code)) {
        this.emit('status', { state: 'closed', code: e.code, reason: e.reason })
        return
      }
      this.#scheduleReconnect()
    })
    // 'error' у браузерному WebSocket не має деталей, за ним завжди йде 'close' — там і обробляємо
  }

  #scheduleReconnect(): void {
    const delay = Math.min(this.#maxMs, this.#baseMs * 2 ** this.#attempt) * (0.5 + Math.random())
    this.#attempt += 1
    this.emit('status', { state: 'reconnecting', delay, attempt: this.#attempt })
    this.#timer = window.setTimeout(() => this.connect(), delay)
  }

  // Input не ставимо в чергу: застарілий input після реконекту гірший, ніж жодного.
  sendRaw(data: string | ArrayBuffer): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength
    this.#ws.send(data)
    return true
  }

  // Outgoing: форма перевіряється компілятором — send({ type: 'chat' }) без text не скомпілюється
  send(msg: Outgoing): void {
    const data = JSON.stringify({ v: 1, ...msg })
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.bytesOut += data.length
      this.#ws.send(data)
    } else if (this.#queue.length < MAX_QUEUE) {
      this.#queue.push(data) // відправимо після (пере)підключення
    }
  }

  close(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#ws?.close(1000, 'bye')
  }
}
