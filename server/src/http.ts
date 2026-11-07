import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { ServerConfig } from './config.ts'
import { listReplays, replayPath } from './log/replay.ts'
import { log } from './log.ts'
import { RoomError, type RoomManager } from './rooms.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.ndjson': 'application/x-ndjson',
}
const JSON_TYPE = 'application/json; charset=utf-8'
const NDJSON_TYPE = 'application/x-ndjson'
const HASHED = /-[\w-]{8}\.(js|css)$/ // файли Vite з хешем у назві можна кешувати назавжди

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

// Тіло запиту — потік шматків. Збираємо, але не більше limit байт. Результат — unknown, не any.
async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) continue
    size += chunk.length
    if (size > limit) throw new HttpError(413, `body larger than ${limit} bytes`)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid json')
  }
}

// POST /api/rooms — схема замість ручної перевірки з Lab 4.
const CreateRoomBody = z.object({
  name: z.string().trim().min(1).max(32),
  maxPlayers: z.number().int().min(2).max(64).optional(),
  arena: z
    .object({
      width: z.number().int().min(600).max(4000).default(1600),
      height: z.number().int().min(400).max(3000).default(900),
      asteroids: z.number().int().min(0).max(40).default(6),
      seed: z
        .number()
        .int()
        .min(0)
        .max(2 ** 31 - 1)
        .default(() => Math.floor(Math.random() * 1e9)),
    })
    .prefault({}),
})

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  throw new HttpError(400, issue ? `${issue.path.join('.')}: ${issue.message}` : 'bad request')
}

// Відхиляємо будь-який сегмент «..» ще ДО нормалізації URL, потім перевіряємо, що шлях усередині root.
function staticPath(root: string, rawUrl: string): string {
  let pathname: string
  try {
    pathname = decodeURIComponent(rawUrl.split('?')[0] ?? '/')
  } catch {
    throw new HttpError(400, 'bad path encoding')
  }
  if (pathname.includes('\0') || pathname.split(/[\\/]/).includes('..'))
    throw new HttpError(400, 'bad path')
  const file = resolve(root, `.${pathname}`)
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(400, 'bad path')
  return file
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  let file = staticPath(root, req.url ?? '/')
  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile()) throw new HttpError(404, 'not found')
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await pipeline(createReadStream(file), res) // стрімом: великий файл не лягає в пам’ять цілком
}

// Потік файлу у відповідь. Повільний клієнт → res.write() повертає false → pipeline чекає 'drain'.
async function streamReplay(res: ServerResponse, file: string): Promise<void> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new HttpError(404, 'replay not found')
  res.writeHead(200, { 'Content-Type': NDJSON_TYPE, 'Content-Length': info.size })
  await pipeline(createReadStream(file), res)
}

function replayFile(config: ServerConfig, id: string | undefined): string {
  const file = id === undefined ? null : replayPath(config.logDir, id)
  if (!file) throw new HttpError(400, 'bad replay id')
  return file
}

export function createHttpHandler({
  config,
  rooms,
}: {
  config: ServerConfig
  rooms: RoomManager
}): RequestListener {
  const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const { pathname } = url
    const m = req.method

    if (pathname === '/health' && m === 'GET') {
      const mem = process.memoryUsage()
      return sendJson(res, 200, {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        rooms: rooms.size,
        players: rooms.playerCount,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
      })
    }

    if (pathname === '/api/rooms') {
      if (m === 'GET') return sendJson(res, 200, { version: 1, rooms: rooms.list() })
      if (m === 'POST') {
        const body = parseBody(CreateRoomBody, await readJsonBody(req, config.maxBodyBytes))
        return sendJson(res, 201, { room: rooms.create(body) })
      }
      throw new HttpError(405, 'method not allowed')
    }

    if (pathname === '/api/stats' && m === 'GET') {
      const matches = rooms
        .list()
        .flatMap((r) => (r.match ? [{ room: r.id, ...r.match.stats() }] : []))
      return sendJson(res, 200, { matches })
    }

    if (pathname === '/api/replays' && m === 'GET')
      return sendJson(res, 200, { replays: await listReplays(config.logDir) })
    const replay = pathname.match(/^\/api\/replays\/([^/]+)$/)
    if (replay && m === 'GET') return streamReplay(res, replayFile(config, replay[1]))

    if (config.debugRoutes && pathname.startsWith('/api/debug/')) {
      // Навмисні антипатерни для README (вимкнено при NODE_ENV=production)
      if (pathname === '/api/debug/block') {
        const ms = Math.min(Number(url.searchParams.get('ms')) || 300, 5000)
        const end = performance.now() + ms
        while (performance.now() < end) {} // синхронно займаємо єдиний потік JS
        return sendJson(res, 200, { blockedMs: ms })
      }
      const buffered = pathname.match(/^\/api\/debug\/replay-buffered\/([^/]+)$/)
      if (buffered) {
        const data = await readFile(replayFile(config, buffered[1])) // увесь файл у пам’ять — саме так НЕ треба
        res.writeHead(200, { 'Content-Type': NDJSON_TYPE, 'Content-Length': data.length })
        res.end(data)
        return
      }
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'not found')
    if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, config.clientDist)
    throw new HttpError(405, 'method not allowed')
  }

  return (req, res) => {
    routes(req, res, new URL(req.url ?? '/', 'http://localhost')).catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return // клієнт пішов посеред завантаження
      const status = err instanceof HttpError ? err.status : err instanceof RoomError ? 409 : 500
      if (status === 500)
        log('error', 'http.error', {
          url: req.url,
          err: err instanceof Error ? err.stack : String(err),
        })
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, status, {
        error: status === 500 || !(err instanceof Error) ? 'internal error' : err.message,
      })
    })
  }
}
