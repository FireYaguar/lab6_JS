import type { Command, Turn } from 'shared/sim/types.ts'

// Клавіатура як замикання: стан клавіш приватний, назовні — лише функції.

export interface Input {
  isDown(code: string): boolean
  justPressed(code: string): boolean
  consume(): void // викликати після кожного кроку симуляції, щоб «щойно натиснуто» спрацювало рівно один раз
  dispose(): void
}

export function createInput(target: Window = window): Input {
  const down = new Set<string>()
  const pressed = new Set<string>() // натиснуті з моменту останнього consume()

  // текстові поля (чат, ім’я) — не керування кораблем
  const typing = (e: KeyboardEvent): boolean =>
    e.target instanceof Element && e.target.closest('input, textarea') !== null

  function onKeyDown(e: KeyboardEvent): void {
    if (e.repeat || typing(e)) return // ОС шле повторні keydown, поки клавіша затиснута
    down.add(e.code)
    pressed.add(e.code)
  }
  function onKeyUp(e: KeyboardEvent): void {
    down.delete(e.code)
  }
  function onBlur(): void {
    // вікно втратило фокус — keyup може не прийти, інакше корабель «залипне» з газом
    down.clear()
    pressed.clear()
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    consume: () => pressed.clear(),
    dispose() {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
    },
  }
}

// Клавіші → команда для симуляції. Сим бачить лише { thrust, turn, fire }, не знає про клавіатуру.
// TS знайшов: раніше turn рахувався як (right ? 1 : 0) - (left ? 1 : 0), тобто number — а протокол приймає лише −1 | 0 | 1.
export function readControls(input: Input): Command {
  const left = input.isDown('ArrowLeft') || input.isDown('KeyA')
  const right = input.isDown('ArrowRight') || input.isDown('KeyD')
  const turn: Turn = left === right ? 0 : right ? 1 : -1
  return {
    thrust: input.isDown('ArrowUp') || input.isDown('KeyW'),
    turn,
    fire: input.isDown('Space'), // затиснув — стріляє з кулдауном (Ship.fire)
  }
}
