import { createServer, type Server } from 'node:http'
import type { ServerConfig } from './config.ts'
import { createHttpHandler } from './http.ts'
import { log, setLogLevel } from './log.ts'
import { RoomManager } from './rooms.ts'
import { attachWebSocket, type WebSocketHub } from './ws.ts'

export interface App {
  readonly server: Server
  readonly rooms: RoomManager
  readonly hub: WebSocketHub
  listen(): Promise<number>
  shutdown(): Promise<void>
}

// Збирає сервер з частин. Окремо від index.ts, щоб тести могли підняти його на випадковому порту.
export function createApp(config: ServerConfig): App {
  setLogLevel(config.logLevel)
  const rooms = new RoomManager(config)
  rooms.createDefaults()
  const server = createServer(createHttpHandler({ config, rooms }))
  server.on('clientError', (err, socket) => socket.destroy(err)) // кривий HTTP від клієнта ≠ падіння
  const hub = attachWebSocket(server, { config, rooms })

  return {
    server,
    rooms,
    hub,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject) // EADDRINUSE тощо
        server.listen(config.port, config.host, () => {
          const address = server.address()
          // address() — string | AddressInfo | null; для TCP-сервера це AddressInfo, але TS цього не знає
          const port = typeof address === 'object' && address !== null ? address.port : config.port
          log('info', 'server.listening', { host: config.host, port })
          resolve(port)
        })
      })
    },
    // Порядок: перестати приймати → попередити й закрити сокети → дописати логи матчів.
    async shutdown() {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeIdleConnections()
      await hub.close()
      await rooms.closeAll()
      server.closeAllConnections()
      await stopped
    },
  }
}
