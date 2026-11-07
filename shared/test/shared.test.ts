import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asSeq, asTick, type Seq, type Tick } from '../src/brand.ts'
import { Bus } from '../src/bus.ts'
import {
  CodecError,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
} from '../src/net/binary.ts'
import { codecs } from '../src/net/codec.ts'
import { ClientMessage, type InputMessage, SnapshotMessage } from '../src/net/protocol.ts'
import { buildSnapshot } from '../src/net/snapshot.ts'
import { createArena } from '../src/sim/arena.ts'
import { createPickup } from '../src/sim/components.ts'
import { datan2, dcos, dsin } from '../src/sim/dmath.ts'
import { runDeterminism } from '../src/sim/selftest.ts'
import { Ship } from '../src/sim/ship.ts'
import type { Command } from '../src/sim/types.ts'
import { stepShip, World } from '../src/sim/world.ts'

describe('shared sim', () => {
  it('імпортується в Node без DOM', () => {
    assert.equal('window' in globalThis, false)
    assert.equal('document' in globalThis, false)
  })
  it('детермінізм: однаковий input → однаковий хеш', () => {
    const a = runDeterminism(1000)
    const b = runDeterminism(1000)
    assert.equal(a.hash, b.hash)
    assert.ok(a.scoreA + a.scoreB > 0, 'у сценарії є влучання')
  })
  it('детермінізм після міграції на TS: той самий еталонний хеш, що в Lab 5 (і в Chromium через ?exp=determinism)', () => {
    assert.equal(runDeterminism(1000).hash, '74fe05fb')
  })
  it('dsin/dcos/datan2 збігаються з Math з точністю ~1e-15', () => {
    for (let i = 0; i < 20000; i++) {
      const x = ((i * 0.000731) % 40) - 20
      assert.ok(Math.abs(dsin(x) - Math.sin(x)) < 1e-15)
      assert.ok(Math.abs(dcos(x) - Math.cos(x)) < 1e-15)
      assert.ok(Math.abs(datan2(x, 1.7 - (i % 7)) - Math.atan2(x, 1.7 - (i % 7))) < 1e-15)
    }
  })
  it('stepShip + syncFrom: повторне програвання input дає той самий стан', () => {
    const arena = createArena()
    const inputs: Command[] = Array.from({ length: 50 }, (_, i) => ({
      seq: asSeq(i + 1),
      thrust: i % 3 !== 0,
      turn: i % 5 > 2 ? 1 : 0,
      fire: false,
    }))
    const server = new Ship({ x: 100, y: 100 })
    for (const cmd of inputs) stepShip(server, cmd, 1 / 60, arena)
    const mid = new Ship({ x: 100, y: 100 })
    for (const cmd of inputs.slice(0, 20)) stepShip(mid, cmd, 1 / 60, arena)
    const client = new Ship({ x: 500, y: 500 }) // «десь не там» — звірка має це виправити
    client.syncFrom({
      ...mid,
      x: mid.pos.x,
      y: mid.pos.y,
      vx: mid.vel.x,
      vy: mid.vel.y,
      hp: mid.hp,
    })
    for (const cmd of inputs.slice(20)) stepShip(client, cmd, 1 / 60, arena)
    assert.equal(client.pos.x, server.pos.x)
    assert.equal(client.pos.y, server.pos.y)
  })
  it('Bus: подія доходить до слухача, відписка працює', () => {
    const bus = new Bus<{ hit: { damage: number } }>()
    const got: number[] = []
    const off = bus.on('hit', (p) => got.push(p.damage))
    bus.emit('hit', { damage: 5 })
    off()
    bus.emit('hit', { damage: 7 })
    assert.deepEqual(got, [5])
  })
})

describe('branded-типи (перевіряє tsc, а не рантайм)', () => {
  it('Tick не можна передати як Seq', () => {
    const useSeq = (s: Seq): number => s
    const tick: Tick = asTick(5)
    // @ts-expect-error — саме цей рядок і є тестом: якщо tsc його пропустить, typecheck впаде
    useSeq(tick)
    // @ts-expect-error — звичайне число теж не Seq
    useSeq(5)
    assert.equal(useSeq(asSeq(5)), 5)
  })
})

function sampleWorld(): World {
  const world = new World(createArena(), 7, { asteroids: 6 })
  const ships = [0, 1, 2, 3].map((i) => world.spawn(new Ship({ x: 300 + i * 300, y: 450 })))
  for (let i = 0; i < 6; i++) world.spawnAsteroid()
  world.spawn(createPickup({ x: 50, y: 50, effect: 'rapid' }))
  for (let i = 0; i < 30; i++) {
    for (const s of ships)
      world.applyInput(s, { seq: asSeq(i), thrust: true, turn: 1, fire: true }, 1 / 60)
    world.stepOthers(1 / 60)
  }
  return world
}

describe('binary codec', () => {
  it('input: round-trip і рівно 8 байт', () => {
    const input: InputMessage = {
      v: 1,
      type: 'input',
      seq: asSeq(123456),
      thrust: true,
      fire: false,
      turn: -1,
    }
    const buf = encodeInput(input)
    assert.equal(buf.byteLength, 8)
    assert.deepEqual(decodeInput(buf), input)
    const pooled = Buffer.concat([Buffer.alloc(3), Buffer.from(buf)]).subarray(3) // Buffer з byteOffset, як дає ws
    assert.equal(decodeInput(pooled).seq, 123456)
  })
  it('input: сміття → CodecError', () => {
    const bad = [
      [1, 1, 0, 0],
      [2, 1, 0, 0, 0, 0, 0, 0],
      [1, 1, 0, 0, 0, 0, 9, 0],
      [1, 1, 0, 0, 0, 0, 0, 5],
    ]
    for (const b of bad) assert.throws(() => decodeInput(new Uint8Array(b)), CodecError)
    assert.throws(() => decodeInput('not binary'), CodecError)
  })
  it('snapshot: round-trip у межах квантування', () => {
    const snap = buildSnapshot(sampleWorld(), asTick(42), asSeq(17))
    const back = decodeSnapshot(encodeSnapshot(snap))
    assert.equal(back.tick, 42)
    assert.equal(back.ack, 17)
    assert.equal(back.entities.length, snap.entities.length)
    snap.entities.forEach((e, i) => {
      const d = back.entities[i]
      assert.ok(d)
      assert.equal(d.id, e.id)
      assert.equal(d.kind, e.kind)
      assert.ok(Math.abs(d.x - e.x) < 0.001 && Math.abs(d.y - e.y) < 0.001)
      if (
        (e.kind === 'ship' || e.kind === 'asteroid') &&
        (d.kind === 'ship' || d.kind === 'asteroid')
      ) {
        const diff = Math.atan2(Math.sin(d.angle - e.angle), Math.cos(d.angle - e.angle))
        assert.ok(Math.abs(diff) <= 0.00006, `${e.kind} angle`)
      }
      if (e.kind === 'ship' && d.kind === 'ship') assert.equal(d.hp, e.hp)
      if (e.kind === 'pickup' && d.kind === 'pickup') assert.equal(d.effect, e.effect)
    })
  })
  it('snapshot: обрізаний буфер → CodecError, а не RangeError', () => {
    const buf = encodeSnapshot(buildSnapshot(sampleWorld(), asTick(1), asSeq(1)))
    assert.throws(() => decodeSnapshot(buf.slice(0, buf.byteLength - 3)), CodecError)
  })
  it('JSON-кодек + схема Zod: той самий знімок після round-trip', () => {
    const snap = buildSnapshot(sampleWorld(), asTick(5), asSeq(3))
    const text = codecs.json.encodeSnapshot(snap)
    assert.equal(typeof text, 'string')
    const parsed = SnapshotMessage.safeParse(JSON.parse(String(text)))
    assert.ok(parsed.success)
    assert.deepEqual(parsed.data, JSON.parse(JSON.stringify(snap)))
  })
})

describe('protocol (Zod)', () => {
  it('приймає валідні повідомлення, обрізає пробіли й відкидає зайві поля', () => {
    const r = ClientMessage.safeParse({
      v: 1,
      type: 'join',
      room: 'classic',
      name: ' Ann ',
      admin: true,
    })
    assert.ok(r.success)
    assert.deepEqual(r.data, { v: 1, type: 'join', room: 'classic', name: 'Ann' })
  })
  it('відкидає мутації валідного повідомлення', () => {
    const valid = { v: 1, type: 'input', seq: 1, thrust: true, turn: 0, fire: false }
    assert.ok(ClientMessage.safeParse(valid).success)
    const mutations: unknown[] = [
      { ...valid, turn: 1000 },
      { ...valid, seq: -1 },
      { ...valid, seq: 1.5 },
      { ...valid, thrust: 'yes' },
      { ...valid, v: 2 },
      { ...valid, type: 'teleport' },
      { ...valid, type: '__proto__' },
      null,
      [valid],
    ]
    for (const m of mutations)
      assert.equal(ClientMessage.safeParse(m).success, false, JSON.stringify(m))
  })
})
