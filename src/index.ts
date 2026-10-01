import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { applyTemplate, defaultRootView, pageMarkup } from './html.js'
import { always, isInertiaProp } from './props.js'
import { readHeader, resolveProps } from './resolver.js'
import { defaultSessionAdapter, hasSession } from './session.js'
import { normalizeSsrResult, renderViaServer } from './ssr.js'
import type {
  InertiaPluginOptions,
  InertiaReply,
  Page,
  Props,
  RenderOptions,
  SessionAdapter,
  SsrResult,
} from './types.js'

export * from './props.js'
export * from './types.js'
export { serializePage, pageMarkup, applyTemplate } from './html.js'
export { InertiaSsrError } from './ssr.js'

declare module 'fastify' {
  interface FastifyReply {
    inertia: InertiaReply
  }
}

const FLASH_KEY = '_inertia_flash'
const ERRORS_KEY = '_inertia_errors'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const kState = Symbol('inertia.state')
const kApi = Symbol('inertia.api')

interface RequestState {
  shared: Props
  flash: Record<string, unknown>
  errors: Record<string, Record<string, unknown>>
  encryptHistory?: boolean
  clearHistory: boolean
  preserveFragment: boolean
  version?: string
}

function isInertiaRequest (request: FastifyRequest): boolean {
  return readHeader(request.headers, 'x-inertia') === 'true'
}

function absoluteUrl (request: FastifyRequest, url: string): string {
  if (/^[a-z][a-z\d+\-.]*:/i.test(url) || url.startsWith('//')) return url
  const host = (request as any).host ?? request.hostname
  return `${request.protocol}://${host}${url.startsWith('/') ? '' : '/'}${url}`
}

function appendVary (current: unknown, value: string): string {
  const existing = String(current ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (existing.some((v) => v.toLowerCase() === value.toLowerCase() || v === '*')) return existing.join(', ')
  return [...existing, value].join(', ')
}

async function inertiaPlugin (fastify: FastifyInstance, options: InertiaPluginOptions) {
  options ??= {}

  const rootId = options.rootId ?? 'app'
  const session: SessionAdapter | null = options.session === false ? null : (options.session ?? defaultSessionAdapter)
  const customSession = Boolean(options.session)
  let warnedNoSession = false

  const state = (request: FastifyRequest): RequestState => {
    const r = request as any
    return (r[kState] ??= { shared: {}, flash: {}, errors: {}, clearHistory: false, preserveFragment: false })
  }

  const sessionAvailable = (request: FastifyRequest) => session !== null && (customSession || hasSession(request))

  const warnNoSession = (request: FastifyRequest, what: string) => {
    if (warnedNoSession) return
    warnedNoSession = true
    request.log.warn(
      `fastify-inertia-adapter: ${what} was used without a session; it will only reach a page rendered in the same request. Register @fastify/session or pass a \`session\` adapter.`
    )
  }

  const takeFromSession = (request: FastifyRequest, key: string): any => {
    if (!sessionAvailable(request)) return undefined
    const value = session!.get(request, key)
    if (value !== undefined && value !== null) session!.set(request, key, undefined)
    return value ?? undefined
  }

  const getVersion = async (request: FastifyRequest): Promise<string> => {
    const st = state(request)
    if (st.version !== undefined) return st.version
    const v = options.version
    const resolved = typeof v === 'function' ? await v(request) : v
    st.version = resolved === undefined || resolved === null ? '' : String(resolved)
    return st.version
  }

  const ssrEnabled = (request: FastifyRequest): boolean => {
    const ssr = options.ssr
    if (!ssr) return false
    if (typeof ssr.enabled === 'function') return ssr.enabled(request)
    return ssr.enabled ?? true
  }

  const renderSsr = async (page: Page, request: FastifyRequest): Promise<SsrResult | null> => {
    const ssr = options.ssr!
    try {
      if (ssr.render) return normalizeSsrResult(await ssr.render(page, request))
      return await renderViaServer(ssr.url ?? 'http://127.0.0.1:13714', page, ssr.timeout ?? 5000)
    } catch (error) {
      request.log.error({ err: error, component: page.component, url: page.url }, 'Inertia SSR render failed')
      ssr.onError?.(error, page, request)
      return null
    }
  }

  const resolveErrors = (request: FastifyRequest, bags: Record<string, Record<string, unknown>>) => {
    const bagHeader = readHeader(request.headers, 'x-inertia-error-bag')
    if (bags.default && bagHeader) return { [bagHeader]: bags.default }
    if (bags.default) return bags.default
    return bags
  }

  async function render (
    reply: FastifyReply,
    component: string,
    props: Props = {},
    renderOptions: RenderOptions = {}
  ): Promise<FastifyReply> {
    const request = reply.request
    const st = state(request)
    const isInertia = isInertiaRequest(request)
    const version = await getVersion(request)

    const globalShared = options.share ? await options.share(request, reply) : {}
    const shared: Props = { ...globalShared, ...st.shared }

    const errorBags = { ...(takeFromSession(request, ERRORS_KEY) ?? {}), ...st.errors }
    const flash = { ...(takeFromSession(request, FLASH_KEY) ?? {}), ...st.flash }

    const allProps: Props = { errors: resolveErrors(request, errorBags), ...shared, ...props }
    if (!isInertiaProp(allProps.errors)) allProps.errors = always(allProps.errors ?? {})

    const { props: resolved, meta } = await resolveProps({
      component,
      props: allProps,
      headers: request.headers,
      isInertia,
      onRescue: (key, err) => request.log.error({ err, prop: key }, 'Inertia deferred prop rescued'),
    })

    const page: Page = {
      component,
      props: resolved as Page['props'],
      url: renderOptions.url ?? request.url,
      version,
    }
    if (renderOptions.encryptHistory ?? st.encryptHistory ?? options.encryptHistory) page.encryptHistory = true
    if (renderOptions.clearHistory ?? st.clearHistory) page.clearHistory = true
    if (renderOptions.preserveFragment ?? st.preserveFragment) page.preserveFragment = true
    Object.assign(page, meta)

    const sharedKeys = [...new Set(['errors', ...Object.keys(shared)])]
    page.sharedProps = sharedKeys
    if (Object.keys(flash).length) page.flash = flash

    reply.header('vary', appendVary(reply.getHeader('vary'), 'X-Inertia'))

    if (isInertia) {
      return reply.header('x-inertia', 'true').type('application/json; charset=utf-8').send(JSON.stringify(page))
    }

    let head = ''
    let body = pageMarkup(page, rootId)
    if (ssrEnabled(request)) {
      const result = await renderSsr(page, request)
      if (result) ({ head, body } = result)
    }

    const html =
      options.rootView === undefined
        ? defaultRootView(options.head ?? '', head, body)
        : typeof options.rootView === 'string'
          ? applyTemplate(options.rootView, head, body)
          : await options.rootView({ page, head, body, viewData: renderOptions.viewData ?? {}, request, reply })

    return reply.type('text/html; charset=utf-8').send(html)
  }

  function createApi (reply: FastifyReply): InertiaReply {
    const request = reply.request
    const api = ((component: string, props?: Props, opts?: RenderOptions) =>
      render(reply, component, props, opts)) as InertiaReply

    const methods: Omit<InertiaReply, 'isInertia' | 'isPrefetch' | 'render'> & { render: InertiaReply['render'] } = {
      render: (component, props, opts) => render(reply, component, props, opts),
      share (props) {
        Object.assign(state(request).shared, props)
        return api
      },
      flash (data) {
        const st = state(request)
        Object.assign(st.flash, data)
        if (sessionAvailable(request)) {
          session!.set(request, FLASH_KEY, { ...((session!.get(request, FLASH_KEY) as object) ?? {}), ...data })
        } else warnNoSession(request, 'flash()')
        return api
      },
      withErrors (errors, bag = 'default') {
        const st = state(request)
        st.errors[bag] = { ...(st.errors[bag] ?? {}), ...errors }
        if (sessionAvailable(request)) {
          const stored = (session!.get(request, ERRORS_KEY) as Record<string, Record<string, unknown>>) ?? {}
          session!.set(request, ERRORS_KEY, { ...stored, [bag]: { ...(stored[bag] ?? {}), ...errors } })
        } else warnNoSession(request, 'withErrors()')
        return api
      },
      encryptHistory (value = true) {
        state(request).encryptHistory = value
        return api
      },
      clearHistory (value = true) {
        state(request).clearHistory = value
        return api
      },
      preserveFragment (value = true) {
        state(request).preserveFragment = value
        return api
      },
      location (url) {
        if (isInertiaRequest(request)) {
          return reply.code(409).header('x-inertia-location', url).send('')
        }
        return reply.code(302).header('location', url).send('')
      },
      redirect (url, status = 302) {
        return reply.code(status).header('location', url).send('')
      },
      back (fallback = '/') {
        const referer = readHeader(request.headers, 'referer')
        return reply.code(302).header('location', referer || fallback).send('')
      },
      isPartial (component?: string) {
        if (!isInertiaRequest(request)) return false
        const partial = readHeader(request.headers, 'x-inertia-partial-component')
        return component === undefined ? Boolean(partial) : partial === component
      },
      version: () => getVersion(request),
    }

    Object.assign(api, methods)
    Object.defineProperty(api, 'isInertia', { get: () => isInertiaRequest(request), enumerable: true })
    Object.defineProperty(api, 'isPrefetch', {
      get: () => readHeader(request.headers, 'purpose') === 'prefetch',
      enumerable: true,
    })
    return api
  }

  fastify.decorateRequest(kState as any, null)
  fastify.decorateReply(kApi as any, null)
  fastify.decorateReply('inertia', {
    getter (this: FastifyReply) {
      const self = this as any
      return (self[kApi] ??= createApi(this))
    },
  } as any)

  // Asset version check: a stale client gets a 409 and does a full reload.
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' || !isInertiaRequest(request)) return
    const version = await getVersion(request)
    const clientVersion = readHeader(request.headers, 'x-inertia-version') ?? ''
    if (clientVersion !== version) {
      // Flash data is only consumed on render, so it survives this round-trip.
      reply
        .code(409)
        .header('x-inertia-location', absoluteUrl(request, request.url))
        .header('x-inertia-version', version)
      return reply.send('')
    }
  })

  // Redirect handling for Inertia requests.
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (!isInertiaRequest(request)) return payload

    if (reply.statusCode === 302 && ['PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      reply.code(303)
    }

    if (REDIRECT_STATUSES.has(reply.statusCode)) {
      const location = reply.getHeader('location')
      if (typeof location === 'string' && location.includes('#') && readHeader(request.headers, 'purpose') !== 'prefetch') {
        reply.removeHeader('location')
        reply.removeHeader('content-length')
        reply.code(409).header('x-inertia-redirect', absoluteUrl(request, location))
        return ''
      }
    }
    return payload
  })
}

export const fastifyInertia = fp(inertiaPlugin, {
  fastify: '4.x || 5.x',
  name: 'fastify-inertia-adapter',
})

export default fastifyInertia
