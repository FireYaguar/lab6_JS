// Допоміжне для скриптів замірів: підняти сервер окремим процесом і дочекатися /health.
import { type ChildProcess, spawn } from 'node:child_process'

export interface RunningServer {
  base: string
  child: ChildProcess
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>
}

export async function startServer(
  port: number,
  env: Record<string, string> = {},
): Promise<RunningServer> {
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    base,
    child,
    // SIGTERM → чекаємо 'exit' і повертаємо код та час
    async stop() {
      const t0 = performance.now()
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
        child.once('exit', (code, signal) => r({ code, signal })),
      )
      child.kill('SIGTERM')
      return { ...(await exited), ms: Math.round(performance.now() - t0) }
    },
  }
}
