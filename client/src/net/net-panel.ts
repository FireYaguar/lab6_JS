import type { CodecName } from 'shared/net/codec.ts'
import { query } from '../ui/dom.ts'
import type { Connection } from './connection.ts'

// Панель «штучної мережі» (dev): затримка, розкид, втрата — сервер застосовує до цього з’єднання;
// затримка інтерполяції, передбачення, звірка, експеримент з Math.random() — живуть на клієнті.

export interface NetSettings {
  codec: CodecName
  prediction: boolean
  reconcile: boolean
  chaos: boolean
  interpDelay: number
  lag: number
  jitter: number
  drop: number
}

type NumberKey = 'interpDelay' | 'lag' | 'jitter' | 'drop'
type BoolKey = 'prediction' | 'reconcile' | 'chaos'
const NUMBER_KEYS: readonly string[] = [
  'interpDelay',
  'lag',
  'jitter',
  'drop',
] satisfies NumberKey[]
const BOOL_KEYS: readonly string[] = ['prediction', 'reconcile', 'chaos'] satisfies BoolKey[]

// data-key з DOM — це string; type guard звужує його до ключа налаштувань (замість settings[key as …])
const isNumberKey = (k: string | undefined): k is NumberKey =>
  k !== undefined && NUMBER_KEYS.includes(k)
const isBoolKey = (k: string | undefined): k is BoolKey => k !== undefined && BOOL_KEYS.includes(k)

export function readNetSettings(params: URLSearchParams): NetSettings {
  const num = (k: string, def: number): number => (params.has(k) ? Number(params.get(k)) : def)
  return {
    codec: params.get('codec') === 'json' ? 'json' : 'binary',
    prediction: params.get('pred') !== '0',
    reconcile: params.get('reconcile') !== '0',
    chaos: params.get('chaos') === '1',
    interpDelay: num('interp', 100),
    lag: num('lag', 0),
    jitter: num('jitter', 0),
    drop: num('drop', 0),
  }
}

export function netQuery(s: NetSettings): string {
  return `codec=${s.codec}&lag=${s.lag}&jitter=${s.jitter}&drop=${s.drop}`
}

export function mountNetPanel(root: HTMLElement, conn: Connection, settings: NetSettings): void {
  const panel = document.createElement('div')
  panel.className = 'panel net-panel'
  const slider = (key: NumberKey, label: string, max: number, step = 1, scale = 1): string => `
    <label>${label} <output data-out="${key}">${Math.round(settings[key] * scale)}</output>
      <input type="range" data-key="${key}" min="0" max="${max}" step="${step}" value="${settings[key] * scale}" data-scale="${scale}" /></label>`
  const check = (key: BoolKey, label: string): string =>
    `<label class="row"><input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}/> ${label}</label>`
  panel.innerHTML = `
    <b>netsim</b>
    ${slider('lag', 'lag, ms', 400, 10)}
    ${slider('jitter', 'jitter ±ms', 150, 5)}
    ${slider('drop', 'drop, %', 20, 1, 100)}
    ${slider('interpDelay', 'interp, ms', 300, 10)}
    ${check('prediction', 'prediction')}
    ${check('reconcile', 'reconciliation')}
    ${check('chaos', 'Math.random() у predict')}
    <label class="row">codec
      <select data-codec>
        <option value="binary" ${settings.codec === 'binary' ? 'selected' : ''}>binary</option>
        <option value="json" ${settings.codec === 'json' ? 'selected' : ''}>json</option>
      </select></label>`
  root.append(panel)

  const syncServer = (): void =>
    conn.send({ type: 'netsim', lag: settings.lag, jitter: settings.jitter, drop: settings.drop })
  panel.addEventListener('input', (e) => {
    const el = e.target
    if (!(el instanceof HTMLInputElement)) return
    const key = el.dataset.key
    if (isBoolKey(key)) settings[key] = el.checked
    else if (isNumberKey(key)) {
      settings[key] = Number(el.value) / Number(el.dataset.scale ?? 1)
      const out = panel.querySelector(`[data-out="${key}"]`)
      if (out) out.textContent = el.value
      if (key !== 'interpDelay') syncServer()
    }
  })
  query(panel, '[data-codec]', HTMLSelectElement).addEventListener('change', (e) => {
    if (!(e.target instanceof HTMLSelectElement)) return
    // кодек обирається при підключенні — перезавантажуємо з параметром
    const params = new URLSearchParams(location.search)
    params.set('codec', e.target.value)
    location.search = params.toString()
  })
}
