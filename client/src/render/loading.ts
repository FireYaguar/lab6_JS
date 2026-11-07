// Екран завантаження на canvas: справжній прогрес (готово / всього), поточний файл, помилки.

import type { View } from './canvas.ts'

export interface LoadingState {
  done?: number
  total?: number
  label?: string
  lines?: readonly string[]
  color?: string
}

export function drawLoading(
  ctx: CanvasRenderingContext2D,
  view: View,
  { done = 0, total = 1, label = '', lines = [], color = '#9fffb0' }: LoadingState,
): void {
  const { width, height } = view
  ctx.fillStyle = '#05060c'
  ctx.fillRect(0, 0, width, height)
  const barW = Math.min(420, width * 0.7)
  const x = (width - barW) / 2
  const y = height / 2

  ctx.fillStyle = '#cfe3ff'
  ctx.font = 'bold 28px ui-monospace, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('SPACEFIGHT', width / 2, y - 48)

  ctx.strokeStyle = '#5aa0ff'
  ctx.lineWidth = 2
  ctx.strokeRect(x, y - 10, barW, 20)
  ctx.fillStyle = color
  ctx.fillRect(x + 3, y - 7, (barW - 6) * Math.min(1, done / total), 14)

  ctx.font = '14px ui-monospace, Menlo, Consolas, monospace'
  ctx.fillStyle = '#9ab'
  ctx.fillText(`${done}/${total}  ${label}`, width / 2, y + 34)
  ctx.fillStyle = '#ff9a9a'
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, y + 62 + i * 20)
  })
  ctx.textAlign = 'start'
}
