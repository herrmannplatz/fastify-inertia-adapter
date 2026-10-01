import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import Fastify, { type FastifyInstance } from 'fastify'
import inertia, {
  always,
  deepMerge,
  defer,
  merge,
  once,
  optional,
  prepend,
  scroll,
  type InertiaPluginOptions,
} from '../src/index.js'

const TEMPLATE = '<!DOCTYPE html><html><head>@inertiaHead</head><body>@inertia</body></html>'
const INERTIA = { 'x-inertia': 'true', 'x-requested-with': 'XMLHttpRequest', 'x-inertia-version': '1' }

async function build (
  opts: Partial<InertiaPluginOptions> = {},
  routes?: (app: FastifyInstance) => void
): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(inertia, { rootView: TEMPLATE, version: '1', ...opts })
  routes?.(app)
  await app.ready()
  return app
}

function pageFromHtml (html: string) {
  const match = html.match(/<script data-page="app" type="application\/json">(.*?)<\/script>/)
  assert.ok(match, 'page script missing')
  return JSON.parse(match[1]!)
}

describe('responses', () => {
  it('renders HTML on the first visit with slash-escaped JSON', async () => {
    const app = await build({}, (app) =>
      app.get('/events/80', (_req, reply) => reply.inertia('Event', { event: { id: 80, html: '</script><b>' } }))
    )
    const res = await app.inject({ url: '/events/80' })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] as string, /text\/html/)
    assert.equal(res.headers.vary, 'X-Inertia')
    assert.ok(res.body.includes('"url":"\\/events\\/80"'))
    assert.ok(!res.body.includes('</script><b>'))
    assert.ok(res.body.includes('<div id="app"></div>'))
    const page = pageFromHtml(res.body)
    assert.deepEqual(page.props, { errors: {}, event: { id: 80, html: '</script><b>' } })
    assert.equal(page.component, 'Event')
    assert.equal(page.version, '1')
  })

  it('returns JSON for Inertia requests', async () => {
    const app = await build({}, (app) => app.get('/x', (_r, reply) => reply.inertia('X', { a: 1 })))
    const res = await app.inject({ url: '/x?y=2', headers: INERTIA })
    assert.equal(res.headers['x-inertia'], 'true')
    assert.equal(res.headers.vary, 'X-Inertia')
    assert.match(res.headers['content-type'] as string, /application\/json/)
    const page = res.json()
    assert.deepEqual(page.props, { errors: {}, a: 1 })
    assert.equal(page.url, '/x?y=2')
    assert.deepEqual(page.sharedProps, ['errors'])
  })

  it('renders a default root view with extra head markup', async () => {
    const app = Fastify()
    await app.register(inertia, { head: '<link rel="icon" href="/favicon.ico">' })
    app.get('/', (_req, reply) => reply.inertia('Home', { a: 1 }))
    const res = await app.inject('/')
    assert.match(res.body, /^<!DOCTYPE html>/)
    assert.match(res.body, /<meta name="viewport"[^>]*>\n {4}<link rel="icon" href="\/favicon.ico">\n {2}<\/head>/)
    assert.match(res.body, /<body>\n {4}<script data-page="app" type="application\/json">.*"component":"Home".*<\/script><div id="app"><\/div>\n {2}<\/body>/)
  })

  it('supports a rootView function with viewData', async () => {
    const app = await build(
      { rootView: ({ body, viewData }) => `<title>${viewData.title}</title>${body}` },
      (app) => app.get('/', (_r, reply) => reply.inertia('Home', {}, { viewData: { title: 'Hi' } }))
    )
    const res = await app.inject({ url: '/' })
    assert.ok(res.body.startsWith('<title>Hi</title><script data-page="app"'))
  })

  it('resolves lazy and nested async values', async () => {
    const app = await build({}, (app) =>
      app.get('/', (_r, reply) =>
        reply.inertia('Home', { a: () => 1, b: Promise.resolve(2), c: { d: async () => 3 }, e: [() => 4] })
      )
    )
    const page = (await app.inject({ url: '/', headers: INERTIA })).json()
    assert.deepEqual(page.props, { errors: {}, a: 1, b: 2, c: { d: 3 }, e: [4] })
  })

  it('handles history encryption flags', async () => {
    const app = await build({ encryptHistory: true }, (app) => {
      app.get('/a', (_r, reply) => reply.inertia('A'))
      app.get('/b', (_r, reply) => reply.inertia.clearHistory().encryptHistory(false).render('B'))
    })
    assert.equal((await app.inject({ url: '/a', headers: INERTIA })).json().encryptHistory, true)
    const b = (await app.inject({ url: '/b', headers: INERTIA })).json()
    assert.equal(b.encryptHistory, undefined)
    assert.equal(b.clearHistory, true)
  })
})

describe('asset versioning', () => {
  it('returns 409 with location on version mismatch for GET', async () => {
    const app = await build({ version: () => 'v2' }, (app) => app.get('/e', (_r, reply) => reply.inertia('E')))
    const res = await app.inject({ url: '/e?x=1', headers: { ...INERTIA, 'x-inertia-version': 'v1', host: 'example.com' } })
    assert.equal(res.statusCode, 409)
    assert.equal(res.headers['x-inertia-location'], 'http://example.com/e?x=1')
    assert.equal(res.headers['x-inertia-version'], 'v2')
    assert.equal(res.headers['x-inertia'], undefined)
  })

  it('does not 409 for non-GET requests', async () => {
    const app = await build({ version: 'v2' }, (app) => app.post('/e', (_r, reply) => reply.inertia('E')))
    const res = await app.inject({ method: 'POST', url: '/e', headers: { ...INERTIA, 'x-inertia-version': 'v1' } })
    assert.equal(res.statusCode, 200)
  })

  it('does not 409 for regular browser requests', async () => {
    const app = await build({ version: 'v2' }, (app) => app.get('/e', (_r, reply) => reply.inertia('E')))
    assert.equal((await app.inject({ url: '/e' })).statusCode, 200)
  })
})

describe('partial reloads', () => {
  const routes = (app: FastifyInstance) =>
    app.get('/', (_r, reply) =>
      reply.inertia('Users', {
        users: ['a'],
        companies: ['b'],
        lazy: optional(() => 'lazy'),
        auth: { user: { name: 'J' }, token: 'secret', roles: ['admin'] },
        stats: always(() => 'always'),
      })
    )

  it('skips optional props on full visits', async () => {
    const app = await build({}, routes)
    const page = (await app.inject({ url: '/', headers: INERTIA })).json()
    assert.deepEqual(Object.keys(page.props).sort(), ['auth', 'companies', 'errors', 'stats', 'users'])
  })

  it('filters with only, keeping always props', async () => {
    const app = await build({}, routes)
    const page = (
      await app.inject({
        url: '/',
        headers: { ...INERTIA, 'x-inertia-partial-component': 'Users', 'x-inertia-partial-data': 'users,lazy' },
      })
    ).json()
    assert.deepEqual(page.props, { errors: {}, users: ['a'], lazy: 'lazy', stats: 'always' })
  })

  it('filters with except (always props are immune)', async () => {
    const app = await build({}, routes)
    const page = (
      await app.inject({
        url: '/',
        headers: { ...INERTIA, 'x-inertia-partial-component': 'Users', 'x-inertia-partial-except': 'users,stats,errors' },
      })
    ).json()
    assert.deepEqual(Object.keys(page.props).sort(), ['auth', 'companies', 'errors', 'lazy', 'stats'])
  })

  it('applies only then except', async () => {
    const app = await build({}, routes)
    const page = (
      await app.inject({
        url: '/',
        headers: {
          ...INERTIA,
          'x-inertia-partial-component': 'Users',
          'x-inertia-partial-data': 'users,companies',
          'x-inertia-partial-except': 'companies',
        },
      })
    ).json()
    assert.deepEqual(Object.keys(page.props).sort(), ['errors', 'stats', 'users'])
  })

  it('supports dot-notation paths', async () => {
    const app = await build({}, routes)
    const page = (
      await app.inject({
        url: '/',
        headers: {
          ...INERTIA,
          'x-inertia-partial-component': 'Users',
          'x-inertia-partial-data': 'auth.user,auth.token',
          'x-inertia-partial-except': 'auth.token',
        },
      })
    ).json()
    assert.deepEqual(page.props.auth, { user: { name: 'J' } })
    assert.equal(page.props.users, undefined)
  })

  it('ignores partial headers for a different component', async () => {
    const app = await build({}, routes)
    const page = (
      await app.inject({
        url: '/',
        headers: { ...INERTIA, 'x-inertia-partial-component': 'Other', 'x-inertia-partial-data': 'users' },
      })
    ).json()
    assert.ok('companies' in page.props)
    assert.ok(!('lazy' in page.props))
  })
})

describe('deferred props', () => {
  const routes = (app: FastifyInstance) =>
    app.get('/', (_r, reply) =>
      reply.inertia('Posts', {
        user: 'J',
        comments: defer(() => ['c']),
        analytics: defer(() => 1),
        related: defer(() => ['r'], 'sidebar'),
        permissions: defer(() => {
          throw new Error('boom')
        }).rescue(),
      })
    )

  it('announces deferred props grouped on full visits', async () => {
    const app = await build({}, routes)
    const page = (await app.inject({ url: '/', headers: INERTIA })).json()
    assert.deepEqual(page.props, { errors: {}, user: 'J' })
    assert.deepEqual(page.deferredProps, {
      default: ['comments', 'analytics', 'permissions'],
      sidebar: ['related'],
    })
  })

  it('resolves deferred props on partial reloads and rescues failures', async () => {
    const app = await build({}, routes)
    const page = (
      await app.inject({
        url: '/',
        headers: {
          ...INERTIA,
          'x-inertia-partial-component': 'Posts',
          'x-inertia-partial-data': 'comments,analytics,permissions',
        },
      })
    ).json()
    assert.deepEqual(page.props, { errors: {}, comments: ['c'], analytics: 1 })
    assert.deepEqual(page.rescuedProps, ['permissions'])
    assert.equal(page.deferredProps, undefined)
  })

  it('fails the response for non-rescued deferred props', async () => {
    const app = await build({}, (app) =>
      app.get('/', (_r, reply) =>
        reply.inertia('P', {
          x: defer(() => {
            throw new Error('nope')
          }),
        })
      )
    )
    const res = await app.inject({
      url: '/',
      headers: { ...INERTIA, 'x-inertia-partial-component': 'P', 'x-inertia-partial-data': 'x' },
    })
    assert.equal(res.statusCode, 500)
  })
})

describe('merge props', () => {
  it('emits merge metadata', async () => {
    const app = await build({}, (app) =>
      app.get('/', (_r, reply) =>
        reply.inertia('Feed', {
          posts: merge([{ id: 1 }]).matchOn('id'),
          notifications: prepend([{ id: 2 }], 'id'),
          conversations: deepMerge({ data: [] }, 'data.id'),
          lazyPosts: defer(() => []).merge(),
        })
      )
    )
    const page = (await app.inject({ url: '/', headers: INERTIA })).json()
    assert.deepEqual(page.mergeProps, ['posts'])
    assert.deepEqual(page.prependProps, ['notifications'])
    assert.deepEqual(page.deepMergeProps, ['conversations'])
    assert.deepEqual(page.matchPropsOn, ['posts.id', 'notifications.id', 'conversations.data.id'])
    assert.deepEqual(page.deferredProps, { default: ['lazyPosts'] })
  })

  it('omits merge labels for reset props', async () => {
    const app = await build({}, (app) => app.get('/', (_r, reply) => reply.inertia('Feed', { posts: merge([1]) })))
    const page = (
      await app.inject({
        url: '/',
        headers: {
          ...INERTIA,
          'x-inertia-partial-component': 'Feed',
          'x-inertia-partial-data': 'posts',
          'x-inertia-reset': 'posts',
        },
      })
    ).json()
    assert.deepEqual(page.props.posts, [1])
    assert.equal(page.mergeProps, undefined)
  })
})

describe('once props', () => {
  const routes = (app: FastifyInstance) => {
    app.get('/plans', (_r, reply) =>
      reply.inertia('Plans', { plans: once(() => ['basic']), rates: once(() => [1], { key: 'fx', expiresAt: 1000 }) })
    )
    app.get('/fresh', (_r, reply) => reply.inertia('Fresh', { plans: once(() => ['new']).fresh() }))
  }

  it('resolves and announces once props', async () => {
    const app = await build({}, routes)
    const page = (await app.inject({ url: '/plans', headers: INERTIA })).json()
    assert.deepEqual(page.props.plans, ['basic'])
    assert.deepEqual(page.onceProps, {
      plans: { prop: 'plans', expiresAt: null },
      fx: { prop: 'rates', expiresAt: 1000 },
    })
  })

  it('skips once props the client already has', async () => {
    const app = await build({}, routes)
    const page = (
      await app.inject({ url: '/plans', headers: { ...INERTIA, 'x-inertia-except-once-props': 'plans,fx' } })
    ).json()
    assert.deepEqual(page.props, { errors: {} })
    assert.deepEqual(Object.keys(page.onceProps), ['plans', 'fx'])
  })

  it('ignores except-once on partial reloads and for fresh props', async () => {
    const app = await build({}, routes)
    const partial = (
      await app.inject({
        url: '/plans',
        headers: {
          ...INERTIA,
          'x-inertia-except-once-props': 'plans',
          'x-inertia-partial-component': 'Plans',
          'x-inertia-partial-data': 'plans',
        },
      })
    ).json()
    assert.deepEqual(partial.props.plans, ['basic'])
    const fresh = (await app.inject({ url: '/fresh', headers: { ...INERTIA, 'x-inertia-except-once-props': 'plans' } })).json()
    assert.deepEqual(fresh.props.plans, ['new'])
  })

  it('computes expiresAt from ttl', async () => {
    const app = await build({}, (app) => app.get('/', (_r, reply) => reply.inertia('T', { x: once(1, { ttl: 60 }) })))
    const page = (await app.inject({ url: '/', headers: INERTIA })).json()
    assert.ok(Math.abs(page.onceProps.x.expiresAt - (Date.now() + 60_000)) < 2000)
  })
})

describe('infinite scroll', () => {
  const routes = (app: FastifyInstance) =>
    app.get('/', (_r, reply) =>
      reply.inertia('Posts', {
        posts: scroll(() => ({ data: [{ id: 1 }], meta: { currentPage: 1, nextPage: 2, previousPage: null } }), {
          matchOn: 'id',
        }),
      })
    )

  it('emits scrollProps and merge labels', async () => {
    const app = await build({}, routes)
    const page = (await app.inject({ url: '/', headers: INERTIA })).json()
    assert.deepEqual(page.mergeProps, ['posts.data'])
    assert.deepEqual(page.matchPropsOn, ['posts.data.id'])
    assert.deepEqual(page.scrollProps, {
      posts: { pageName: 'page', previousPage: null, nextPage: 2, currentPage: 1, reset: false },
    })
  })

  it('prepends with the merge intent header and flags resets', async () => {
    const app = await build({}, routes)
    const prep = (
      await app.inject({ url: '/', headers: { ...INERTIA, 'x-inertia-infinite-scroll-merge-intent': 'prepend' } })
    ).json()
    assert.deepEqual(prep.prependProps, ['posts.data'])
    const reset = (await app.inject({ url: '/', headers: { ...INERTIA, 'x-inertia-reset': 'posts' } })).json()
    assert.equal(reset.mergeProps, undefined)
    assert.equal(reset.scrollProps.posts.reset, true)
  })
})

describe('shared props', () => {
  it('merges global and per-request shared props', async () => {
    const app = await build({ share: () => ({ appName: 'Demo', auth: { user: null } }) }, (app) => {
      app.addHook('preHandler', async (_req, reply) => {
        reply.inertia.share({ locale: 'de' })
      })
      app.get('/', (_r, reply) => reply.inertia('Home', { auth: { user: 'J' } }))
    })
    const page = (await app.inject({ url: '/', headers: INERTIA })).json()
    assert.deepEqual(page.props, { errors: {}, appName: 'Demo', auth: { user: 'J' }, locale: 'de' })
    assert.deepEqual(page.sharedProps, ['errors', 'appName', 'auth', 'locale'])
  })
})

describe('redirects', () => {
  const routes = (app: FastifyInstance) => {
    app.put('/u', (_r, reply) => reply.redirect('/users'))
    app.post('/u', (_r, reply) => reply.redirect('/users'))
    app.post('/frag', (_r, reply) => reply.redirect('/users#top'))
    app.get('/away', (_r, reply) => reply.inertia.location('https://github.com'))
    app.post('/back', (_r, reply) => reply.inertia.back())
  }

  it('converts 302 to 303 after PUT', async () => {
    const app = await build({}, routes)
    const res = await app.inject({ method: 'PUT', url: '/u', headers: INERTIA })
    assert.equal(res.statusCode, 303)
    const post = await app.inject({ method: 'POST', url: '/u', headers: INERTIA })
    assert.equal(post.statusCode, 302)
  })

  it('turns fragment redirects into 409 X-Inertia-Redirect', async () => {
    const app = await build({}, routes)
    const res = await app.inject({ method: 'POST', url: '/frag', headers: { ...INERTIA, host: 'example.com' } })
    assert.equal(res.statusCode, 409)
    assert.equal(res.headers['x-inertia-redirect'], 'http://example.com/users#top')
    assert.equal(res.headers.location, undefined)
    const prefetch = await app.inject({ method: 'POST', url: '/frag', headers: { ...INERTIA, purpose: 'prefetch' } })
    assert.equal(prefetch.statusCode, 302)
  })

  it('handles external locations', async () => {
    const app = await build({}, routes)
    const res = await app.inject({ url: '/away', headers: INERTIA })
    assert.equal(res.statusCode, 409)
    assert.equal(res.headers['x-inertia-location'], 'https://github.com')
    const browser = await app.inject({ url: '/away' })
    assert.equal(browser.statusCode, 302)
    assert.equal(browser.headers.location, 'https://github.com')
  })

  it('redirects back to the referer', async () => {
    const app = await build({}, routes)
    const res = await app.inject({ method: 'POST', url: '/back', headers: { ...INERTIA, referer: '/form' } })
    assert.equal(res.headers.location, '/form')
  })
})

describe('session: flash and validation errors', () => {
  async function sessionApp () {
    const app = Fastify()
    await app.register(fastifyCookie)
    await app.register(fastifySession, { secret: 'a'.repeat(32), cookie: { secure: false } })
    await app.register(inertia, { rootView: TEMPLATE, version: '1' })
    app.post('/users', (req, reply) => {
      const body = req.body as { name?: string }
      if (!body.name) return reply.inertia.withErrors({ name: 'The name field is required.' }).back()
      return reply.inertia.flash({ success: 'User created' }).redirect('/users')
    })
    app.get('/users', (_r, reply) => reply.inertia('Users/Index'))
    app.get('/form', (_r, reply) => reply.inertia('Users/Create'))
    await app.ready()
    return app
  }

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers['set-cookie']).split(';')[0]!

  it('flashes validation errors to the next page, once', async () => {
    const app = await sessionApp()
    const post = await app.inject({ method: 'POST', url: '/users', payload: {}, headers: { ...INERTIA, referer: '/form' } })
    assert.equal(post.statusCode, 302)
    const cookie = cookieOf(post)
    const next = (await app.inject({ url: '/form', headers: { ...INERTIA, cookie } })).json()
    assert.deepEqual(next.props.errors, { name: 'The name field is required.' })
    const again = (await app.inject({ url: '/form', headers: { ...INERTIA, cookie } })).json()
    assert.deepEqual(again.props.errors, {})
  })

  it('scopes errors to the error bag header', async () => {
    const app = await sessionApp()
    const post = await app.inject({ method: 'POST', url: '/users', payload: {}, headers: { ...INERTIA, referer: '/form' } })
    const cookie = cookieOf(post)
    const next = (
      await app.inject({ url: '/form', headers: { ...INERTIA, cookie, 'x-inertia-error-bag': 'createUser' } })
    ).json()
    assert.deepEqual(next.props.errors, { createUser: { name: 'The name field is required.' } })
  })

  it('exposes flash data on the next page and keeps it across a version 409', async () => {
    const app = await sessionApp()
    const post = await app.inject({ method: 'POST', url: '/users', payload: { name: 'J' }, headers: INERTIA })
    const cookie = cookieOf(post)
    const stale = await app.inject({ url: '/users', headers: { ...INERTIA, cookie, 'x-inertia-version': 'old' } })
    assert.equal(stale.statusCode, 409)
    const page = (await app.inject({ url: '/users', headers: { ...INERTIA, cookie } })).json()
    assert.deepEqual(page.flash, { success: 'User created' })
    const again = (await app.inject({ url: '/users', headers: { ...INERTIA, cookie } })).json()
    assert.equal(again.flash, undefined)
  })
})

describe('SSR', () => {
  it('uses the SSR server response', async () => {
    let received: any
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received = { url: req.url, page: JSON.parse(body) }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ head: ['<title>SSR</title>'], body: '<div data-server-rendered="true" id="app">hi</div>' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const app = await build({ ssr: { url: `http://127.0.0.1:${port}` } }, (app) =>
        app.get('/', (_r, reply) => reply.inertia('Home', { a: 1 }))
      )
      const res = await app.inject({ url: '/' })
      assert.equal(received.url, '/render')
      assert.equal(received.page.component, 'Home')
      assert.equal(
        res.body,
        '<!DOCTYPE html><html><head><title>SSR</title></head><body><div data-server-rendered="true" id="app">hi</div></body></html>'
      )
      // Inertia requests never hit SSR
      received = undefined
      await app.inject({ url: '/', headers: INERTIA })
      assert.equal(received, undefined)
    } finally {
      server.close()
    }
  })

  it('falls back to client-side rendering when SSR fails', async () => {
    let errored = false
    const app = await build(
      {
        ssr: {
          render: async () => {
            throw new Error('window is not defined')
          },
          onError: () => (errored = true),
        },
      },
      (app) => app.get('/', (_r, reply) => reply.inertia('Home'))
    )
    const res = await app.inject({ url: '/' })
    assert.equal(res.statusCode, 200)
    assert.ok(errored)
    assert.equal(pageFromHtml(res.body).component, 'Home')
  })
})
