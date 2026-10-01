/**
 * Prop wrappers that tell the adapter *how* a prop should be resolved and
 * which page-object metadata it produces. Every wrapper is the same
 * composable `InertiaProp` class, so categories can be combined freely:
 *
 *   defer(() => loadComments()).merge().matchOn('id')
 *   once(() => loadPlans(), { ttl: 3600 }).defer('billing')
 *   scroll(() => paginate(), { metadata: (p) => p.meta })
 */

// Symbol.for so instances created by the ESM and CJS builds are recognised by both.
export const kInertiaProp = Symbol.for('fastify-inertia-adapter.prop')

export type MaybePromise<T> = T | Promise<T>
export type Resolvable<T> = T | Promise<T> | (() => MaybePromise<T>)
export type MergeMode = 'append' | 'prepend' | 'deep'

export interface ScrollMetadata {
  pageName?: string
  currentPage?: number | string | null
  previousPage?: number | string | null
  nextPage?: number | string | null
}

export interface ScrollOptions<T> {
  /**
   * Path inside the resolved value that holds the item array.
   * Defaults to `'data'`. Pass `null` if the prop itself is the array.
   */
  dataPath?: string | null
  /** Field(s) used to de-duplicate items when merging, e.g. `'id'`. */
  matchOn?: string | string[]
  /**
   * Pagination cursor. Either static or computed from the resolved value.
   * When omitted, `currentPage` / `previousPage` / `nextPage` / `pageName`
   * are read from the resolved value (or its `meta` object) if present.
   */
  metadata?: ScrollMetadata | ((value: T) => ScrollMetadata)
}

export interface OnceOptions {
  /** Custom key shared across pages. Defaults to the prop name. */
  key?: string
  /** Absolute expiry (Date or epoch milliseconds). */
  expiresAt?: Date | number | null
  /** Relative expiry in seconds, computed at response time. */
  ttl?: number
  /** Always send a fresh value, even if the client says it already has one. */
  fresh?: boolean
}

export interface DeferOptions {
  /** If the resolver throws, omit the prop and list it in `rescuedProps` instead of failing the response. */
  rescue?: boolean
}

export class InertiaProp<T = unknown> {
  readonly [kInertiaProp] = true

  /** @internal */ _always = false
  /** @internal */ _optional = false
  /** @internal */ _deferred?: { group: string; rescue: boolean }
  /** @internal */ _merge?: { mode: MergeMode; path?: string; matchOn: string[] }
  /** @internal */ _once?: { key?: string; expiresAt: number | null; ttl?: number; fresh: boolean }
  /** @internal */ _scroll?: { metadata?: ScrollOptions<T>['metadata'] }

  constructor (readonly value: Resolvable<T>) {}

  /** Resolve on every response, ignoring partial reload filters. */
  always (): this {
    this._always = true
    return this
  }

  /** Never sent on a full visit; only when a partial reload asks for it. */
  optional (): this {
    this._optional = true
    return this
  }

  /** Skip on the full visit and let the client fetch it in a follow-up request. */
  defer (group = 'default', options: DeferOptions = {}): this {
    this._deferred = { group, rescue: options.rescue ?? this._deferred?.rescue ?? false }
    return this
  }

  /** For deferred props: don't fail the response if the resolver throws. */
  rescue (value = true): this {
    this._deferred = { group: this._deferred?.group ?? 'default', rescue: value }
    return this
  }

  /** Append incoming data to existing data on the client (alias of `append`). */
  merge (path?: string, matchOn?: string | string[]): this {
    return this.append(path, matchOn)
  }

  append (path?: string, matchOn?: string | string[]): this {
    this._merge = { mode: 'append', path, matchOn: toArray(matchOn ?? this._merge?.matchOn) }
    return this
  }

  prepend (path?: string, matchOn?: string | string[]): this {
    this._merge = { mode: 'prepend', path, matchOn: toArray(matchOn ?? this._merge?.matchOn) }
    return this
  }

  deepMerge (matchOn?: string | string[]): this {
    this._merge = { mode: 'deep', path: undefined, matchOn: toArray(matchOn ?? this._merge?.matchOn) }
    return this
  }

  /**
   * Fields (relative to the merge path) used to update existing items in place.
   * Implies `merge()` if no merge mode was set yet.
   */
  matchOn (...fields: string[]): this {
    this._merge ??= { mode: 'append', matchOn: [] }
    this._merge.matchOn = [...this._merge.matchOn, ...fields]
    return this
  }

  /** Resolve once and let the client reuse it on later pages. */
  once (options: OnceOptions = {}): this {
    this._once = {
      key: options.key ?? this._once?.key,
      expiresAt: normalizeExpiry(options.expiresAt ?? this._once?.expiresAt ?? null),
      ttl: options.ttl ?? this._once?.ttl,
      fresh: options.fresh ?? this._once?.fresh ?? false,
    }
    return this
  }

  /** Force a once prop to be re-sent even if the client already has it. */
  fresh (value = true): this {
    this.once({ fresh: value })
    return this
  }
}

export function isInertiaProp (value: unknown): value is InertiaProp {
  return typeof value === 'object' && value !== null && kInertiaProp in value && value[kInertiaProp] === true
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Always included, even on partial reloads that don't ask for it. */
export function always<T> (value: Resolvable<T>): InertiaProp<T> {
  return new InertiaProp(value).always()
}

/** Only sent when explicitly requested via a partial reload. */
export function optional<T> (value: Resolvable<T>): InertiaProp<T> {
  return new InertiaProp(value).optional()
}

/** Loaded by the client in a follow-up request after the page renders. */
export function defer<T> (value: Resolvable<T>, group = 'default', options?: DeferOptions): InertiaProp<T> {
  return new InertiaProp(value).defer(group, options)
}

/** Appended to the existing client value on partial reloads. */
export function merge<T> (value: Resolvable<T>, matchOn?: string | string[]): InertiaProp<T> {
  return new InertiaProp(value).append(undefined, matchOn)
}

/** Prepended to the existing client value on partial reloads. */
export function prepend<T> (value: Resolvable<T>, matchOn?: string | string[]): InertiaProp<T> {
  return new InertiaProp(value).prepend(undefined, matchOn)
}

/** Deep-merged into the existing client value on partial reloads. */
export function deepMerge<T> (value: Resolvable<T>, matchOn?: string | string[]): InertiaProp<T> {
  return new InertiaProp(value).deepMerge(matchOn)
}

/** Resolved once and remembered by the client across pages. */
export function once<T> (value: Resolvable<T>, options?: OnceOptions): InertiaProp<T> {
  return new InertiaProp(value).once(options)
}

/** Paginated data for the `<InfiniteScroll>` component. */
export function scroll<T> (value: Resolvable<T>, options: ScrollOptions<T> = {}): InertiaProp<T> {
  const prop = new InertiaProp(value)
  const dataPath = options.dataPath === undefined ? 'data' : options.dataPath
  prop._merge = { mode: 'append', path: dataPath ?? undefined, matchOn: toArray(options.matchOn) }
  prop._scroll = { metadata: options.metadata }
  return prop
}

// ---------------------------------------------------------------------------

function toArray (value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? [...value] : [value]
}

function normalizeExpiry (value: Date | number | null): number | null {
  if (value === null) return null
  return value instanceof Date ? value.getTime() : value
}
