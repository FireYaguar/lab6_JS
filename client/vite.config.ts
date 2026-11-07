import { type Connect, defineConfig, type Plugin } from 'vite'

// Dev-only middleware для галереї збоїв і замірів (працює у `vite` і `vite preview`):
//   ?delay=ms   — затримати відповідь (повільна мережа / таймаут)
//   ?corrupt=1  — віддати обрізаний JSON
//   ?flaky=N    — перші N запитів до цього шляху → 503 (перевірка retry з backoff)
function devFaults(): Plugin {
  const hits = new Map<string, number>()
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = url.searchParams
    if (!q.has('delay') && !q.has('corrupt') && !q.has('flaky')) return next()
    const respond = () => {
      if (q.has('corrupt')) {
        res.setHeader('Content-Type', 'application/json')
        res.end('{"image": "sprites.png", "frames": {"ship_pl')
        return
      }
      const flaky = Number(q.get('flaky') ?? 0)
      const n = flaky ? (hits.get(url.pathname) ?? 0) + 1 : 0
      if (flaky) hits.set(url.pathname, n)
      if (n > 0 && n <= flaky) {
        res.statusCode = 503
        res.end('busy')
        return
      }
      next()
    }
    const delay = Number(q.get('delay') ?? 0)
    if (delay > 0) setTimeout(respond, delay)
    else respond()
  }
  return {
    name: 'dev-faults',
    // без return: функція, повернута з хука, для Vite означає «post-hook»
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

// У розробці клієнт віддає Vite (:5173), а /api і /ws проксуються на Node-сервер (:3000).
// У production сервер сам віддає client/dist — один origin, без CORS.
const API = process.env.API_URL ?? 'http://localhost:3000'
const proxy = {
  '/api': API,
  '/health': API,
  '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
}

export default defineConfig({
  appType: 'mpa', // без SPA-fallback: неіснуючий файл → справжній 404, а не index.html
  plugins: [devFaults()],
  server: { proxy },
  preview: { proxy },
})
