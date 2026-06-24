import { Hono } from 'hono'
import { serve } from '@hono/node-server'

const app = new Hono()

app.get('/', (c) =>
  c.text('hello from velox on Railway 🚀 — Linux + JavaScriptCore (WebKitGTK)\n'),
)

app.get('/info', (c) =>
  c.json({
    runtime: 'velox',
    platform: process.platform, // expect "linux" on Railway
    arch: process.arch,
    versions: process.versions,
    uptime: process.uptime(),
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

const port = Number(process.env.PORT) || 3000
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`velox + hono listening on 0.0.0.0:${info.port}`)
})
