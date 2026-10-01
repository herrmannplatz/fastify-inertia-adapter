import type { FastifyRequest } from 'fastify'
import type { SessionAdapter } from './types.js'

/**
 * Works with `@fastify/session` and `@fastify/secure-session` (both expose
 * `request.session.get/set`). Falls back to plain property access for other
 * session implementations. Does nothing when no session is registered.
 */
export const defaultSessionAdapter: SessionAdapter = {
  get (request: FastifyRequest, key: string) {
    const session = (request as any).session
    if (!session) return undefined
    return typeof session.get === 'function' ? session.get(key) : session[key]
  },
  set (request: FastifyRequest, key: string, value: unknown) {
    const session = (request as any).session
    if (!session) return
    if (typeof session.set === 'function') session.set(key, value)
    else if (value === undefined) delete session[key]
    else session[key] = value
  },
}

export function hasSession (request: FastifyRequest): boolean {
  return Boolean((request as any).session)
}
