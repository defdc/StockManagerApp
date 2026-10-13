import { useEffect, useRef } from 'react'

/**
 * Global data synchronisation / cache invalidation.
 *
 * The app has no query cache library, so every page keeps its own copy of server data in
 * React state. This module lets pages that show *derived* data (e.g. Batches revenue) know
 * when the underlying tables changed anywhere in the app — or in another browser tab.
 *
 * How it works
 * 1. `trackedFetch` is installed as the Supabase client's `fetch`. Every successful
 *    POST/PATCH/PUT/DELETE against `/rest/v1/<table>` marks that table as dirty, so no
 *    mutation handler (Sales, Bookings, Inventory, Import, …) can "forget" to invalidate.
 * 2. Invalidations are coalesced and only emitted once *all* in-flight writes have settled.
 *    Multi-step handlers (update sale → update item → update booking) therefore trigger a
 *    single refetch that sees the final state, even if the user already navigated away.
 * 3. Invalidations are re-broadcast via BroadcastChannel so other open tabs refresh too.
 */

export type DataTable = string

export type ChangeSource = 'local' | 'remote'

type Listener = (tables: DataTable[], source: ChangeSource) => void

const ALL_TABLES = '*'
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
const FLUSH_DELAY_MS = 120
const CHANNEL_NAME = 'stock-manager:data-sync'

const listeners = new Set<Listener>()
let inFlightMutations = 0
let pendingTables = new Set<DataTable>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

const channel: BroadcastChannel | null =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null

function emit(tables: DataTable[], source: ChangeSource) {
  for (const listener of listeners) {
    try {
      listener(tables, source)
    } catch (err) {
      console.error('[dataSync] listener failed', err)
    }
  }
}

channel?.addEventListener('message', (event: MessageEvent<{ tables?: DataTable[] }>) => {
  // Changes made in another tab — refresh locally, but do not re-broadcast.
  emit(event.data?.tables?.length ? event.data.tables : [ALL_TABLES], 'remote')
})

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    // Wait until the last write of a multi-step mutation has landed.
    if (inFlightMutations > 0 || pendingTables.size === 0) return
    const tables = [...pendingTables]
    pendingTables = new Set()
    emit(tables, 'local')
    channel?.postMessage({ tables, at: Date.now() })
  }, FLUSH_DELAY_MS)
}

/** Manually mark tables as changed (defaults to everything). */
export function invalidateData(tables: DataTable[] = [ALL_TABLES]) {
  for (const table of tables) pendingTables.add(table)
  scheduleFlush()
}

/**
 * Signal a change made elsewhere (another user/device via Supabase Realtime). Not re-broadcast
 * to other tabs: every tab holds its own Realtime subscription.
 */
export function notifyRemoteChange(tables: DataTable[] = [ALL_TABLES]) {
  emit(tables, 'remote')
}

/** True while any Supabase write request is still in flight. */
export function hasPendingMutations() {
  return inFlightMutations > 0
}

export function subscribeDataChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

function getRequestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Returns the PostgREST table for a mutating request, `*` for RPCs, or null otherwise. */
function getMutatedTable(url: string): DataTable | null {
  let pathname: string
  try {
    pathname = new URL(url, 'http://localhost').pathname
  } catch {
    return null
  }
  const marker = '/rest/v1/'
  const idx = pathname.indexOf(marker)
  if (idx === -1) return null // auth / storage / realtime requests are ignored
  const [first, second] = pathname.slice(idx + marker.length).split('/')
  if (!first) return null
  if (first === 'rpc') return second ? ALL_TABLES : null // RPCs may touch anything
  return decodeURIComponent(first)
}

/** `fetch` wrapper installed on the Supabase client — see module docs. */
export const trackedFetch: typeof fetch = async (input, init) => {
  const method = getRequestMethod(input, init)
  const table = MUTATING_METHODS.has(method) ? getMutatedTable(getRequestUrl(input)) : null
  if (!table) return globalThis.fetch(input, init)

  inFlightMutations += 1
  try {
    const response = await globalThis.fetch(input, init)
    if (response.ok) pendingTables.add(table)
    return response
  } catch (err) {
    // Network failure: the write may or may not have been applied — refetch to be safe.
    pendingTables.add(table)
    throw err
  } finally {
    inFlightMutations -= 1
    scheduleFlush()
  }
}

interface UseDataInvalidationOptions {
  /** Refetch when the window regains focus / the tab becomes visible. Default: true. */
  refetchOnFocus?: boolean
  /**
   * Ignore changes made by this tab (default false). Use on pages that already reload
   * themselves after their own saves, so they only react to changes from elsewhere.
   */
  remoteOnly?: boolean
}

const FOCUS_REFETCH_MIN_INTERVAL_MS = 1000

/**
 * Calls `onInvalidate` whenever any of `tables` is mutated (in this tab or another one),
 * and — by default — whenever the window regains focus.
 */
export function useDataInvalidation(
  tables: readonly DataTable[],
  onInvalidate: () => void,
  { refetchOnFocus = true, remoteOnly = false }: UseDataInvalidationOptions = {}
) {
  const callbackRef = useRef(onInvalidate)
  useEffect(() => {
    callbackRef.current = onInvalidate
  })

  const tablesKey = [...tables].sort().join('|')

  useEffect(() => {
    const watched = new Set(tablesKey.split('|').filter(Boolean))
    return subscribeDataChanges((changed, source) => {
      if (remoteOnly && source === 'local') return
      const relevant = changed.some((table) => table === ALL_TABLES || watched.has(table))
      if (relevant) callbackRef.current()
    })
  }, [tablesKey, remoteOnly])

  useEffect(() => {
    if (!refetchOnFocus || typeof window === 'undefined') return
    let lastRun = 0
    const handleActive = () => {
      if (document.visibilityState === 'hidden') return
      // A pending write will trigger its own invalidation once it settles.
      if (hasPendingMutations()) return
      const now = Date.now()
      if (now - lastRun < FOCUS_REFETCH_MIN_INTERVAL_MS) return // focus + visibilitychange fire together
      lastRun = now
      callbackRef.current()
    }
    window.addEventListener('focus', handleActive)
    document.addEventListener('visibilitychange', handleActive)
    return () => {
      window.removeEventListener('focus', handleActive)
      document.removeEventListener('visibilitychange', handleActive)
    }
  }, [refetchOnFocus])
}
