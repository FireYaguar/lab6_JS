// Що буде, якщо HTTP-обробник займе цикл подій на 300 мс?
// Двоє гравців у кімнаті: A шле чат кожні 150 мс, B міряє затримку доставки. Паралельно /health кожні 100 мс.
// Спершу 3 с норми, потім тричі GET /api/debug/block?ms=300.
// Запуск: npm run bench:block -w server
import { type RawData, WebSocket } from 'ws'
import { startServer } from './_server.ts'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const server = await startServer(3101)
const ws = (name: string): Promise<WebSocket> =>
  new Promise((resolve) => {
    const s = new WebSocket(`${server.base.replace('http', 'ws')}/ws`)
    s.on('open', () => {
      s.send(JSON.stringify({ v: 1, type: 'join', room: 'classic', name }))
      resolve(s)
    })
  })
const [a, b] = await Promise.all([ws('A'), ws('B')])

type Phase = 'baseline' | 'blocked'
let phase: Phase = 'baseline'
const chat: Record<Phase, number[]> = { baseline: [], blocked: [] }
const health: Record<Phase, number[]> = { baseline: [], blocked: [] }
b.on('message', (d: RawData, isBinary: boolean) => {
  // TS знайшов: з Lab 5 сервер шле бінарні знімки, і JSON.parse(d) падав на першому ж кадрі
  if (isBinary) return
  const m: unknown = JSON.parse(String(d))
  if (typeof m === 'object' && m !== null && 'type' in m && m.type === 'chat' && 'text' in m) {
    chat[phase].push(performance.now() - Number(m.text))
  }
})
const sender = setInterval(
  () => a.send(JSON.stringify({ v: 1, type: 'chat', text: String(performance.now()) })),
  150,
)
const prober = setInterval(async () => {
  const t = performance.now()
  const p = phase
  await fetch(`${server.base}/health`)
  health[p].push(performance.now() - t)
}, 100)

await wait(3000)
phase = 'blocked'
for (let i = 0; i < 3; i++) {
  void fetch(`${server.base}/api/debug/block?ms=300`) // навмисно не чекаємо: блок іде паралельно
  await wait(1000)
}
clearInterval(sender)
clearInterval(prober)
await wait(400)

const stat = (xs: number[]): string => {
  const s = [...xs].sort((x, y) => x - y)
  return `n=${s.length} p50=${(s[Math.floor(s.length / 2)] ?? 0).toFixed(1)} мс max=${(s[s.length - 1] ?? 0).toFixed(1)} мс`
}
console.log('чат  норма   :', stat(chat.baseline))
console.log('чат  з блоком:', stat(chat.blocked))
console.log('/health норма   :', stat(health.baseline))
console.log('/health з блоком:', stat(health.blocked))
a.close()
b.close()
console.log('SIGTERM →', await server.stop())
