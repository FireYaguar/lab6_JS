// Branded-типи: у рантаймі це звичайні числа, але компілятор їх розрізняє.
// tick не можна передати туди, де чекають seq, а seq — туди, де чекають id сутності.

declare const BRAND: unique symbol
export type Brand<T, B extends string> = T & { readonly [BRAND]: B }

export type EntityId = Brand<number, 'EntityId'>
export type Tick = Brand<number, 'Tick'>
export type Seq = Brand<number, 'Seq'>

function brand<T extends Brand<number, string>>(n: number): T {
  return n as T // as №1: бренд існує лише для компілятора — тут число свідомо «стає» id/tick/seq
}

export const asEntityId = (n: number): EntityId => brand<EntityId>(n)
export const asTick = (n: number): Tick => brand<Tick>(n)
export const asSeq = (n: number): Seq => brand<Seq>(n)
