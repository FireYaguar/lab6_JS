// Типізована шина подій. Ім’я події (K) пов’язане з формою payload (E[K]):
// bus.emit('hit', { damage: 10 }) не скомпілюється, якщо в 'hit' немає поля damage або бракує targetId.
// Замість EventTarget: у CustomEvent.detail тип any, а ще EventTarget немає в lib без DOM.

export type Listener<P> = (payload: P) => void

export class Bus<E extends Record<string, unknown>> {
  #listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {}

  on<K extends keyof E>(name: K, fn: Listener<E[K]>): () => void {
    const set = this.#listeners[name] ?? new Set<Listener<E[K]>>()
    this.#listeners[name] = set
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  once<K extends keyof E>(name: K): Promise<E[K]> {
    return new Promise((resolve) => {
      const off = this.on(name, (payload) => {
        off()
        resolve(payload)
      })
    })
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.#listeners[name]
    if (!set) return
    for (const fn of [...set]) fn(payload) // копія: слухач може відписатися під час обходу
  }
}
