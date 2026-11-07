import { esc, query } from '../ui/dom.ts'
import type { Connection, ConnectionStatus } from './connection.ts'

// Панель кімнати: статус з’єднання, список гравців, чат. Лише слухає події Connection.

const MAX_LINES = 8

function statusText(s: ConnectionStatus): string {
  switch (s.state) {
    case 'connecting':
      return 'підключення…'
    case 'open':
      return 'онлайн'
    case 'reconnecting':
      return `зв’язок втрачено, повтор через ${(s.delay / 1000).toFixed(1)} с`
    case 'closed':
      return `закрито (${s.code}${s.reason ? `: ${s.reason}` : ''})`
  }
}

export function mountChat(root: HTMLElement, conn: Connection): void {
  const panel = document.createElement('div')
  panel.className = 'panel chat'
  panel.innerHTML = `
    <div class="chat-status"></div>
    <div class="chat-roster"></div>
    <ul class="chat-log"></ul>
    <input class="chat-input" maxlength="200" placeholder="Enter — написати в чат" />`
  root.append(panel)
  const status = query(panel, '.chat-status', HTMLElement)
  const roster = query(panel, '.chat-roster', HTMLElement)
  const log = query(panel, '.chat-log', HTMLUListElement)
  const input = query(panel, '.chat-input', HTMLInputElement)
  const lines: string[] = []

  function addLine(html: string): void {
    lines.push(html)
    if (lines.length > MAX_LINES) lines.shift()
    log.innerHTML = lines.map((l) => `<li>${l}</li>`).join('')
  }

  conn.on('status', (s) => {
    status.textContent = statusText(s)
    status.dataset.state = s.state
  })
  conn.on('roster', (m) => {
    roster.textContent = `У кімнаті: ${m.players.map((p) => p.name).join(', ')}`
  })
  conn.on('chat', (m) => addLine(`<b>${esc(m.from.name)}:</b> ${esc(m.text)}`))
  conn.on('system', (m) => addLine(`<i>${esc(m.text)}</i>`))
  conn.on('shutdown', () => addLine('<i>сервер перезапускається…</i>'))

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      conn.send({ type: 'chat', text: input.value.trim() })
      input.value = ''
    }
    if (e.key === 'Escape' || e.key === 'Enter') input.blur() // повернути клавіатуру грі
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target !== input) {
      e.preventDefault()
      input.focus()
    }
  })
}
