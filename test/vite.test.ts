import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import inertia from '../src/index.js'
import { inertiaVite } from '../src/vite.js'

const manifest = JSON.stringify({
  'client/app.ts': { file: 'assets/app-123.js', css: ['assets/app-123.css'], imports: ['_vendor.js'] },
  '_vendor.js': { file: 'assets/vendor-456.js', css: ['assets/vendor-456.css'], imports: ['_shared.js'] },
  '_shared.js': { file: 'assets/shared-789.js', imports: ['_vendor.js'] },
})

function fixture (): string {
  const root = mkdtempSync(join(tmpdir(), 'inertia-vite-'))
  mkdirSync(join(root, 'dist/client/.vite'), { recursive: true })
  mkdirSync(join(root, 'dist/client/assets'))
  mkdirSync(join(root, 'dist/ssr'))
  writeFileSync(join(root, 'dist/client/.vite/manifest.json'), manifest)
  writeFileSync(join(root, 'dist/client/assets/app-123.js'), 'console.log(1)')
  writeFileSync(
    join(root, 'dist/ssr/ssr.js'),
    'export default (page) => ({ head: ["<title>t</title>"], body: `<div id="app">${page.component}</div>` })' // eslint-disable-line no-template-curly-in-string
  )
  return root
}

describe('inertiaVite (production)', () => {
  it('builds tags from the manifest, following imports once', async () => {
    const vite = await inertiaVite(Fastify(), { root: fixture(), entry: 'client/app.ts', dev: false })
    assert.equal(
      vite.tags,
      '<link rel="stylesheet" href="/assets/app-123.css">' +
        '<link rel="stylesheet" href="/assets/vendor-456.css">' +
        '<link rel="modulepreload" href="/assets/vendor-456.js">' +
        '<link rel="modulepreload" href="/assets/shared-789.js">' +
        '<script type="module" src="/assets/app-123.js"></script>'
    )
    assert.equal(vite.version, createHash('md5').update(manifest).digest('hex'))
    assert.equal(vite.ssr, undefined)
  })

  it('prefixes tags with the base path', async () => {
    const vite = await inertiaVite(Fastify(), { root: fixture(), entry: 'client/app.ts', dev: false, base: 'build' })
    assert.match(vite.tags, /<script type="module" src="\/build\/assets\/app-123\.js"><\/script>$/)
  })

  it('throws for an unknown entry', async () => {
    await assert.rejects(
      inertiaVite(Fastify(), { root: fixture(), entry: 'client/missing.ts', dev: false }),
      /not an entry in the Vite manifest/
    )
  })

  it('serves the client build but not the manifest', async () => {
    const app = Fastify()
    await inertiaVite(app, { root: fixture(), entry: 'client/app.ts', dev: false })
    assert.equal((await app.inject('/assets/app-123.js')).body, 'console.log(1)')
    assert.equal((await app.inject('/.vite/manifest.json')).statusCode, 404)
  })

  it('renders through the SSR bundle', async () => {
    const app = Fastify()
    const vite = await inertiaVite(app, { root: fixture(), entry: 'client/app.ts', ssrEntry: 'client/ssr.ts', dev: false })
    await app.register(inertia, {
      version: vite.version,
      ssr: vite.ssr,
      head: vite.tags,
    })
    app.get('/', (_req, reply) => reply.inertia('Home'))

    const body = (await app.inject('/')).body
    assert.match(body, /<script type="module" src="\/assets\/app-123\.js"><\/script>\n {4}<title>t<\/title>\n {2}<\/head>/)
    assert.match(body, /<div id="app">Home<\/div>/)
  })
})
