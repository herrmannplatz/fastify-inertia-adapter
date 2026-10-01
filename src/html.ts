import type { Page } from './types.js'

/**
 * Serialize the page object for embedding in a `<script type="application/json">`.
 * Every `/` is escaped so a `</script>` inside prop data cannot close the element.
 * U+2028/U+2029 are escaped as well for maximum compatibility.
 */
export function serializePage (page: Page): string {
  return JSON.stringify(page)
    .replace(/\//g, '\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function pageMarkup (page: Page, rootId: string): string {
  const id = escapeAttribute(rootId)
  return `<script data-page="${id}" type="application/json">${serializePage(page)}</script><div id="${id}"></div>`
}

/** The root view used when no `rootView` option is given. */
export function defaultRootView (extraHead: string, ssrHead: string, body: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${[extraHead, ssrHead].filter(Boolean).join('\n    ')}
  </head>
  <body>
    ${body}
  </body>
</html>`
}

/** Replaces `@inertiaHead` and `@inertia` placeholders in a template string. */
export function applyTemplate (template: string, head: string, body: string): string {
  return template.split('@inertiaHead').join(head).split('@inertia').join(body)
}

function escapeAttribute (value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
