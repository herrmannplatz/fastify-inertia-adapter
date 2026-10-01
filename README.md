# fastify-inertia-adapter

[Inertia.js](https://inertiajs.com) **v3** server-side adapter for [Fastify](https://fastify.dev) 4 and 5, written in TypeScript against the [protocol spec](https://inertiajs.com/docs/v3/core-concepts/the-protocol).

Covers the full protocol: partial reloads (with dot paths), optional / deferred / merge / once / infinite-scroll props, shared props, flash data, validation errors with error bags, asset versioning, history encryption, redirects and SSR with fallback. Ships with an optional Vite integration.

## Install

```bash
npm install fastify-inertia-adapter
npm install @fastify/cookie @fastify/session   # optional: flash data and errors across redirects
```

Then set up the client as described in [Inertia's client-side setup](https://inertiajs.com/docs/v3/installation/client-side-setup).

## Quick start

```ts
import Fastify from 'fastify'
import inertia from 'fastify-inertia-adapter'

const app = Fastify()

await app.register(inertia, {
  version: '1', // changes when your assets change
  head: '<script type="module" src="/build/app.js"></script>',
})

app.get('/events/:id', async (request, reply) => {
  const event = await db.events.find(request.params.id)
  return reply.inertia('Event', { event })
})

await app.listen({ port: 3000 })
```

Using Vite? See [Vite](#vite), which fills in `head`, `version` and `ssr` for you. [`example/`](example) is a complete Vite + Vue 3 + SSR app (`npm run example`).

## Options

| Option           | Default               | Description                                                                              |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `head`           |                       | Extra `<head>` markup (asset tags, meta tags) for the default root view.                  |
| `rootView`       | minimal HTML5 page    | Custom document, see [Root view](#root-view).                                             |
| `version`        | `''`                  | Asset version: string, number or `(request) => string \| Promise<string>`.                |
| `share`          |                       | `(request, reply) => props` shared with every page.                                       |
| `ssr`            |                       | See [SSR](#server-side-rendering).                                                        |
| `session`        | `request.session`     | Storage for flash data and errors: a `{ get, set }` adapter, or `false`.                  |
| `rootId`         | `'app'`               | Root element id.                                                                          |
| `encryptHistory` | `false`               | Encrypt history for all pages.                                                            |

## `reply.inertia`

```ts
reply.inertia(component, props?, options?)        // render (also: reply.inertia.render)
reply.inertia.share({ locale: 'de' })              // per-request shared props (chainable)
reply.inertia.flash({ success: 'Saved!' })         // → page.flash on the next page
reply.inertia.withErrors({ name: 'Required' })     // → props.errors on the next page
reply.inertia.withErrors(errors, 'createUser')     // named error bag
reply.inertia.encryptHistory() / .clearHistory() / .preserveFragment()
reply.inertia.redirect('/users')                   // 302, 303 after PUT/PATCH/DELETE
reply.inertia.back('/fallback')                    // redirect to Referer
reply.inertia.location('https://stripe.com/...')   // external visit (409 + X-Inertia-Location)
reply.inertia.isInertia / .isPrefetch / .isPartial('Users') / await .version()
```

Render options: `{ viewData, encryptHistory, clearHistory, preserveFragment, url }`. Plain `reply.redirect()` gets the same 303 and fragment handling.

## Props

Props can be values, promises or (async) functions, also nested. Only props needed for the request are evaluated, so wrap expensive work in functions.

```ts
import { always, optional, defer, merge, prepend, deepMerge, once, scroll } from 'fastify-inertia-adapter'

reply.inertia('Users/Index', {
  users: () => db.users.all(),
  csrf: always(() => token),                      // included even when a partial reload excludes it
  roles: optional(() => db.roles.all()),          // only via router.reload({ only: ['roles'] })
  stats: defer(() => slowStats()),                // loaded after render
  related: defer(() => related(), 'sidebar'),     // grouped into a parallel request
  permissions: defer(() => mightFail()).rescue(), // failure → rescuedProps instead of a 500
  posts: merge(() => page.items).matchOn('id'),
  notifications: prepend(() => latest(), 'id'),
  conversations: deepMerge(() => convo, 'data.id'),
  plans: once(() => db.plans.all()),              // reused by the client across pages
  rates: once(() => fetchRates(), { key: 'fx', ttl: 3600 }),
  feed: scroll(() => paginate(q), { matchOn: 'id' }), // <InfiniteScroll>, cursor from `meta`
})
```

Wrappers compose: `defer(() => comments()).merge().matchOn('id')`, `once(() => plans()).defer('billing')`, `scroll(fn, { dataPath: 'items' }).defer()`.

## Shared data

```ts
await app.register(inertia, {
  share: (request) => ({ auth: { user: request.session.get('user') ?? null } }),
})

app.addHook('preHandler', async (request, reply) => {
  reply.inertia.share({ locale: request.headers['accept-language'] })
})
```

Page props override shared props with the same key.

## Validation errors & flash data

Stored in the session across redirects. Works out of the box with `@fastify/session` or `@fastify/secure-session`:

```ts
app.post('/users', async (request, reply) => {
  const result = schema.safeParse(request.body)
  if (!result.success) return reply.inertia.withErrors(flattenErrors(result.error)).back()
  await db.users.create(result.data)
  return reply.inertia.flash({ success: 'User created' }).redirect('/users')
})
```

`props.errors` is always present (`{}` by default) and respects `useForm`'s `errorBag`. For other stores pass `session: { get(request, key), set(request, key, value) }`.

## File uploads

Inertia sends JSON unless the data contains a `File`, then it switches to `multipart/form-data`. Fastify parses JSON out of the box; for uploads register [`@fastify/multipart`](https://github.com/fastify/fastify-multipart):

```ts
import fastifyMultipart from '@fastify/multipart'

await app.register(fastifyMultipart, {
  attachFieldsToBody: 'keyValues', // fields as strings, files as Buffers
  limits: { fileSize: 5 * 1024 * 1024 },
})

app.post<{ Body: { name: string; avatar?: Buffer } }>('/users', async (request, reply) => {
  const { name, avatar } = request.body
  await db.users.create({ name, avatar })
  return reply.inertia.flash({ success: 'User created' }).redirect('/users')
})
```

```vue
<script setup lang="ts">
import { useForm } from '@inertiajs/vue3'

const form = useForm({ name: '', avatar: null as File | null })
</script>

<template>
  <form @submit.prevent="form.post('/users')">
    <input v-model="form.name" />
    <input type="file" @input="form.avatar = ($event.target as HTMLInputElement).files?.[0] ?? null" />
    <progress v-if="form.progress" :value="form.progress.percentage" max="100" />
    <button :disabled="form.processing">Save</button>
  </form>
</template>
```

## Vite

`fastify-inertia-adapter/vite` handles asset tags, versioning, static files and SSR loading:

```bash
npm install -D vite @fastify/middie   # development
npm install @fastify/static            # production
```

```ts
import { inertiaVite } from 'fastify-inertia-adapter/vite'

const vite = await inertiaVite(app, { entry: 'src/app.ts', ssrEntry: 'src/ssr.ts' })

await app.register(inertia, { head: vite.tags, version: vite.version, ssr: vite.ssr })
```

|                | Development                                             | Production (`NODE_ENV=production`)                   |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Assets         | Vite in middleware mode on the same port, with HMR       | `<buildDir>/client` via `@fastify/static`            |
| `vite.tags`    | `@vite/client` + entry                                  | Entry, CSS and `modulepreload` tags from the manifest |
| `vite.version` | `''`                                                    | md5 of the manifest                                  |
| `vite.ssr`     | `ssrEntry` via Vite's module runner (hot reloaded)      | `<buildDir>/ssr/<name>.js`                           |

Options: `entry`, `ssrEntry`, `root` (`process.cwd()`), `configFile`, `buildDir` (`'dist'`), `base` (`'/'`), `dev`, `serveStatic` (`true`).

`ssrEntry` is optional. Without it, `vite.ssr` is `undefined`, pages render client-side only, and `vite build` is the only build step.

Build the client with `build.manifest: true` into `<buildDir>/client`, and the SSR entry into `<buildDir>/ssr`:

```bash
vite build && vite build --ssr src/ssr.ts --outDir dist/ssr
```

The SSR entry default-exports `(page) => { head, body }`. If you use `@inertiajs/vite`, pass `inertia({ ssr: false })`, since rendering happens in-process. Vue example:

```ts
import { createInertiaApp } from '@inertiajs/vue3'
import type { Page } from '@inertiajs/core'
import { renderToString } from 'vue/server-renderer'

const render = (await createInertiaApp({ pages: './pages' }))!

export default (page: Page) => render(page, renderToString)
```

## Root view

By default pages render into a minimal HTML5 document containing `head`. For your own markup, pass a template with `@inertiaHead` (SSR head tags) and `@inertia` (page data and root element, or the SSR body):

```ts
rootView: `<!DOCTYPE html>
<html lang="en">
  <head>${vite.tags}@inertiaHead</head>
  <body>@inertia</body>
</html>`
```

Or a function, which also receives `viewData` from the render options:

```ts
rootView: ({ head, body, viewData }) => `<!DOCTYPE html>
<html><head><title>${viewData.title}</title>${head}</head><body>${body}</body></html>`
```

## Server-side rendering

With Vite, use `vite.ssr`. Otherwise, call Inertia's SSR server or render in-process:

```ts
ssr: {
  url: 'http://127.0.0.1:13714', // default; POSTs to /render
  // render: (page) => import('./dist/ssr/ssr.js').then((m) => m.default(page)),
  // enabled: (request) => !request.url.startsWith('/admin'),
  // timeout: 5000,
  // onError: (err, page, request) => log(err),
}
```

SSR runs only on full page loads. If rendering fails, the page falls back to client-side rendering.

## Asset versioning

When an Inertia `GET` carries an outdated `X-Inertia-Version`, the plugin answers `409` with `X-Inertia-Location` and the client does a full reload. With Vite, `vite.version` handles this.

## Notes

- **CSRF:** Inertia sends the `XSRF-TOKEN` cookie back as `X-XSRF-TOKEN`. Use [`@fastify/csrf-protection`](https://github.com/fastify/csrf-protection) with its `getToken` option.
- **TypeScript:** `reply.inertia` is typed via module augmentation. `Page`, `Props`, `InertiaPluginOptions`, `RenderOptions` and `SessionAdapter` are exported.
- **Precognition** is not included. Return `204` with `Precognition: true` and `Precognition-Success: true`, or `422` with errors, from your route.

## Development

```bash
npm test               # test suite
npm run lint           # neostandard (lint:fix to fix)
npm run typecheck      # src, tests and example
npm run build          # ESM + types into dist/
npm run example        # example app on :3000
```

## License

MIT
