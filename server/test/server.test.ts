import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { asSeq } from 'shared/brand.ts'
import { decodeSnapshot, encodeInput } from 'shared/net/binary.ts'
import { ServerMessage } from 'shared/net/protocol.ts'
import { type ClientOptions, WebSocket } from 'ws'
import { type App, createApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

let app: App
let base = ''
let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-srv-'))
  const dist = join(dir, 'dist')
  await mkdir(dist)
  await writeFile(join(dist, 'index.html'), '<h1>game</h1>')
  await writeFile(join(dir, 'secret.txt'), 'top secret')
  const config = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_DIR: join(dir, 'logs'),
    CLIENT_DIST: dist,
    LOG_LEVEL: 'silent',
    JOIN_TIMEOUT_MS: '300',
    HEARTBEAT_MS: '200',
    RATE_LIMIT_PER_SEC: '5',
    RATE_LIMIT_BURST: '5',
  })
  app = createApp(config)
  base = `127.0.0.1:${await app.listen()}`
})
after(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true })
})

// сирий запит: fetch нормалізує «..» у URL ще до відправки, а нам треба перевірити сервер
function raw(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const [host, port] = base.split(':')
    const req = request({ host, port, method, path }, (res) => {
      let data = ''
      res.on('data', (c: Buffer) => {
        data += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

type Msg = ServerMessage
type Of<T extends Msg['type']> = Extract<Msg, { type: T }>

function connect(options?: ClientOptions, query = '') {
  const ws = new WebSocket(`ws://${base}/ws${query}`, options)
  const inbox: Msg[] = []
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = []
  ws.on('message', (d, isBinary) => {
    // і в тестах дані з мережі проходять схему / декодер — жодного JSON.parse «на віру»
    const msg = isBinary ? decodeSnapshot(d) : ServerMessage.parse(JSON.parse(String(d)))
    inbox.push(msg)
    for (const w of [...waiters]) if (w.pred(msg)) w.resolve(msg)
  })
  // next('roster', …) повертає вже звужений тип: m.players доступне без перевірок
  function next<T extends Msg['type']>(
    type: T,
    pred: (m: Of<T>) => boolean = () => true,
  ): Promise<Of<T>> {
    const isT = (m: Msg): m is Of<T> => m.type === type
    return new Promise((resolve) => {
      const hit = inbox.find((m) => isT(m) && pred(m))
      if (hit && isT(hit)) return resolve(hit)
      waiters.push({ pred: (m) => isT(m) && pred(m), resolve: (m) => isT(m) && resolve(m) })
    })
  }
  return {
    ws,
    open: () => new Promise<void>((r) => ws.once('open', () => r())),
    send: (m: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...m })),
    next,
    closed: () =>
      new Promise<{ code: number; reason: string }>((r) =>
        ws.once('close', (code, reason) => r({ code, reason: String(reason) })),
      ),
  }
}

describe('HTTP', () => {
  it('GET /health і /api/rooms', async () => {
    const health: unknown = JSON.parse((await raw('GET', '/health')).body)
    assert.ok(
      typeof health === 'object' && health !== null && 'status' in health && health.status === 'ok',
    )
    const body: unknown = JSON.parse((await raw('GET', '/api/rooms')).body)
    assert.ok(
      typeof body === 'object' && body !== null && 'rooms' in body && Array.isArray(body.rooms),
    )
    assert.deepEqual(
      body.rooms.map((r: { id: string }) => r.id),
      ['classic', 'belt', 'duel'],
    )
  })
  it('POST /api/rooms: валідна → 201, крива → 400, завелика → 413', async () => {
    const ok = await raw(
      'POST',
      '/api/rooms',
      JSON.stringify({ name: 'Mine', arena: { asteroids: 3 } }),
    )
    assert.equal(ok.status, 201)
    assert.match(ok.body, /"asteroids":3/)
    assert.equal((await raw('POST', '/api/rooms', '{"name":')).status, 400)
    assert.equal((await raw('POST', '/api/rooms', JSON.stringify({ name: '' }))).status, 400)
    assert.equal(
      (await raw('POST', '/api/rooms', JSON.stringify({ name: 'x', arena: { width: 'wide' } })))
        .status,
      400,
    )
    assert.equal((await raw('POST', '/api/rooms', 'x'.repeat(10_000))).status, 413)
  })
  it('статика: index.html, 404, шляхи з .. → 400', async () => {
    assert.equal((await raw('GET', '/')).body, '<h1>game</h1>')
    assert.equal((await raw('GET', '/nope.js')).status, 404)
    for (const p of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/a/../../secret.txt',
    ]) {
      const res = await raw('GET', p)
      assert.equal(res.status, 400, p)
      assert.ok(!res.body.includes('top secret'))
    }
  })
})

describe('WebSocket', () => {
  it('двоє в одній кімнаті бачать roster і чат', async () => {
    const a = connect()
    const b = connect()
    await Promise.all([a.open(), b.open()])
    a.send({ type: 'join', room: 'classic', name: 'Ann' })
    await a.next('welcome')
    b.send({ type: 'join', room: 'classic', name: 'Bob' })
    const roster = await a.next('roster', (m) => m.players.length === 2)
    assert.deepEqual(
      roster.players.map((p) => p.name),
      ['Ann', 'Bob'],
    )
    b.send({ type: 'chat', text: 'привіт' })
    const chat = await a.next('chat')
    assert.equal(chat.text, 'привіт')
    assert.equal(chat.from.name, 'Bob')
    b.ws.close(1000)
    await a.next('roster', (m) => m.players.length === 1)
    a.ws.close(1000)
  })
  it('без join за таймаут → 4408', async () => {
    const c = connect()
    assert.equal((await c.closed()).code, 4408)
  })
  it('невідомий тип, битий JSON, неіснуюча кімната, бінарне сміття, input до join', async () => {
    const cases: [(c: ReturnType<typeof connect>) => void, number][] = [
      [(c) => c.send({ type: 'teleport' }), 4400],
      [(c) => c.ws.send('{"v":1,"type":'), 4400],
      [(c) => c.send({ type: 'join', room: 'nope', name: 'x' }), 4404],
      [(c) => c.ws.send(Buffer.from([1, 2, 3]), { binary: true }), 4400],
      [
        (c) =>
          c.ws.send(
            encodeInput({ v: 1, type: 'input', seq: asSeq(1), thrust: true, fire: false, turn: 0 }),
          ),
        4400,
      ],
    ]
    for (const [act, code] of cases) {
      const c = connect()
      await c.open()
      act(c)
      assert.equal((await c.closed()).code, code)
    }
  })
  it('завелике повідомлення → 1009, флуд → 4429', async () => {
    const big = connect()
    await big.open()
    big.send({ type: 'chat', text: 'x'.repeat(5000) })
    assert.equal((await big.closed()).code, 1009)

    const flood = connect()
    await flood.open()
    flood.send({ type: 'join', room: 'belt', name: 'spam' })
    for (let i = 0; i < 20; i++) flood.send({ type: 'chat', text: `${i}` })
    assert.equal((await flood.closed()).code, 4429)
  })
  it('Lab 5: бінарний input → знімки з ack, корабель летить', async () => {
    const c = connect()
    await c.open()
    c.send({ type: 'join', room: 'duel', name: 'pilot' })
    const { shipId } = await c.next('match')
    const first = await c.next('snapshot')
    const start = first.entities.find((e) => e.id === shipId)
    for (let seq = 1; seq <= 10; seq++)
      c.ws.send(
        encodeInput({ v: 1, type: 'input', seq: asSeq(seq), thrust: true, fire: false, turn: 0 }),
      )
    const acked = await c.next('snapshot', (m) => m.ack === 10)
    const ship = acked.entities.find((e) => e.id === shipId)
    assert.ok(ship?.kind === 'ship' && start?.kind === 'ship')
    assert.ok(Math.hypot(ship.vx, ship.vy) > 0, 'корабель розігнався')
    assert.ok(ship.y !== start.y || ship.x !== start.x)
    c.ws.close(1000)
  })
  it('Lab 5: ?codec=json — знімки текстом і проходять схему', async () => {
    const c = connect(undefined, '?codec=json')
    await c.open()
    c.send({ type: 'join', room: 'duel', name: 'json' })
    c.send({ type: 'input', seq: 1, thrust: true, fire: false, turn: 1 })
    const snap = await c.next('snapshot', (m) => m.ack === 1)
    assert.ok(snap.entities.length > 0)
    c.ws.close(1000)
  })
  it('heartbeat: клієнт, що не відповідає pong, розривається', async () => {
    const c = connect({ autoPong: false }) // «мертвий» клієнт: на ping не відповідає
    await c.open()
    c.send({ type: 'join', room: 'belt', name: 'zombie' })
    assert.equal((await c.closed()).code, 1006) // terminate: TCP обірвано без close-кадру
  })
})
