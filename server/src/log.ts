import type { LogLevel } from './config.ts'

// Мінімальний структурований лог: один JSON-рядок на подію в stdout (повноцінний pino — Lab 8).

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
let threshold = LEVELS.info

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level]
}

export function log(
  level: Exclude<LogLevel, 'silent'>,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < threshold) return
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields })
  ;(level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)
}

// catch (err: unknown): з unknown не можна просто взяти .message — спершу звузити
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
