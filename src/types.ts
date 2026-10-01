import type { FastifyReply, FastifyRequest } from 'fastify'

export type Props = Record<string, unknown>

export interface PageMetadata {
  mergeProps?: string[]
  prependProps?: string[]
  deepMergeProps?: string[]
  matchPropsOn?: string[]
  scrollProps?: Record<
    string,
    {
      pageName: string
      previousPage: number | string | null
      nextPage: number | string | null
      currentPage: number | string | null
      reset: boolean
    }
  >
  deferredProps?: Record<string, string[]>
  rescuedProps?: string[]
  onceProps?: Record<string, { prop: string; expiresAt: number | null }>
}

/** The Inertia page object (https://inertiajs.com/docs/v3/core-concepts/the-protocol#the-page-object). */
export interface Page extends PageMetadata {
  component: string
  props: Record<string, unknown> & { errors: Record<string, unknown> }
  url: string
  version: string | number
  encryptHistory?: true
  clearHistory?: true
  preserveFragment?: true
  sharedProps?: string[]
  flash?: Record<string, unknown>
}

export interface RootViewContext {
  page: Page
  /** Markup for the document `<head>` (SSR head tags, empty without SSR). */
  head: string
  /** Page-object `<script>` plus root `<div>` (or the SSR body). */
  body: string
  /** Extra data passed via `reply.inertia(component, props, { viewData })`. */
  viewData: Record<string, unknown>
  request: FastifyRequest
  reply: FastifyReply
}

export type RootView = string | ((context: RootViewContext) => string | Promise<string>)

export interface SsrResult {
  head: string
  body: string
}

export interface SsrOptions {
  /** Enable SSR globally or per request. Default: `true` when an `ssr` object is given. */
  enabled?: boolean | ((request: FastifyRequest) => boolean)
  /** Base URL of the Inertia SSR server. Default: `http://127.0.0.1:13714`. */
  url?: string
  /** Request timeout in ms. Default: `5000`. */
  timeout?: number
  /** Custom renderer, e.g. to import your SSR bundle in-process instead of calling the SSR server. */
  render?: (page: Page, request: FastifyRequest) => Promise<SsrResult | { head: string[] | string; body: string }>
  /** Called when rendering fails. The adapter falls back to client-side rendering either way. */
  onError?: (error: unknown, page: Page, request: FastifyRequest) => void
}

/**
 * Minimal session abstraction used for flash data and validation errors.
 * The default adapter works with `@fastify/session` and `@fastify/secure-session`.
 */
export interface SessionAdapter {
  get(request: FastifyRequest, key: string): unknown
  set(request: FastifyRequest, key: string, value: unknown): void
}

export type VersionResolver =
  | string
  | number
  | ((request: FastifyRequest) => string | number | Promise<string | number>)

export interface InertiaPluginOptions {
  /**
   * The root HTML document. Either a template string containing `@inertiaHead`
   * and `@inertia` placeholders, or a function returning the full HTML.
   * Default: a minimal HTML5 document (see `head`).
   */
  rootView?: RootView
  /** Extra markup (asset tags, meta tags, ...) for the `<head>` of the default root view. Ignored with a custom `rootView`. */
  head?: string
  /** Current asset version. Default: `''` (no versioning). */
  version?: VersionResolver
  /** Props shared with every page (auth user, app name, ...). */
  share?: (request: FastifyRequest, reply: FastifyReply) => Props | Promise<Props>
  /** Id of the root element. Default: `'app'`. */
  rootId?: string
  /** Encrypt history state for every page by default. Default: `false`. */
  encryptHistory?: boolean
  /** Server-side rendering configuration. */
  ssr?: SsrOptions
  /**
   * Session adapter for flash data and validation errors. Defaults to
   * `request.session` (@fastify/session / @fastify/secure-session).
   * Pass `false` to disable session usage.
   */
  session?: SessionAdapter | false
}

export interface RenderOptions {
  /** Extra data for your root view (not sent to the client). */
  viewData?: Record<string, unknown>
  encryptHistory?: boolean
  clearHistory?: boolean
  preserveFragment?: boolean
  /** Override the page URL (defaults to `request.url`). */
  url?: string
}

export interface InertiaReply {
  /** Render an Inertia page. */
  (component: string, props?: Props, options?: RenderOptions): Promise<FastifyReply>
  /** Render an Inertia page. */
  render(component: string, props?: Props, options?: RenderOptions): Promise<FastifyReply>
  /** Share props with the page rendered in this request. */
  share(props: Props): InertiaReply
  /** Flash data to the next rendered page (exposed as `page.flash`). */
  flash(data: Record<string, unknown>): InertiaReply
  /** Store validation errors for the next rendered page. */
  withErrors(errors: Record<string, unknown>, bag?: string): InertiaReply
  encryptHistory(value?: boolean): InertiaReply
  clearHistory(value?: boolean): InertiaReply
  preserveFragment(value?: boolean): InertiaReply
  /** External / full page redirect. Sends `409` + `X-Inertia-Location` to Inertia requests. */
  location(url: string): FastifyReply
  /** Redirect (302; automatically turned into 303 after PUT/PATCH/DELETE). */
  redirect(url: string, status?: number): FastifyReply
  /** Redirect back to the `Referer` (or the fallback). */
  back(fallback?: string): FastifyReply
  /** `true` when the request was made by the Inertia client. */
  readonly isInertia: boolean
  /** `true` when the request is a partial reload of the given component (or any component if omitted). */
  isPartial(component?: string): boolean
  /** `true` for prefetch requests. */
  readonly isPrefetch: boolean
  /** Resolve the current asset version. */
  version(): Promise<string>
}
