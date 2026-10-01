import type { Page, SsrResult } from './types.js'

export class InertiaSsrError extends Error {
  constructor (
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'InertiaSsrError'
  }
}

export function normalizeSsrResult (result: { head?: string[] | string; body?: string }): SsrResult {
  if (!result || typeof result.body !== 'string') {
    throw new InertiaSsrError('SSR renderer returned no body')
  }
  const head = Array.isArray(result.head) ? result.head.join('\n') : (result.head ?? '')
  return { head, body: result.body }
}

/** POSTs the page object to the Inertia SSR server (`/render`). */
export async function renderViaServer (baseUrl: string, page: Page, timeout: number): Promise<SsrResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/render`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(page),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    throw new InertiaSsrError(`Could not reach the Inertia SSR server at ${url}`, {
      type: 'connection',
      cause: error instanceof Error ? error.message : String(error),
    })
  }

  const text = await response.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new InertiaSsrError(`Inertia SSR server returned invalid JSON (status ${response.status})`)
  }

  if (!response.ok) {
    throw new InertiaSsrError(data?.error ?? `Inertia SSR render failed with status ${response.status}`, data)
  }
  return normalizeSsrResult(data)
}
