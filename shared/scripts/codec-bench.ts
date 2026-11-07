// JSON vs бінарний: розмір знімка/input і час encode+decode на реалістичному світі (4 кораблі, що стріляють).
// Запуск: npm run bench -w shared
// З Lab 6 «decode» для JSON = JSON.parse + перевірка схемою Zod (так клієнт і робить), для бінарного — DataView.
import { asSeq, asTick } from '../src/brand.ts'
import { decodeSnapshot } from '../src/net/binary.ts'
import { type CodecName, codecs } from '../src/net/codec.ts'
import { STEP, SUBSTEPS, TICK_RATE } from '../src/net/constants.ts'
import { type InputMessage, SnapshotMessage } from '../src/net/protocol.ts'
import { buildSnapshot } from '../src/net/snapshot.ts'
import { createArena } from '../src/sim/arena.ts'
import { Ship } from '../src/sim/ship.ts'
import type { Command } from '../src/sim/types.ts'
import { World } from '../src/sim/world.ts'

const world = new World(createArena(), 2026, { asteroids: 6 })
const ships = [0, 1, 2, 3].map((i) => world.spawn(new Ship({ x: 250 + i * 350, y: 450 })))
for (let i = 0; i < 5; i++) world.spawnAsteroid()
const NAMES: readonly CodecName[] = ['json', 'binary']
const sizes: Record<CodecName, number[]> = { json: [], binary: [] }
const timings: Record<CodecName, number[]> = { json: [], binary: [] }
const bytes = (data: ArrayBuffer | string): number =>
  typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
const decode = (data: ArrayBuffer | string): unknown =>
  typeof data === 'string' ? SnapshotMessage.parse(JSON.parse(data)) : decodeSnapshot(data)

for (let tick = 1; tick <= 900; tick++) {
  for (const [i, s] of ships.entries()) {
    const turn = ((Math.floor(tick / 45) + i) % 3) - 1
    const cmd: Command = {
      seq: asSeq(tick),
      thrust: (tick + i * 20) % 60 < 30,
      turn: turn === -1 ? -1 : turn === 0 ? 0 : 1,
      fire: tick % 4 === i,
    }
    for (let k = 0; k < SUBSTEPS; k++) world.applyInput(s, cmd, STEP)
  }
  for (let k = 0; k < SUBSTEPS; k++) world.stepOthers(STEP)
  const snap = buildSnapshot(world, asTick(tick), asSeq(tick))
  for (const name of NAMES) {
    const t0 = process.hrtime.bigint()
    decode(codecs[name].encodeSnapshot(snap))
    const us = Number(process.hrtime.bigint() - t0) / 1000
    if (tick > 300) {
      sizes[name].push(bytes(codecs[name].encodeSnapshot(snap)))
      timings[name].push(us) // перші 300 тіків — прогрів JIT
    }
  }
}

const med = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
const input: InputMessage = {
  v: 1,
  type: 'input',
  seq: asSeq(123456),
  thrust: true,
  fire: false,
  turn: 1,
}
console.log(`світ: ${world.size} сутностей у кінці; 600 знімків після прогріву`)
for (const name of NAMES) {
  const avg = mean(sizes[name])
  const inputBytes = bytes(codecs[name].encodeInput(input))
  console.log(
    `${name.padEnd(6)} знімок: середнє ${avg.toFixed(0)} Б (min ${Math.min(...sizes[name])}, max ${Math.max(...sizes[name])}) → ${((avg * TICK_RATE) / 1024).toFixed(2)} KB/s вниз; ` +
      `input ${inputBytes} Б → ${((inputBytes * TICK_RATE) / 1024).toFixed(2)} KB/s вгору; encode+decode медіана ${med(timings[name]).toFixed(1)} µs`,
  )
}
