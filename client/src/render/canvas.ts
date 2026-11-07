// Canvas з урахуванням devicePixelRatio: буфер у фізичних пікселях, малюємо в CSS-пікселях.

export interface View {
  width: number
  height: number
  dpr: number
}

export function setupCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D
  view: View
} {
  const maybeCtx = canvas.getContext('2d')
  if (!maybeCtx) throw new Error('Canvas 2D недоступний') // getContext повертає null, якщо контекст не створити
  const ctx: CanvasRenderingContext2D = maybeCtx // окрема const — звуження гарантовано видно в замиканні resize
  const view: View = { width: 0, height: 0, dpr: 1 }

  function resize() {
    const dpr = window.devicePixelRatio || 1
    const { width, height } = canvas.getBoundingClientRect()
    view.width = width
    view.height = height
    view.dpr = dpr
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // 1 одиниця = 1 CSS-піксель
  }

  resize()
  window.addEventListener('resize', resize)
  return { ctx, view }
}
