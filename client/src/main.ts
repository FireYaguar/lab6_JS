import type { RoomInfo } from 'shared/net/protocol.ts'
import { type Assets, HttpError, loadAll, loadJson, Manifest, withRetry } from './assets/loader.ts'
import { connectAudio, createAudio } from './audio.ts'
import { createHud } from './hud.ts'
import { createInput } from './input.ts'
import { Lobby, type LobbyEvents } from './lobby/lobby.ts'
import { showLobby } from './lobby/lobby-view.ts'
import { createLocalGame } from './local-game.ts'
import { createLoop } from './loop.ts'
import { mountChat } from './net/chat-view.ts'
import { Connection, wsUrl } from './net/connection.ts'
import { mountNetPanel, netQuery, readNetSettings } from './net/net-panel.ts'
import { createNetGame } from './net/netgame.ts'
import { setupCanvas } from './render/canvas.ts'
import { drawHud, drawScene } from './render/draw.ts'
import { drawLoading, type LoadingState } from './render/loading.ts'
import { drawNetgraph } from './render/netgraph.ts'
import { query } from './ui/dom.ts'

const params = new URLSearchParams(location.search)
const ui = query(document, '#ui', HTMLElement) // getElementById дає HTMLElement | null — query звужує або кидає
const { ctx, view } = setupCanvas(query(document, '#game', HTMLCanvasElement))
const audio = createAudio()
// ?fault=… / ?slow=1 / ?exp=loadtime — галерея збоїв і заміри (README, Lab 3). Без параметрів не вантажиться.
const dev =
  params.has('fault') || params.has('slow') || params.get('exp') === 'loadtime'
    ? await import('./dev/faults.ts')
    : null

// AudioContext стартує лише після жесту гравця
const unlockAudio = (): void => void audio.unlock()
window.addEventListener('pointerdown', unlockAudio, { once: true })
window.addEventListener('keydown', unlockAudio, { once: true })

// ---------- UI-кнопки під екраном завантаження ----------
function actionButton(label: string, onClick: () => void): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ui-actions'
  const btn = document.createElement('button')
  btn.textContent = label
  btn.addEventListener('click', onClick, { once: true })
  box.append(btn)
  ui.append(box)
  return box
}

function clickOnce(label: string): Promise<void> {
  return new Promise((resolve) => {
    const box = actionButton(label, () => {
      box.remove()
      resolve()
    })
  })
}

// err: unknown — до Lab 6 тут було err.name / err.status на чому завгодно
function describe(err: unknown): string {
  if (err instanceof HttpError) return `Сервер відповів ${err.status}: ${err.url}`
  if (!(err instanceof Error)) return String(err)
  switch (err.name) {
    case 'AbortError':
      return 'Завантаження скасовано'
    case 'TimeoutError':
      return 'Таймаут мережі (сервер не відповів вчасно)'
    case 'SyntaxError':
      return `Битий JSON: ${err.message}`
    case 'ZodError':
      return 'Дані не відповідають схемі (manifest / атлас)'
    case 'TypeError':
      return `Мережа недоступна або невірні дані: ${err.message}`
    default:
      return `${err.name}: ${err.message}`
  }
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'Error')

// ---------- 1. Ассети: гра не стартує, поки не готові; збій → Retry ----------
async function loadManifest(signal: AbortSignal): Promise<Manifest> {
  const manifest = await withRetry(
    (s) => loadJson('assets/manifest.json', Manifest, { signal: s }),
    { signal },
  )
  return dev ? dev.applyFaults(manifest, params) : manifest
}

// TS знайшов: у Lab 5 ця функція повертала АБО ассети, АБО { manifest } (режим замірів) — і далі
// код читав assets.sounds, не перевіривши, яка з двох форм прийшла. Тепер режим замірів — окремо.
async function loadAssets(): Promise<Assets> {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController()
    const cancel = actionButton('Скасувати', () => controller.abort())
    let state: LoadingState = { done: 0, total: 1, label: 'manifest' }
    drawLoading(ctx, view, state)
    dev?.armAutoAbort(params, controller, attempt)
    try {
      const manifest = await loadManifest(controller.signal)
      return await loadAll(manifest, {
        audioCtx: audio.ctx,
        signal: controller.signal,
        retry: {
          onRetry: (err, n, ms) =>
            console.info(`[retry] ${errorName(err)} → спроба ${n + 1} через ${Math.round(ms)} мс`),
        },
        onProgress: (p) => {
          if (controller.signal.aborted) return // запізнілі відмови сусідів після abort — не перемальовувати
          state = {
            ...p,
            label: p.error === undefined ? p.label : `${p.label}: ${errorName(p.error)}`,
          }
          drawLoading(ctx, view, state)
        },
      })
    } catch (err: unknown) {
      // Promise.all уже відхилився, але сусідні завантаження ще біжать — зупиняємо їх
      controller.abort()
      cancel.remove()
      console.warn('[loading] failed:', err)
      drawLoading(ctx, view, { ...state, color: '#ff6b6b', lines: [describe(err)] })
      await clickOnce('Retry')
    } finally {
      cancel.remove()
    }
  }
}

// ---------- 2. Лобі ----------
function chooseRoom(notes: readonly string[]): Promise<LobbyEvents['join']> {
  const lobby = new Lobby({ url: dev?.lobbyUrl(params) ?? 'api/rooms' })
  if (!params.has('room')) return showLobby(ui, lobby, notes)
  // ?room=classic&name=… — автоматичний вхід (для експериментів і тестів)
  const joined = lobby.once('join')
  void lobby.once('rooms').then(() => lobby.join(params.get('room'), params.get('name') ?? 'pilot'))
  lobby.enter()
  return joined
}

// ---------- 3. Мережева гра (Lab 5) ----------
function startNetGame(room: RoomInfo, name: string, assets: Assets): void {
  // світ рахує сервер; клієнт шле input, передбачає себе, інтерполює решту
  const settings = readNetSettings(params)
  const conn = new Connection(wsUrl(`/ws?${netQuery(settings)}`))
  conn.on('open', () => conn.send({ type: 'join', room: room.id, name })) // і після реконекту
  const net = createNetGame({ conn, room, name, input: createInput(window), settings })
  const hud = createHud(net.bus, net.me)
  connectAudio(net.bus, audio, net.me.id)
  mountChat(ui, conn)
  if (import.meta.env.DEV || params.has('netpanel')) mountNetPanel(ui, conn, settings)
  conn.connect()
  window.__net = net // для замірів (README)

  createLoop({
    step: 1 / 30, // тік клієнта = тік сервера: один input на тік
    simulate: () => net.simulate(),
    render(alpha, stats) {
      drawScene(ctx, view, net.arena, net.items(alpha), assets, performance.now() / 1000)
      drawHud(ctx, stats, [`room     ${room.name}`, ...hud.lines({ size: net.entityCount })])
      drawNetgraph(ctx, view, net)
    },
  }).start()
}

// ---------- старт ----------
const exp = params.get('exp')
if (exp === 'determinism') {
  // та сама функція, що в Node-тесті shared/: однаковий input → однаковий хеш
  const { runDeterminism } = await import('shared/sim/selftest.ts')
  const result = runDeterminism(Number(params.get('steps') ?? 1000), 2026, {
    trace: params.has('trace'),
  })
  window.__determinism = result
  console.log('[determinism]', result)
  drawLoading(ctx, view, {
    done: 1,
    total: 1,
    label: 'determinism',
    lines: [`hash ${result.hash}`, navigator.userAgent.split(' ').at(-2) ?? ''],
  })
} else if (exp === 'loadtime' && dev) {
  const manifest = await loadManifest(new AbortController().signal)
  await dev.runLoadTiming(manifest, audio.ctx, (lines) =>
    drawLoading(ctx, view, { done: 1, total: 1, label: 'load timing', lines }),
  )
} else {
  const assets = await loadAssets()
  audio.setBuffers(assets.sounds)
  ctx.fillStyle = '#05060c'
  ctx.fillRect(0, 0, view.width, view.height)
  // попередження (напр. «звук не завантажився») показуються в лобі — гра все одно стартує
  const { room, name } = await chooseRoom(assets.warnings)
  void audio.unlock() // клік «Join» — жест користувача

  if (exp !== null || params.has('auto') || params.has('offline')) {
    // Локальний режим (Lab 1–3). ?exp=… — навмисні поломки й баг з this.
    const game = createLocalGame(ctx, view, room, name, assets, audio)
    const { createExperimentLoop } = await import('./dev/experiments.ts')
    createExperimentLoop(params, game).start()
  } else {
    startNetGame(room, name, assets)
  }
}
