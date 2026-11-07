import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { after, describe, it } from 'node:test'
import type { ServerMessage } from 'shared/net/protocol.ts'
import { loadConfig } from '../src/config.ts'
import { NdjsonEncoder } from '../src/log/matchlog.ts'
import { listReplays, readReplay, replayPath } from '../src/log/replay.ts'
import { setLogLevel } from '../src/log.ts'
import { CLOSE, parseClientMessage } from '../src/protocol.ts'
import { createTokenBucket } from '../src/ratelimit.ts'
import { RoomManager } from '../src/rooms.ts'
import type { Player } from '../src/types.ts'

setLogLevel('silent')
const buf = (v: unknown): Buffer => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))

describe('protocol', () => {
  it('приймає валідні повідомлення і відкидає зайві поля', () => {
    const r = parseClientMessage(
      buf({ v: 1, type: 'join', room: 'classic', name: ' Ann ', admin: true }),
      false,
    )
    assert.deepEqual(r, { ok: true, msg: { v: 1, type: 'join', room: 'classic', name: 'Ann' } })
  })
  it('невідомий тип, зламана форма, битий JSON, версія → 4400 і БЕЗ винятку', () => {
    for (const raw of [
      { v: 1, type: 'teleport' },
      { v: 1, type: 'chat', text: 42 },
      { v: 1, type: 'chat', text: 'x'.repeat(201) },
      { v: 2, type: 'leave' },
      [1, 2],
      '{"v":1,',
      { v: 1, type: '__proto__' },
    ]) {
      const r = parseClientMessage(buf(raw), false)
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.code, CLOSE.badMessage, JSON.stringify(raw))
    }
  })
  it('бінарне сміття → 4400, завеликий → 1009', () => {
    const bin = parseClientMessage(buf('{}'), true)
    assert.equal(!bin.ok && bin.code, CLOSE.badMessage)
    const big = parseClientMessage(buf('x'.repeat(5000)), false, 4096)
    assert.equal(!big.ok && big.code, CLOSE.tooBig)
  })
})

describe('token bucket', () => {
  it('пропускає burst, далі — rate за секунду', () => {
    let t = 0
    const b = createTokenBucket({ rate: 10, burst: 3, now: () => t })
    assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false])
    t += 100 // +1 токен
    assert.deepEqual([b.take(), b.take()], [true, false])
  })
})

describe('config (Zod)', () => {
  it('падає з поясненням на невалідному оточенні', () => {
    assert.throws(
      () => loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /PORT/)
        assert.match(err.message, /LOG_LEVEL/)
        return true
      },
    )
  })
  it('значення за замовчуванням і порожній рядок = «не задано»', () => {
    assert.equal(loadConfig({}).port, 3000)
    assert.equal(loadConfig({ PORT: '' }).port, 3000)
    assert.equal(loadConfig({ PORT: '8080' }).port, 8080)
    assert.equal(loadConfig({ NODE_ENV: 'production' }).debugRoutes, false)
  })
})

function fakePlayer(id: string, name: string, inbox: ServerMessage[] = []): Player {
  return {
    id,
    name,
    shipId: null,
    send: (m) => inbox.push(m),
    sendRaw: (d) => inbox.push(JSON.parse(d)),
    sendSnapshot: () => {},
  }
}

describe('match log', () => {
  const dirs: string[] = []
  after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

  it('NdjsonEncoder: об’єкти → рядки; readReplay читає назад', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-'))
    dirs.push(dir)
    const file = join(dir, 'x.ndjson')
    const events = [
      { type: 'a', n: 1 },
      { type: 'b', text: 'привіт\nсвіт' },
    ]
    await pipeline(Readable.from(events), new NdjsonEncoder(), createWriteStream(file))
    assert.equal((await readFile(file, 'utf8')).split('\n').length, 3)
    const back: unknown[] = []
    for await (const e of readReplay(file)) back.push(e)
    assert.deepEqual(back, events)
  })

  it('кімната: join/chat/leave пишуться у файл, порожня кімната видаляється', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-'))
    dirs.push(dir)
    const manager = new RoomManager({ maxRooms: 5, maxPlayersPerRoom: 4, logDir: dir })
    // TS знайшов: у JS-версії тесту тут було arena: {} — і Match рахував у NaN
    const room = manager.create({
      name: 'Test',
      arena: { width: 800, height: 600, asteroids: 0, seed: 1 },
    })
    const inbox: ServerMessage[] = []
    room.join(fakePlayer('p1', 'Ann', inbox))
    room.chat('p1', 'hello')
    room.leave('p1')
    assert.equal(manager.get(room.id), undefined, 'порожня кімната видалена')
    await manager.closeAll()
    const [replay] = await listReplays(dir)
    assert.ok(replay)
    const types: unknown[] = []
    for await (const e of readReplay(join(dir, `${replay.id}.ndjson`))) {
      if (typeof e === 'object' && e !== null && 'type' in e) types.push(e.type)
    }
    assert.deepEqual(types, ['join', 'chat', 'leave'])
    assert.ok(inbox.some((m) => m.type === 'roster'))
    assert.ok(inbox.some((m) => m.type === 'match'))
  })

  it('replayPath відкидає ../ та інші символи', () => {
    assert.equal(replayPath('/logs', '../etc/passwd'), null)
    assert.equal(replayPath('/logs', 'a/b'), null)
    assert.equal(replayPath('/logs', 'classic-2026'), join('/logs', 'classic-2026.ndjson'))
  })
})
