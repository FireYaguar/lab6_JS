import { resolve } from 'node:path'
import { z } from 'zod'

// Конфіг лише з оточення (process.env), перевірка схемою Zod ОДИН раз на старті:
// краще впасти зараз із зрозумілим повідомленням, ніж о 3-й ночі з undefined.

const SERVER_ROOT = resolve(import.meta.dirname, '..') // у ESM немає __dirname

// '' в оточенні = «не задано» → значення за замовчуванням
const blank = (v: unknown): unknown => (v === '' ? undefined : v)
const int = (min: number, max: number, def: number) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(def))
const str = (def: string) => z.preprocess(blank, z.string().default(def))

const Env = z.object({
  PORT: int(0, 65535, 3000), // 0 — випадковий вільний порт (тести)
  HOST: str('0.0.0.0'),
  LOG_DIR: str('logs'),
  CLIENT_DIST: str('../client/dist'),
  LOG_LEVEL: z.preprocess(
    blank,
    z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  ),
  MAX_ROOMS: int(1, 1000, 20),
  MAX_PLAYERS_PER_ROOM: int(2, 64, 4),
  JOIN_TIMEOUT_MS: int(50, 60_000, 5000),
  HEARTBEAT_MS: int(50, 120_000, 15_000),
  RATE_LIMIT_PER_SEC: int(1, 1000, 10),
  RATE_LIMIT_BURST: int(1, 1000, 20),
  NODE_ENV: z.string().optional(),
})

export type LogLevel = z.infer<typeof Env>['LOG_LEVEL']

export interface ServerConfig {
  readonly port: number
  readonly host: string
  readonly logDir: string
  readonly clientDist: string
  readonly logLevel: LogLevel
  readonly maxRooms: number
  readonly maxPlayersPerRoom: number
  readonly joinTimeoutMs: number
  readonly heartbeatMs: number
  readonly rateLimitPerSec: number
  readonly rateLimitBurst: number
  readonly maxPayloadBytes: number
  readonly maxBodyBytes: number
  readonly softBufferBytes: number // вище — не шлемо клієнту некритичне (чат, знімки)
  readonly hardBufferBytes: number // вище — клієнт безнадійно відстав, розриваємо
  readonly debugRoutes: boolean // /api/debug/* і штучна мережа — лише в розробці
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`Невалідний конфіг:\n  ${lines.join('\n  ')}`)
  }
  const e = parsed.data
  return Object.freeze({
    port: e.PORT,
    host: e.HOST,
    logDir: resolve(SERVER_ROOT, e.LOG_DIR),
    clientDist: resolve(SERVER_ROOT, e.CLIENT_DIST),
    logLevel: e.LOG_LEVEL,
    maxRooms: e.MAX_ROOMS,
    maxPlayersPerRoom: e.MAX_PLAYERS_PER_ROOM,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    heartbeatMs: e.HEARTBEAT_MS,
    rateLimitPerSec: e.RATE_LIMIT_PER_SEC,
    rateLimitBurst: e.RATE_LIMIT_BURST,
    maxPayloadBytes: 4096,
    maxBodyBytes: 4096,
    softBufferBytes: 64 * 1024,
    hardBufferBytes: 1024 * 1024,
    debugRoutes: e.NODE_ENV !== 'production',
  })
}
