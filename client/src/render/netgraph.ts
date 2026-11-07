// Netgraph: мережеві лічильники поверх гри (як HUD з Lab 1, тільки про мережу) + графік поправок за 3 с.

const W = 250

import type { NetGame } from '../net/netgame.ts'
import type { View } from './canvas.ts'

export function drawNetgraph(ctx: CanvasRenderingContext2D, view: View, net: NetGame): void {
  const { stats: s, settings: o } = net
  const now = performance.now()
  const age = s.snapshotAt ? now - s.snapshotAt : 0
  const lines = [
    `NET ${o.codec}  pred ${o.prediction ? 'on' : 'off'}${o.chaos ? '  CHAOS' : ''}`,
    `RTT        ${s.rtt.toFixed(0)} ms`,
    `snapshot   age ${age.toFixed(0)} ms  ${s.snapshotsPerSec}/s`,
    `down       ${(s.downBps / 1024).toFixed(2)} KB/s`,
    `up         ${(s.upBps / 1024).toFixed(2)} KB/s`,
    `pending    ${net.pending} input`,
    `correction ${s.correction.toFixed(2)} px  (max ${s.correctionMax.toFixed(2)})`,
    `interp     ${o.interpDelay} ms`,
    `netsim     ${o.lag}±${o.jitter} ms  drop ${(o.drop * 100).toFixed(0)}%`,
    `input→scr  ${s.inputLatency === null ? '—' : `${s.inputLatency.toFixed(0)} ms`}`,
  ]
  const x = view.width - W - 8
  const y = 8
  const h = lines.length * 16 + 58
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.fillRect(x, y, W, h)
  ctx.font = '12px ui-monospace, Menlo, Consolas, monospace'
  ctx.textBaseline = 'top'
  ctx.fillStyle = o.chaos ? '#ff9a9a' : '#9fd8ff'
  lines.forEach((line, i) => {
    ctx.fillText(line, x + 6, y + 6 + i * 16)
  })

  // графік поправок: висота = px (шкала до 10 px), ширина = 3 с
  const gx = x + 6
  const gy = y + h - 46
  const gw = W - 12
  const gh = 40
  ctx.strokeStyle = 'rgba(255,255,255,0.2)'
  ctx.strokeRect(gx, gy, gw, gh)
  ctx.fillStyle = '#ffd35a'
  for (const [t, px] of s.corrections) {
    const cx = gx + gw - ((now - t) / 3000) * gw
    const ch = Math.min(gh, (px / 10) * gh)
    ctx.fillRect(cx, gy + gh - ch, 2, Math.max(1, ch))
  }
  ctx.fillStyle = '#9ab'
  ctx.fillText('corrections, 3 s (0–10 px)', gx + 2, gy + 2)
}
