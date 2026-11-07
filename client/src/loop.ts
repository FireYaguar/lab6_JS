// Ігровий цикл: rAF + акумулятор (Fix Your Timestep).
// Симуляція завжди йде кроком `step` (1/60 с), рендер — стільки разів, скільки герц у монітора.

const SAMPLE_COUNT = 600 // останні ~10 с інтервалів кадрів (знадобиться для p95/p99 у Lab 7)

// Лічильники для HUD: steps/s, frames/s, frame ms. Винесено окремо,
// щоб експерименти (src/dev/experiments.js) рахували так само.
export type Stats = ReturnType<typeof createStats>

export function createStats() {
  const samples = new Float64Array(SAMPLE_COUNT)
  let sampleIndex = 0
  let sampleCount = 0
  let steps = 0
  let frames = 0
  let windowStart = 0

  const stats = {
    stepsPerSec: 0,
    framesPerSec: 0,
    frameMs: 0, // інтервал між двома кадрами
    workMs: 0, // скільки JS працював усередині кадру
    totalSteps: 0,
    samples,
    get sampleCount() {
      return sampleCount
    },
    countStep() {
      steps += 1
      stats.totalSteps += 1
    },
    countFrame(now: number, intervalMs: number, workMs: number) {
      frames += 1
      stats.frameMs = intervalMs
      stats.workMs = workMs
      samples[sampleIndex] = intervalMs
      sampleIndex = (sampleIndex + 1) % SAMPLE_COUNT
      sampleCount = Math.min(sampleCount + 1, SAMPLE_COUNT)
      if (windowStart === 0) windowStart = now
      const elapsed = now - windowStart
      if (elapsed >= 1000) {
        stats.stepsPerSec = (steps * 1000) / elapsed
        stats.framesPerSec = (frames * 1000) / elapsed
        steps = 0
        frames = 0
        windowStart = now
      }
    },
  }
  return stats
}

export interface LoopOptions {
  step?: number
  maxFrame?: number
  simulate: (dt: number) => void
  render: (alpha: number, stats: Stats) => void
}
export interface Loop {
  readonly stats: Stats
  start(): void
  stop(): void
}

export function createLoop({
  step = 1 / 60,
  maxFrame = 0.25,
  simulate,
  render,
}: LoopOptions): Loop {
  const stats = createStats()
  let accumulator = 0
  let last = 0
  let rafId = 0
  let running = false

  function frame(now: number): void {
    if (!running) return
    const workStart = performance.now()
    const intervalMs = last === 0 ? step * 1000 : now - last
    last = now

    // clamp: після згорнутої вкладки не «надолужуємо» сотні кроків (спіраль смерті)
    accumulator += Math.min(intervalMs / 1000, maxFrame)
    while (accumulator >= step) {
      simulate(step)
      stats.countStep()
      accumulator -= step
    }

    render(accumulator / step, stats) // alpha ∈ [0, 1)
    stats.countFrame(now, intervalMs, performance.now() - workStart)
    rafId = requestAnimationFrame(frame)
  }

  return {
    stats,
    start() {
      if (running) return
      running = true
      last = 0
      rafId = requestAnimationFrame(frame)
    },
    stop() {
      running = false
      cancelAnimationFrame(rafId)
    },
  }
}
