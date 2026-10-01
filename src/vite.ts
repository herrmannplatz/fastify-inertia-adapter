import { hash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Page, SsrOptions } from './types.js'

export interface InertiaViteOptions {
  /** Client entry, relative to `root` (the key Vite uses in its manifest). */
  entry: string
  /** SSR entry, relative to `root`. Its default export receives the page object and returns `{ head, body }`. */
  ssrEntry?: string
  /** Vite project root. Default: `process.cwd()`. */
  root?: string
  /** Path to the Vite config file. Default: Vite's lookup in `root`. */
  configFile?: string
  /**
   * Build output directory, relative to `root`. The client build is expected in
   * `<buildDir>/client` (with `build.manifest: true`), the SSR build in `<buildDir>/ssr`.
   * Default: `'dist'`.
   */
  buildDir?: string
  /** Public base path of the built assets (Vite's `base`). Default: `'/'`. */
  base?: string
  /** Run the Vite dev server in middleware mode. Default: `NODE_ENV !== 'production'`. */
  dev?: boolean
  /** Serve the client build with `@fastify/static` in production. Default: `true`. */
  serveStatic?: boolean
}

export interface InertiaVite {
  /** `<script>`, `<link rel="stylesheet">` and `<link rel="modulepreload">` tags for the root view. */
  readonly tags: string
  /** Asset version: an md5 of the Vite manifest in production, `''` in development. */
  readonly version: string
  /** Pass to the `ssr` option of the Inertia plugin. `undefined` without an `ssrEntry`. */
  readonly ssr: SsrOptions | undefined
  readonly dev: boolean
}

interface ManifestChunk {
  file: string
  css?: string[]
  imports?: string[]
}

type SsrRender = (page: Page) => Promise<{ head: string[] | string; body: string }>

/**
 * Wires Vite into a Fastify app.
 *
 * - Development: runs Vite in middleware mode on the Fastify server (one port, HMR included)
 *   and loads the SSR entry through Vite's module runner.
 * - Production: builds tags from the Vite manifest, serves the client build and
 *   imports the SSR bundle in-process.
 *
 * Requires `vite` and `@fastify/middie` in development and `@fastify/static` in production.
 */
export async function inertiaVite (app: FastifyInstance, options: InertiaViteOptions): Promise<InertiaVite> {
  const root = resolve(options.root ?? process.cwd())
  const dev = options.dev ?? process.env.NODE_ENV !== 'production'
  const base = withSlashes(options.base ?? '/')
  const buildDir = resolve(root, options.buildDir ?? 'dist')

  return dev ? setupDev(app, options, root, base) : setupProd(app, options, root, base, buildDir)
}

async function setupDev (
  app: FastifyInstance,
  options: InertiaViteOptions,
  root: string,
  base: string
): Promise<InertiaVite> {
  const { createServer, createServerModuleRunner } = await import('vite')
  const server = await createServer({
    root,
    base,
    configFile: options.configFile,
    appType: 'custom',
    server: { middlewareMode: true, hmr: { server: app.server } },
  })
  app.addHook('onClose', () => server.close())

  if (!app.hasDecorator('use')) {
    await app.register((await import('@fastify/middie')).default)
  }
  app.use(server.middlewares)

  let ssr: SsrOptions | undefined
  if (options.ssrEntry) {
    const runner = createServerModuleRunner(server.environments.ssr)
    const entry = resolve(root, options.ssrEntry)
    ssr = {
      render: async (page) => {
        const mod: { default: SsrRender } = await runner.import(entry)
        return mod.default(page)
      },
      onError: (error) => {
        if (error instanceof Error) server.ssrFixStacktrace(error)
        app.log.error(error, 'Inertia SSR failed, falling back to client-side rendering')
      },
    }
  }

  return {
    tags: script(`${base}@vite/client`) + script(base + options.entry),
    version: '',
    ssr,
    dev: true,
  }
}

async function setupProd (
  app: FastifyInstance,
  options: InertiaViteOptions,
  root: string,
  base: string,
  buildDir: string
): Promise<InertiaVite> {
  const clientDir = resolve(buildDir, 'client')
  const raw = readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf8')
  const manifest: Record<string, ManifestChunk> = JSON.parse(raw)
  const chunk = manifest[options.entry]
  if (!chunk) {
    throw new Error(`fastify-inertia-adapter: "${options.entry}" is not an entry in the Vite manifest`)
  }

  if (options.serveStatic ?? true) {
    await app.register((await import('@fastify/static')).default, {
      root: clientDir,
      prefix: base,
      wildcard: false,
      decorateReply: false,
    })
  }

  let ssr: SsrOptions | undefined
  if (options.ssrEntry) {
    const bundle = resolve(buildDir, 'ssr', `${basename(options.ssrEntry, extname(options.ssrEntry))}.js`)
    let render: Promise<SsrRender> | undefined
    ssr = {
      render: async (page) => {
        render ??= import(pathToFileURL(bundle).href).then((mod) => mod.default)
        return (await render)(page)
      },
    }
  }

  return {
    tags: manifestTags(manifest, options.entry, base),
    version: hash('md5', raw),
    ssr,
    dev: false,
  }
}

function manifestTags (manifest: Record<string, ManifestChunk>, entry: string, base: string): string {
  const css = new Set<string>()
  const preloads = new Set<string>()
  const visit = (key: string, isEntry: boolean): void => {
    const chunk = manifest[key]
    if (!chunk) return
    if (!isEntry) {
      if (preloads.has(chunk.file)) return
      preloads.add(chunk.file)
    }
    for (const file of chunk.css ?? []) css.add(file)
    for (const imported of chunk.imports ?? []) visit(imported, false)
  }
  visit(entry, true)

  return [
    ...[...css].map((file) => `<link rel="stylesheet" href="${base}${file}">`),
    ...[...preloads].map((file) => `<link rel="modulepreload" href="${base}${file}">`),
    script(base + manifest[entry]!.file),
  ].join('')
}

function script (src: string): string {
  return `<script type="module" src="${src}"></script>`
}

function withSlashes (path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')
}
