import { createInertiaApp } from '@inertiajs/vue3'
import type { Page } from '@inertiajs/core'
import { renderToString } from 'vue/server-renderer'

// On the server, createInertiaApp() returns a render function instead of mounting.
const render = (await createInertiaApp({ pages: './pages' }))!

export default (page: Page) => render(page, renderToString)
