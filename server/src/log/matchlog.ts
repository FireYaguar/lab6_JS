import { on } from 'node:events'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Room } from '../rooms.ts'

// Об’єкти подій → рядки NDJSON (один JSON на рядок). Object mode на вході, байти на виході.
export class NdjsonEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true })
  }

  override _transform(
    event: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      callback(null, `${JSON.stringify(event)}\n`)
    } catch (err: unknown) {
      callback(err instanceof Error ? err : new Error(String(err))) // напр. циклічне посилання
    }
  }
}

// Лог матчу: події кімнати → NDJSON → файл, через pipeline (backpressure, помилки й закриття — автоматично).
// Повертає шлях і проміс, що вирішується, коли все дописано на диск (подія 'matchEnd').
export function startMatchLog(room: Room, dir: string): { file: string; done: Promise<void> } {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${room.id}-${stamp}.ndjson`)
  // on() підписується ОДРАЗУ (не ліниво в генераторі) — жодна подія між стартом і першим read не загубиться
  const events = on(room, 'event', { close: ['matchEnd'] })
  const source = Readable.from(
    (async function* (): AsyncGenerator<unknown> {
      // events.on у @types/node віддає any[] — одразу звужуємо до unknown, щоб any не поширився
      for await (const args of events) {
        const record: unknown = args[0]
        yield record
      }
    })(),
  )
  const done = pipeline(source, new NdjsonEncoder(), createWriteStream(file))
  return { file, done }
}
