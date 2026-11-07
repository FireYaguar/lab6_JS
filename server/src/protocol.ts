import { CodecError, decodeInput } from 'shared/net/binary.ts'
import { ClientMessage } from 'shared/net/protocol.ts'

// Межа процесу: усе, що прийшло по WebSocket, — unknown, доки не пройде схему Zod (JSON) або
// бінарний декодер (input). Ручної перевірки з Lab 4 більше немає: схема — єдине джерело правди.

// Коди закриття. 1xxx — стандартні (RFC 6455), 4xxx — наші (запам’ятовуються як HTTP).
export const CLOSE = {
  normal: 1000,
  goingAway: 1001, // сервер вимикається
  tooBig: 1009,
  badMessage: 4400,
  roomNotFound: 4404,
  joinTimeout: 4408,
  roomFull: 4409,
  rateLimited: 4429,
} satisfies Record<string, number>
export type CloseCode = number

export type ParseResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; code: CloseCode; reason: string }

const fail = (code: CloseCode, reason: string): ParseResult => ({ ok: false, code, reason })

function byteLength(data: unknown): number {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength
  if (Array.isArray(data)) return data.reduce((n: number, part: unknown) => n + byteLength(part), 0)
  return 0
}

function toText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  if (ArrayBuffer.isView(data))
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  return null // фрагментовані кадри (Buffer[]) ми не вмикаємо — сюди не прийде
}

// Ніколи не кидає: будь-яке сміття → { ok: false, code, reason }, а ws.ts логує й закриває сокет.
export function parseClientMessage(data: unknown, isBinary: boolean, maxBytes = 4096): ParseResult {
  if (byteLength(data) > maxBytes) return fail(CLOSE.tooBig, 'message too big')
  if (isBinary) {
    try {
      return { ok: true, msg: decodeInput(data) }
    } catch (err: unknown) {
      if (err instanceof CodecError) return fail(CLOSE.badMessage, err.message)
      throw err // не помилка формату, а баг — хай видно буде
    }
  }
  const text = toText(data)
  if (text === null) return fail(CLOSE.badMessage, 'unsupported frame')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return fail(CLOSE.badMessage, 'invalid json')
  }
  const parsed = ClientMessage.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail(
      CLOSE.badMessage,
      issue
        ? `${issue.path.join('.') || 'message'}: ${issue.message}`.slice(0, 120)
        : 'bad message',
    )
  }
  return { ok: true, msg: parsed.data }
}
