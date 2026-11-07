import type { RoomInfo } from 'shared/net/protocol.ts'
import { esc, query } from '../ui/dom.ts'
import type { Lobby, LobbyEvents } from './lobby.ts'

// DOM лобі. Лише слухає події Lobby і викликає його методи; даних сам не тягне.

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

export function showLobby(
  root: HTMLElement,
  lobby: Lobby,
  notes: readonly string[] = [],
): Promise<LobbyEvents['join']> {
  root.innerHTML = `
    <div class="panel lobby">
      <h1>Spacefight</h1>
      <label>Ім’я пілота <input id="lobby-name" maxlength="16" value="pilot" /></label>
      <div class="rooms-head"><span>Кімнати</span><span id="lobby-status"></span></div>
      <ul id="lobby-rooms"></ul>
      <p id="lobby-error" class="error"></p>
      ${notes.map((n) => `<p class="warn">⚠ ${esc(n)}</p>`).join('')}
      <button id="lobby-join" type="button">Join</button>
    </div>`
  const status = query(root, '#lobby-status', HTMLElement)
  const list = query(root, '#lobby-rooms', HTMLUListElement)
  const error = query(root, '#lobby-error', HTMLElement)
  const nameInput = query(root, '#lobby-name', HTMLInputElement)
  const joinButton = query(root, '#lobby-join', HTMLButtonElement)
  let selected: string | null = null

  function renderRooms(rooms: readonly RoomInfo[]): void {
    if (!rooms.some((r) => r.id === selected)) selected = rooms[0]?.id ?? null
    list.innerHTML = rooms
      .map(
        (
          r,
        ) => `<li><label><input type="radio" name="room" value="${esc(r.id)}" ${r.id === selected ? 'checked' : ''} />
          <b>${esc(r.name)}</b> <span>${r.players}/${r.maxPlayers} · ${r.arena.width}×${r.arena.height} · астероїдів ${r.arena.asteroids}</span></label></li>`,
      )
      .join('')
  }

  // кожна підписка повертає функцію відписки — збираємо, щоб зняти всі разом
  const offs = [
    lobby.on('loading', () => {
      status.textContent = 'оновлення…'
    }),
    lobby.on('rooms', (rooms) => {
      status.textContent = `оновлено ${new Date().toLocaleTimeString()}`
      error.textContent = ''
      renderRooms(rooms)
    }),
    lobby.on('error', (err) => {
      status.textContent = 'помилка'
      error.textContent = `Не вдалося оновити список (${describe(err)}). Спробую ще раз автоматично.`
    }),
  ]
  const cleanup = new AbortController()
  list.addEventListener(
    'change',
    (e) => {
      if (e.target instanceof HTMLInputElement) selected = e.target.value // target — EventTarget | null, звужуємо
    },
    { signal: cleanup.signal },
  )
  joinButton.addEventListener(
    'click',
    () => {
      try {
        lobby.join(selected, nameInput.value)
      } catch (err: unknown) {
        error.textContent = err instanceof Error ? err.message : String(err)
      }
    },
    { signal: cleanup.signal },
  )

  // подія → проміс (одна подія, один раз): «дочекатися join»
  const joined = lobby.once('join').then((detail) => {
    for (const off of offs) off()
    cleanup.abort()
    root.innerHTML = ''
    return detail
  })
  lobby.enter()
  return joined
}
