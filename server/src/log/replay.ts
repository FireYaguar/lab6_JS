import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ID = /^[\w-]{1,100}$/ // лише літери/цифри/_/- → жодних «../» у шляху

export function replayPath(dir: string, id: string): string | null {
  return ID.test(id) ? join(dir, `${id}.ndjson`) : null
}

// Асинхронний генератор: файл читається рядок за рядком, у пам’яті — лише поточний шматок.
// JSON.parse повертає any — віддаємо unknown: хто читає повтор, той і перевіряє форму.
export async function* readReplay(file: string): AsyncGenerator<unknown> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line) {
      const record: unknown = JSON.parse(line)
      yield record
    }
  }
}

export interface ReplayInfo {
  id: string
  bytes: number
  modified: string
}

export async function listReplays(dir: string): Promise<ReplayInfo[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err: unknown) {
    // catch дає unknown: перш ніж читати .code, перевіряємо, що це справді помилка Node
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return []
    throw err
  }
  const files = names.filter((n) => n.endsWith('.ndjson'))
  return Promise.all(
    files.map(async (name) => {
      const { size, mtime } = await stat(join(dir, name))
      return { id: name.slice(0, -'.ndjson'.length), bytes: size, modified: mtime.toISOString() }
    }),
  )
}
