// Lab 1, M4: «зламай навмисно і поміряй». Основний код (loop.js) не змінено —
// поломки живуть тут і вмикаються параметром URL:
//   ?exp=block            — busy-wait 100 мс у render кожен 60-й кадр
//   ?exp=interval         — setInterval(frame, 16) замість requestAnimationFrame
//   ?exp=variable         — змінний крок: simulate(dt) один раз на кадр, без акумулятора
//   &auto=1               — автопілот: газ + поворот затиснуті, через 5 с симуляції лог позиції
//   ?exp=this-bug         — Lab 2: ship.fire переданий «голим» у слухач і в setTimeout
//   ?exp=this-fix         — Lab 2: той самий виклик через bind (клавіша F)
// Звіт пишеться в console і в window.__exp.

import type { Command } from 'shared/sim/types.ts'
import type { LocalGame } from '../local-game.ts'
import { createLoop, createStats, type Loop, type LoopOptions, type Stats } from '../loop.ts'

export interface ExperimentReport {
  exp: string
  auto: boolean
  position?: { simTime: number; x: number; y: number; vx: number; vy: number }
  stats?: Stats
  frameIntervals?: ReturnType<typeof summarize>
  stepsPerSec?: number
  framesPerSec?: number
}

const AUTO_COMMAND: Command = { thrust: true, turn: 1, fire: false } // газ + поворот праворуч
const AUTO_SECONDS = 5
const REPORT_AFTER_MS = 10_000

function summarize(samples: Float64Array, count: number) {
  const xs = Array.from(samples.subarray(0, count)).sort((a, b) => a - b)
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  const std = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length)
  const pick = (p: number): number =>
    xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? Number.NaN
  const r = (x: number | undefined): number => Number((x ?? Number.NaN).toFixed(2))
  return {
    frames: xs.length,
    meanMs: r(mean),
    stdMs: r(std),
    minMs: r(xs[0]),
    p50Ms: r(pick(0.5)),
    p95Ms: r(pick(0.95)),
    maxMs: r(xs[xs.length - 1]),
  }
}

export function createExperimentLoop(params: URLSearchParams, game: LocalGame): Loop {
  const exp = params.get('exp') ?? 'fixed'
  const auto = params.get('auto') === '1'
  const report: ExperimentReport = { exp, auto }
  window.__exp = report
  game.hud.push(`exp: ${exp}${auto ? ' + auto' : ''}`)

  let simTime = 0
  let autoDone = false
  const simulate = (dt: number): void => {
    if (auto && !autoDone) {
      game.simulate(dt, AUTO_COMMAND)
      simTime += dt
      if (simTime >= AUTO_SECONDS - 1e-9) {
        autoDone = true
        const { x, y } = game.player.pos
        const { x: vx, y: vy } = game.player.vel
        report.position = { simTime, x, y, vx, vy }
        console.log('[auto] after', simTime.toFixed(4), 's:', report.position)
        game.hud.push(`pos @${simTime.toFixed(3)}s: ${x.toFixed(3)}, ${y.toFixed(3)}`)
      }
    } else {
      game.simulate(dt, auto ? { thrust: false, turn: 0, fire: false } : undefined)
    }
  }

  if (exp === 'this-bug') {
    // fire використовує this. Передаємо функцію, а не виклик → this визначає той, хто викликає.
    const ship = game.player
    // Lab 6: з fire(this: Ship) TypeScript ловить ЛИШЕ голий виклик (нижче, @ts-expect-error).
    // addEventListener і setTimeout він пропускає: DOM-перевантаження з EventListener і параметр Function
    // у setTimeout приймають будь-яку функцію — типи тут не рятують, потрібна стрілка або bind.
    window.addEventListener('keydown', ship.fire) // this = window → !window.solid → тихо null
    window.addEventListener('keydown', function (this: Window) {
      console.log('[this-bug] this у слухачі === window:', this === window)
    })
    setTimeout(function (this: Window) {
      console.log('[this-bug] this у setTimeout === window:', this === window)
    })
    setTimeout(ship.fire) // те саме: браузер кличе таймер з this = window → тихо null
    const bare = ship.fire
    try {
      // @ts-expect-error — голий виклик: this = void, а не Ship
      bare() // голий виклик у strict-коді класу → this = undefined
    } catch (e: unknown) {
      if (e instanceof Error) console.log('[this-bug] голий виклик:', e.constructor.name, e.message)
    }
  }
  if (exp === 'this-fix') {
    const fire = game.player.fire.bind(game.player) // this прибито до корабля назавжди
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyF') return
      const bullet = fire()
      if (bullet) game.world.spawn(bullet)
      console.log('[this-fix] fire() →', bullet ? `куля #${bullet.id}` : 'null (кулдаун)')
    })
  }

  let loop: Loop
  if (exp === 'interval') loop = createIntervalLoop({ simulate, render: game.render })
  else if (exp === 'variable') loop = createVariableLoop({ simulate, render: game.render })
  else if (exp === 'block') {
    let frame = 0
    const render = (alpha: number, stats: Stats): void => {
      frame += 1
      if (frame % 60 === 0) {
        const t = performance.now()
        while (performance.now() < t + 100) {} // синхронний блок: стек зайнятий 100 мс
      }
      game.render(alpha, stats)
    }
    loop = createLoop({ simulate, render })
  } else loop = createLoop({ simulate, render: game.render })

  report.stats = loop.stats
  setTimeout(() => {
    report.frameIntervals = summarize(loop.stats.samples, loop.stats.sampleCount)
    report.stepsPerSec = loop.stats.stepsPerSec
    report.framesPerSec = loop.stats.framesPerSec
    console.log(`[exp ${exp}] last ${REPORT_AFTER_MS / 1000}s:`, report.frameIntervals)
  }, REPORT_AFTER_MS)
  return loop
}

// Експеримент 2: та сама логіка з акумулятором, але кадри б’є таймер, а не rAF.
function createIntervalLoop({ step = 1 / 60, simulate, render }: LoopOptions): Loop {
  const stats = createStats()
  let accumulator = 0
  let last = 0
  let id = 0
  function frame() {
    const now = performance.now()
    const intervalMs = last === 0 ? 16 : now - last
    last = now
    accumulator += Math.min(intervalMs / 1000, 0.25)
    while (accumulator >= step) {
      simulate(step)
      stats.countStep()
      accumulator -= step
    }
    render(accumulator / step, stats)
    stats.countFrame(now, intervalMs, performance.now() - now)
  }
  return {
    stats,
    start: () => {
      id = setInterval(frame, 16)
    },
    stop: () => clearInterval(id),
  }
}

// Експеримент 3: змінний крок — один simulate(dt) на кадр, dt = реальний час кадру.
function createVariableLoop({ simulate, render }: LoopOptions): Loop {
  const stats = createStats()
  let last = 0
  let id = 0
  function frame(now: number): void {
    const workStart = performance.now()
    const intervalMs = last === 0 ? 1000 / 60 : now - last
    last = now
    simulate(intervalMs / 1000)
    stats.countStep()
    render(1, stats) // інтерполювати нема між чим: стан уже «на зараз»
    stats.countFrame(now, intervalMs, performance.now() - workStart)
    id = requestAnimationFrame(frame)
  }
  return {
    stats,
    start: () => {
      id = requestAnimationFrame(frame)
    },
    stop: () => cancelAnimationFrame(id),
  }
}
