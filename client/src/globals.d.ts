// Дані для замірів і тестів (Playwright читає їх з window). Оголошення лише для компілятора.
import type { DeterminismResult } from 'shared/sim/selftest.ts'
import type { ExperimentReport } from './dev/experiments.ts'
import type { LoadTiming } from './dev/faults.ts'
import type { NetGame } from './net/netgame.ts'

declare global {
  interface Window {
    __net?: NetGame
    __exp?: ExperimentReport
    __determinism?: DeterminismResult
    __loadtime?: LoadTiming
  }
}
