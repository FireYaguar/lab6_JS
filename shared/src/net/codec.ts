import { encodeInput, encodeSnapshot } from './binary.ts'
import type { InputMessage, Snapshot } from './protocol.ts'

// Один інтерфейс, дві реалізації: бінарний (за замовчуванням) і JSON (текстові кадри, ?codec=json).
// Декодування не тут: бінарні кадри розбирає decodeInput/decodeSnapshot, JSON — схеми Zod.
export interface Codec {
  readonly name: CodecName
  encodeInput(input: InputMessage): ArrayBuffer | string
  encodeSnapshot(snapshot: Snapshot): ArrayBuffer | string
}
export type CodecName = 'binary' | 'json'

export const codecs: Record<CodecName, Codec> = {
  binary: { name: 'binary', encodeInput, encodeSnapshot },
  json: {
    name: 'json',
    encodeInput: (input) => JSON.stringify(input),
    encodeSnapshot: (snapshot) => JSON.stringify(snapshot),
  },
}
