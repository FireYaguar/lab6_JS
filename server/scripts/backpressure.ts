// Backpressure: 200 МБ лог матчу качається через повільний канал (10 МБ/с), rss сервера міряється кожні 250 мс.
// Режим stream — /api/replays/:id (pipeline). Режим buffered — /api/debug/replay-buffered/:id (readFile, антипатерн).
// Запуск: npm run bench:backpressure -w server  → docs/backpressure.json
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { startServer } from './_server.ts'

const SIZE_MB = 200
const RATE = 10 * 1024 * 1024 // байт/с — «повільний канал»
const LOG_DIR = new URL('../logs/', import.meta.url)
const FILE = new URL('synthetic-big.ndjson', LOG_DIR)

async function generate() {
  if (existsSync(FILE)) return
  mkdirSync(LOG_DIR, { recursive: true })
  const target = SIZE_MB * 1024 * 1024
  async function* lines() {
    let bytes = 0
    for (let i = 0; bytes < target; i++) {
      let batch = ''
      for (let j = 0; j < 1000; j++) {
        batch += `${JSON.stringify({ t: 1_790_000_000_000 + i * 1000 + j, room: 'synthetic', type: 'chat', player: { id: `p${j % 8}`, name: `pilot${j % 8}` }, text: 'gg wp '.repeat(8) })}\n`
      }
      bytes += batch.length
      yield batch
    }
  }
  await pipeline(Readable.from(lines()), createWriteStream(FILE)) // генерація теж через pipeline
}

function slowDownload(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let bytes = 0
      const throttled = new Writable({
        highWaterMark: 64 * 1024,
        write(chunk, _enc, cb) {
          bytes += chunk.length
          setTimeout(cb, (chunk.length / RATE) * 1000) // споживач повільніший за диск у десятки разів
        },
      })
      pipeline(res, throttled).then(() => resolve(bytes), reject)
    }).on('error', reject)
  })
}

type Sample = [ms: number, rss: number]
interface Result {
  path: string
  bytes: number
  seconds: number
  peakRssMb: number
  samples: Sample[]
}

async function measure(base: string, path: string): Promise<Result> {
  const samples: Sample[] = []
  const t0 = performance.now()
  const timer = setInterval(async () => {
    const health: unknown = await (await fetch(`${base}/health`)).json()
    if (
      typeof health === 'object' &&
      health !== null &&
      'rss' in health &&
      typeof health.rss === 'number'
    ) {
      samples.push([Math.round(performance.now() - t0), health.rss])
    }
  }, 250)
  const bytes = await slowDownload(base + path)
  clearInterval(timer)
  await new Promise((r) => setTimeout(r, 300))
  const peak = Math.max(...samples.map((s) => s[1]))
  return {
    path,
    bytes,
    seconds: (performance.now() - t0) / 1000,
    peakRssMb: peak / 2 ** 20,
    samples,
  }
}

await generate()
const server = await startServer(3100)
const results: Record<string, Result> = {}
const modes: [string, string][] = [
  ['stream', '/api/replays/synthetic-big'],
  ['buffered', '/api/debug/replay-buffered/synthetic-big'],
]
for (const [mode, path] of modes) {
  const r = await measure(server.base, path)
  results[mode] = r
  const rss = r.samples.map((s) => s[1] / 2 ** 20)
  console.log(
    `${mode}: ${(r.bytes / 2 ** 20).toFixed(0)} MB за ${r.seconds.toFixed(1)} с; rss min ${Math.min(...rss).toFixed(0)} / max ${Math.max(...rss).toFixed(0)} MB`,
  )
}
console.log('SIGTERM →', await server.stop())
writeFileSync(
  new URL('../../docs/backpressure.json', import.meta.url),
  JSON.stringify({ rateBytesPerSec: RATE, results }),
)
