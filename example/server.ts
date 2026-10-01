/**
 * Example: Fastify + Inertia v3 + Vite + Vue 3, with SSR.
 *
 * Dev:  `npm run example` — Vite runs inside Fastify (middleware mode), everything on :3000.
 * Prod: `npm run example:build`, then `NODE_ENV=production npm run example`.
 */
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import Fastify from 'fastify'
import inertia, { defer, merge, once, optional, scroll } from '../src/index.js'
import { inertiaVite } from '../src/vite.js'

type User = { id: number; name: string }

declare module 'fastify' {
  interface Session {
    user?: User
  }
}

const isProd = process.env.NODE_ENV === 'production'

const app = Fastify({ logger: true })

const vite = await inertiaVite(app, {
  root: import.meta.dirname,
  entry: 'client/app.ts',
  ssrEntry: 'client/ssr.ts',
})

await app.register(fastifyCookie)
await app.register(fastifySession, {
  secret: process.env.SESSION_SECRET ?? 'change-me-change-me-change-me-change-me',
  cookie: { secure: isProd },
})

await app.register(inertia, {
  version: vite.version,
  ssr: vite.ssr,
  head: vite.tags,
  share: (request) => ({
    appName: 'Demo',
    auth: { user: request.session.get('user') ?? null },
  }),
})

const users: User[] = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Linus' },
]

app.get('/', (_req, reply) => reply.inertia('Home', { greeting: 'Hello from Fastify' }))

app.get<{ Querystring: { page?: string } }>('/users', (req, reply) => {
  const page = Number(req.query.page ?? 1)
  return reply.inertia('Users/Index', {
    users: scroll(() => ({ data: users, meta: { currentPage: page, nextPage: null, previousPage: null } }), {
      matchOn: 'id',
    }),
    stats: defer(async () => ({ total: users.length })),
    countries: once(() => ['DE', 'FR', 'US'], { ttl: 3600 }),
    filters: optional(() => ({ roles: ['admin', 'user'] })),
    activity: merge(() => [{ id: 1, text: 'signed in' }]).matchOn('id'),
  })
})

app.get('/users/create', (_req, reply) => reply.inertia('Users/Create'))

app.post<{ Body: { name?: string } | undefined }>('/users', (req, reply) => {
  const { name } = req.body ?? {}
  if (!name) {
    return reply.inertia.withErrors({ name: 'The name field is required.' }).back('/users/create')
  }
  users.push({ id: users.length + 1, name })
  return reply.inertia.flash({ success: `Created ${name}` }).redirect('/users')
})

await app.listen({ port: Number(process.env.PORT ?? 3000) })
