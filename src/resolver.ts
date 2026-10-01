import { isInertiaProp, type InertiaProp, type ScrollMetadata, type ScrollOptions } from './props.js'
import type { PageMetadata, Props } from './types.js'

export interface ResolveInput {
  component: string
  props: Props
  headers: Record<string, string | string[] | undefined>
  isInertia: boolean
  onRescue?: (key: string, error: unknown) => void
}

export interface ResolveResult {
  props: Record<string, unknown>
  meta: PageMetadata
}

/**
 * Implements the "Prop Evaluation Model" of the Inertia v3 protocol:
 * decides for every prop whether it is resolved on this request and which
 * page-object metadata it contributes.
 */
export async function resolveProps (input: ResolveInput): Promise<ResolveResult> {
  const { component, props, headers, isInertia } = input
  const header = (name: string) => readHeader(headers, name)

  const isPartial = isInertia && header('x-inertia-partial-component') === component
  const only = isPartial ? splitList(header('x-inertia-partial-data')) : []
  const except = isPartial ? splitList(header('x-inertia-partial-except')) : []
  const reset = isInertia ? splitList(header('x-inertia-reset')) : []
  const exceptOnce = new Set(isInertia ? splitList(header('x-inertia-except-once-props')) : [])
  const scrollIntent = header('x-inertia-infinite-scroll-merge-intent')

  const deferredProps: Record<string, string[]> = {}
  const onceProps: NonNullable<PageMetadata['onceProps']> = {}
  const rescuedProps: string[] = []

  type Job = { key: string; prop?: InertiaProp; raw: unknown; subOnly: string[] | null; subExcept: string[] }
  const jobs: Job[] = []

  for (const [key, raw] of Object.entries(props)) {
    const prop = isInertiaProp(raw) ? raw : undefined
    let subOnly: string[] | null = null
    let subExcept = childPaths(except, key)

    if (prop?._always) {
      subExcept = []
    } else if (!isPartial) {
      if (prop?._optional) continue

      if (prop?._once && !prop._once.fresh) {
        const onceKey = prop._once.key ?? key
        if (exceptOnce.has(onceKey)) {
          // Client already holds a non-expired copy: skip, but keep announcing it.
          onceProps[onceKey] = { prop: key, expiresAt: onceExpiry(prop) }
          continue
        }
      }

      if (prop?._deferred) {
        ;(deferredProps[prop._deferred.group] ??= []).push(key)
        continue
      }
    } else {
      if (only.length) {
        if (!only.includes(key)) {
          const children = childPaths(only, key)
          if (!children.length) continue
          subOnly = children
        }
      }
      if (except.includes(key)) continue
    }

    jobs.push({ key, prop, raw, subOnly, subExcept })
  }

  const mergeProps: string[] = []
  const prependProps: string[] = []
  const deepMergeProps: string[] = []
  const matchPropsOn: string[] = []
  const scrollProps: NonNullable<PageMetadata['scrollProps']> = {}

  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        return { ok: true as const, value: await resolveValue(job.prop ? job.prop.value : job.raw) }
      } catch (error) {
        if (isPartial && job.prop?._deferred?.rescue) {
          input.onRescue?.(job.key, error)
          return { ok: false as const }
        }
        throw error
      }
    })
  )

  const resolved: Record<string, unknown> = {}

  jobs.forEach((job, i) => {
    const result = results[i]!
    const { key, prop } = job
    if (!result.ok) {
      rescuedProps.push(key)
      return
    }

    let value = result.value

    if (prop?._scroll) {
      const md = scrollMetadata(prop._scroll.metadata, value)
      const mergePath = prop._merge?.path ? `${key}.${prop._merge.path}` : key
      scrollProps[key] = {
        pageName: md.pageName ?? 'page',
        previousPage: md.previousPage ?? null,
        nextPage: md.nextPage ?? null,
        currentPage: md.currentPage ?? null,
        reset: isReset(reset, key, mergePath),
      }
    }

    if (job.subOnly) value = pickPaths(value, job.subOnly)
    if (job.subExcept.length) value = omitPaths(value, job.subExcept)

    resolved[key] = value

    if (prop?._merge) {
      const mergePath = prop._merge.path ? `${key}.${prop._merge.path}` : key
      if (!isReset(reset, key, mergePath)) {
        let mode = prop._merge.mode
        if (prop._scroll && scrollIntent === 'prepend') mode = 'prepend'
        if (mode === 'append') mergeProps.push(mergePath)
        else if (mode === 'prepend') prependProps.push(mergePath)
        else deepMergeProps.push(mergePath)
        for (const field of prop._merge.matchOn) matchPropsOn.push(`${mergePath}.${field}`)
      }
    }

    if (prop?._once) {
      onceProps[prop._once.key ?? key] = { prop: key, expiresAt: onceExpiry(prop) }
    }
  })

  const meta: PageMetadata = {}
  if (mergeProps.length) meta.mergeProps = mergeProps
  if (prependProps.length) meta.prependProps = prependProps
  if (deepMergeProps.length) meta.deepMergeProps = deepMergeProps
  if (matchPropsOn.length) meta.matchPropsOn = matchPropsOn
  if (Object.keys(scrollProps).length) meta.scrollProps = scrollProps
  if (Object.keys(deferredProps).length) meta.deferredProps = deferredProps
  if (rescuedProps.length) meta.rescuedProps = rescuedProps
  if (Object.keys(onceProps).length) meta.onceProps = onceProps

  return { props: resolved, meta }
}

/**
 * Resolve functions and promises, recursing into plain objects and arrays
 * (class instances such as Dates are left untouched).
 */
export async function resolveValue (value: unknown): Promise<unknown> {
  if (typeof value === 'function') value = await value()
  if (isThenable(value)) value = await value
  if (isInertiaProp(value)) return resolveValue(value.value)

  if (Array.isArray(value)) return Promise.all(value.map(resolveValue))
  if (isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([k, v]) => [k, await resolveValue(v)] as const)
    )
    return Object.fromEntries(entries)
  }
  return value
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function readHeader (headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value.join(',') : value
}

export function splitList (value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function childPaths (paths: string[], key: string): string[] {
  const prefix = `${key}.`
  return paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
}

function isReset (reset: string[], key: string, mergePath: string): boolean {
  return reset.some((r) => r === key || r === mergePath || mergePath.startsWith(`${r}.`))
}

function onceExpiry (prop: InertiaProp): number | null {
  const once = prop._once!
  if (once.ttl !== undefined) return Date.now() + once.ttl * 1000
  return once.expiresAt
}

function scrollMetadata (source: ScrollOptions<unknown>['metadata'], value: unknown): ScrollMetadata {
  if (typeof source === 'function') return source(value) ?? {}
  if (source) return source
  // Infer from common paginator shapes: { currentPage, nextPage, ... } or { meta: {...} }
  const candidates = [value, isObject(value) ? value.meta : undefined]
  for (const c of candidates) {
    if (isObject(c) && ('currentPage' in c || 'nextPage' in c)) {
      return {
        pageName: typeof c.pageName === 'string' ? c.pageName : undefined,
        currentPage: pageCursor(c.currentPage),
        nextPage: pageCursor(c.nextPage),
        previousPage: pageCursor(c.previousPage ?? c.prevPage),
      }
    }
  }
  return {}
}

function pageCursor (value: unknown): number | string | null | undefined {
  return typeof value === 'number' || typeof value === 'string' || value === null ? value : undefined
}

function pickPaths (value: unknown, paths: string[]): unknown {
  if (!isPlainObject(value)) return value
  const groups = groupPaths(paths)
  const out: Record<string, unknown> = {}
  for (const [head, rest] of groups) {
    if (!(head in value)) continue
    out[head] = rest === null ? value[head] : pickPaths(value[head], rest)
  }
  return out
}

function omitPaths (value: unknown, paths: string[]): unknown {
  if (!isPlainObject(value)) return value
  const groups = groupPaths(paths)
  const out: Record<string, unknown> = { ...value }
  for (const [head, rest] of groups) {
    if (!(head in out)) continue
    if (rest === null) delete out[head]
    else out[head] = omitPaths(out[head], rest)
  }
  return out
}

/** Groups `['a', 'b.c', 'b.d']` into `a -> null (whole)`, `b -> ['c', 'd']`. */
function groupPaths (paths: string[]): Map<string, string[] | null> {
  const groups = new Map<string, string[] | null>()
  for (const path of paths) {
    const dot = path.indexOf('.')
    const head = dot === -1 ? path : path.slice(0, dot)
    const rest = dot === -1 ? null : path.slice(dot + 1)
    const existing = groups.get(head)
    if (rest === null || existing === null) groups.set(head, null)
    else groups.set(head, [...(existing ?? []), rest])
  }
  return groups
}

function isThenable (value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof value.then === 'function'
}

export function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isPlainObject (value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
