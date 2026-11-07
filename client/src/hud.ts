import type { Bus } from 'shared/bus.ts'
import type { Ship } from 'shared/sim/ship.ts'
import type { Effect } from 'shared/sim/types.ts'
import type { WorldEvents } from 'shared/sim/world.ts'

// HUD-логіка: рядки стану + короткі повідомлення з подій (+10, «Щит!», «Влучання»).
// Як і audio.ts, слухає шину подій; симуляція цей модуль не імпортує.

const MESSAGE_MS = 1600
// Record<Effect, …>: новий ефект без підпису → помилка tsc, а не undefined на екрані
const EFFECT_NAMES: Record<Effect, string> = {
  shield: 'Щит!',
  rapid: 'Швидка стрільба!',
  homing: 'Самонавідні кулі!',
}

export interface Hud {
  lines(world: { readonly size: number }): string[]
}

export function createHud(bus: Bus<WorldEvents>, player: Ship): Hud {
  const messages: { text: string; until: number }[] = []
  const push = (text: string): void => {
    messages.push({ text, until: performance.now() + MESSAGE_MS })
    if (messages.length > 4) messages.shift()
  }

  bus.on('scored', (e) => {
    if (e.shipId === player.id) push(`+${e.points}`)
  })
  bus.on('hit', (e) => {
    if (e.targetId !== player.id) return
    push(e.blocked ? 'щит відбив удар' : `влучання −${e.damage}`)
  })
  bus.on('picked', (e) => {
    if (e.shipId === player.id) push(EFFECT_NAMES[e.effect])
  })

  function effects(): string {
    const list: string[] = []
    if (player.shield > 0) list.push(`shield ${player.shield.toFixed(1)}`)
    if (player.rapid > 0) list.push(`rapid ${player.rapid.toFixed(1)}`)
    if (player.homingShots > 0) list.push(`homing ${player.homingShots.toFixed(1)}`)
    return list.join(' ') || '—'
  }

  return {
    lines(world) {
      const now = performance.now()
      while (messages.length && (messages[0]?.until ?? 0) < now) messages.shift()
      return [
        `${player.name}  score ${player.score}`,
        player.solid ? `hp       ${player.hp}` : `respawn  ${player.respawnIn.toFixed(1)} s`,
        `effects  ${effects()}`,
        `entities ${world.size}`,
        ...messages.map((m) => `» ${m.text}`),
      ]
    },
  }
}
