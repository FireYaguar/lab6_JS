import { z } from 'zod'

// Пайплайн ассетів: кожен завантажувач приймає AbortSignal, мережеві збої повторюються з backoff.
// Lab 6: manifest.json і sprites.json — теж дані з мережі, тому проходять схеми Zod (ручний validateAtlas видалено).

export class HttpError extends Error {
  readonly status: number
  readonly url: string
  constructor(url: string, status: number) {
    super(`HTTP ${status}: ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

// Звук не завантажився — знаємо, ЯКИЙ саме (замість Object.assign(error, { asset }) з Lab 3)
export class AssetError extends Error {
  readonly asset: string
  constructor(asset: string, cause: unknown) {
    super(`${asset}: ${cause instanceof Error ? cause.name : String(cause)}`, { cause })
    this.name = 'AssetError'
    this.asset = asset
  }
}

const Frame = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
})
export const Atlas = z.object({
  image: z.string(),
  scale: z.number().positive(),
  asteroidRadiusPx: z.number().positive(),
  frames: z
    .record(z.string(), Frame)
    .refine(
      (f) => ['ship_player', 'ship_enemy', 'bullet', 'asteroid_0'].every((k) => k in f),
      'atlas: missing frames',
    ),
})
export type Atlas = z.infer<typeof Atlas>
export const Manifest = z.object({
  sprites: z.object({ atlas: z.string(), image: z.string() }),
  sounds: z.record(z.string(), z.string()).default({}),
})
export type Manifest = z.infer<typeof Manifest>

export interface Sprites {
  readonly atlas: Atlas
  readonly image: HTMLImageElement
}
export interface Assets extends Sprites {
  readonly sounds: ReadonlyMap<string, AudioBuffer>
  readonly warnings: readonly string[]
}

interface RequestOptions {
  signal?: AbortSignal
}

// fetch вирішується, щойно прийшли заголовки, і НЕ відхиляється на 404/500 — перевіряємо ok самі.
export async function fetchOk(url: string, { signal }: RequestOptions = {}): Promise<Response> {
  const res = await fetch(url, { signal: signal ?? null })
  if (!res.ok) throw new HttpError(url, res.status)
  return res
}

// Тіло — другий асинхронний крок; битий JSON → SyntaxError. res.json() дає any — повертаємо unknown.
export async function fetchJson(url: string, options?: RequestOptions): Promise<unknown> {
  const res = await fetchOk(url, options)
  const data: unknown = await res.json()
  return data
}

// unknown → T: схема — єдиний спосіб перетворити дані з мережі на типізоване значення.
export async function loadJson<T>(
  url: string,
  schema: z.ZodType<T>,
  options?: RequestOptions,
): Promise<T> {
  return schema.parse(await fetchJson(url, options))
}

// Колбек-API Image загорнуто в проміс: однаковий порядок і для кешу, і для мережі.
function decodeImage(blob: Blob, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const src = URL.createObjectURL(blob)
    const onAbort = (): void => {
      cleanup()
      img.src = ''
      reject(signal?.reason)
    }
    const cleanup = (): void => {
      URL.revokeObjectURL(src)
      signal?.removeEventListener('abort', onAbort)
    }
    img.onload = () => {
      cleanup()
      resolve(img)
    }
    img.onerror = () => {
      cleanup()
      const err = new Error('image decode failed')
      err.name = 'DecodeError'
      reject(err)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    img.src = src
  })
}

// Через fetch, а не голий img.src: так видно HTTP-статус (404 не ретраїмо, 503 — так).
export async function loadImage(
  url: string,
  { signal }: RequestOptions = {},
): Promise<HTMLImageElement> {
  const res = await fetchOk(url, { signal })
  return decodeImage(await res.blob(), signal)
}

export async function loadAudio(
  audioCtx: AudioContext,
  url: string,
  { signal }: RequestOptions = {},
): Promise<AudioBuffer> {
  const res = await fetchOk(url, { signal })
  const data = await res.arrayBuffer()
  signal?.throwIfAborted()
  return audioCtx.decodeAudioData(data) // декодуємо зараз, а не на першому пострілі
}

// ---------- retry ----------

// err: unknown — у JS нічого не заважає кинути рядок; TS змушує це врахувати
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 // 4xx не виправиться повтором
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return false // скасував користувач
  if (err.name === 'TimeoutError') return true
  return err instanceof TypeError // мережевий збій fetch
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const id = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  timeoutMs?: number
  signal?: AbortSignal | undefined
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void
}

// fn(signal) викликається до `attempts` разів; кожна спроба має свій таймаут.
// Пауза: baseMs · 2^(спроба−1) · випадковий множник 0.5…1.5 (jitter — щоб клієнти не стукали хором).
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  { attempts = 3, baseMs = 250, timeoutMs = 3000, signal, onRetry }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(timeoutMs)
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      return await fn(attemptSignal)
    } catch (err: unknown) {
      if (signal?.aborted) throw signal.reason
      if (attempt >= attempts || !isRetryable(err)) throw err
      const delay = baseMs * 2 ** (attempt - 1) * (0.5 + Math.random())
      onRetry?.(err, attempt, delay)
      await sleep(delay, signal)
    }
  }
}

// ---------- усі ассети ----------

export interface Progress {
  done: number
  total: number
  label: string
  error?: unknown
}

export interface LoadAllOptions {
  audioCtx: AudioContext
  onProgress?: (p: Progress) => void
  signal?: AbortSignal
  retry?: Omit<RetryOptions, 'signal'>
}

// Спрайти критичні (Promise.all: без корабля немає гри), звуки — ні (allSettled: гра стартує без них).
// Прогрес рахуємо самі: голий Promise.all мовчить до кінця.
export async function loadAll(
  manifest: Manifest,
  { audioCtx, onProgress = () => {}, signal, retry = {} }: LoadAllOptions,
): Promise<Assets> {
  const soundEntries = Object.entries(manifest.sounds)
  const total = 2 + soundEntries.length
  let done = 0
  // дженерик: track повертає той самий тип, що й переданий проміс
  const track = <T>(label: string, promise: Promise<T>): Promise<T> =>
    promise.then(
      (value) => {
        done += 1
        onProgress({ done, total, label })
        return value
      },
      (error: unknown) => {
        done += 1
        onProgress({ done, total, label, error })
        throw error
      },
    )
  const load = <T>(fn: (s: AbortSignal) => Promise<T>): Promise<T> =>
    withRetry(fn, { signal, ...retry })

  const critical = Promise.all([
    track(
      'atlas',
      load((s) => loadJson(manifest.sprites.atlas, Atlas, { signal: s })),
    ),
    track(
      'sprites',
      load((s) => loadImage(manifest.sprites.image, { signal: s })),
    ),
  ])
  const optional = Promise.allSettled(
    soundEntries.map(([name, url]) =>
      track(
        name,
        load((s) => loadAudio(audioCtx, url, { signal: s })),
      ).then(
        (buffer): [string, AudioBuffer] => [name, buffer],
        (error: unknown) => {
          throw new AssetError(name, error)
        },
      ),
    ),
  )

  const [[atlas, image], soundResults] = await Promise.all([critical, optional])
  const sounds = new Map<string, AudioBuffer>()
  const warnings: string[] = []
  for (const r of soundResults) {
    if (r.status === 'fulfilled') sounds.set(r.value[0], r.value[1])
    else if (r.reason instanceof AssetError)
      warnings.push(
        `звук "${r.reason.asset}" не завантажився: ${r.reason.cause instanceof Error ? r.reason.cause.name : '?'}`,
      )
  }
  return { atlas, image, sounds, warnings }
}
