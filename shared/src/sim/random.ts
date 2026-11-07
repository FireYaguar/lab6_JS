// Детермінований PRNG (mulberry32). У симуляції — лише він, ніколи Math.random():
// однаковий seed → однакова гра на клієнті й сервері (Lab 5).

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function range(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min)
}

// noUncheckedIndexedAccess: items[i] — це T | undefined, тому порожній масив треба обробити явно
export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)]
  if (item === undefined) throw new RangeError('pick from empty array')
  return item
}
