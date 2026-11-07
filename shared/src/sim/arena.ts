import { Vector2 } from './vector.ts'

// Арена фіксованого розміру у «світових» пікселях — не залежить від розміру вікна.
// Двоє гравців з різними моніторами (Lab 5) мають жити в одному світі.

export interface Arena {
  readonly width: number
  readonly height: number
}

export function createArena(width = 1600, height = 900): Arena {
  return { width, height }
}

function wrapValue(v: number, size: number): number {
  return ((v % size) + size) % size
}

// «Загортання» країв: вилетів праворуч — з’явився ліворуч. Повертає нову точку.
export function wrap(p: Vector2, arena: Arena): Vector2 {
  return new Vector2(wrapValue(p.x, arena.width), wrapValue(p.y, arena.height))
}

// lerp з урахуванням загортання: якщо між станами стрибок через край,
// не тягнемо корабель через усю арену, а малюємо поточну позицію.
export function lerpWrapped(a: number, b: number, t: number, size: number): number {
  if (Math.abs(b - a) > size / 2) return b
  return a + (b - a) * t
}
