// DOM-помічники без приведень типів: querySelector повертає Element | null, а instanceof звужує
// до потрібного класу. Замість `as HTMLInputElement` — перевірка в рантаймі з зрозумілою помилкою.

export function query<T extends Element>(
  root: ParentNode,
  selector: string,
  type: abstract new (...args: never[]) => T,
): T {
  const el = root.querySelector(selector)
  if (!(el instanceof type)) throw new Error(`UI: «${selector}» не знайдено або не ${type.name}`)
  return el
}

// Дані з мережі (імена, кімнати, чат) → не HTML
export const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
