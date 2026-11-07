// `npm run dev`: сервер (node --watch) і клієнт (Vite) разом. Ctrl+C зупиняє обидва.
import { spawn } from 'node:child_process'

const shell = process.platform === 'win32' // npm на Windows — це npm.cmd
const children = ['server', 'client'].map((workspace) =>
  spawn('npm', ['run', 'dev', '-w', workspace], { stdio: 'inherit', shell }),
)
const stop = (signal) => {
  for (const child of children) if (child.exitCode === null) child.kill(signal)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
for (const child of children) {
  child.on('exit', (code) => {
    if (code) process.exitCode = code
    stop('SIGTERM')
  })
}
