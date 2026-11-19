import { subscribeDataChanges, type DataTable } from './dataSync'

export const SUMMARY_CACHE_TTL_MS = 3 * 60_000 // 3 minutes

interface CacheEntry<T> {
  key: string
  data: T
  fetchedAt: number
}

interface InFlightEntry<T> {
  key: string
  promise: Promise<T>
  controller: AbortController
  subscribers: number
  abortTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Module-level summary cache with:
 * - 3-minute TTL (automatically invalidated when any watched table is mutated via `dataSync.ts`).
 * - In-flight promise deduplication (concurrent mounts / StrictMode share ONE request).
 * - Reference-counted `AbortController` cancellation (navigating away aborts active `fetchAllRows` loops).
 */
export function createSummaryLoader<T>(
  watchedTables: readonly DataTable[],
  fetcher: (signal: AbortSignal, key: string) => Promise<T>,
  ttlMs = SUMMARY_CACHE_TTL_MS
) {
  let cache: CacheEntry<T> | null = null
  let inFlight: InFlightEntry<T> | null = null

  const watched = new Set(watchedTables)
  subscribeDataChanges((changed) => {
    if (changed.some((t) => t === '*' || watched.has(t))) {
      cache = null
    }
  })

  function getCached(key: string): T | null {
    if (cache && cache.key === key && Date.now() - cache.fetchedAt < ttlMs) {
      return cache.data
    }
    return null
  }

  function invalidate() {
    cache = null
  }

  function releaseEntry(entry: InFlightEntry<T>) {
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0 && inFlight === entry && !entry.controller.signal.aborted) {
      entry.abortTimer = setTimeout(() => {
        if (entry.subscribers === 0 && inFlight === entry) {
          entry.controller.abort()
          inFlight = null
        }
      }, 50)
    }
  }

  function load(
    key: string,
    { force = false }: { force?: boolean } = {}
  ): { promise: Promise<T>; release: () => void } {
    if (!force) {
      const cached = getCached(key)
      if (cached !== null) {
        return { promise: Promise.resolve(cached), release: () => {} }
      }
      if (inFlight && inFlight.key === key && !inFlight.controller.signal.aborted) {
        if (inFlight.abortTimer) {
          clearTimeout(inFlight.abortTimer)
          inFlight.abortTimer = null
        }
        inFlight.subscribers += 1
        const entry = inFlight
        return {
          promise: entry.promise,
          release: () => releaseEntry(entry),
        }
      }
    }

    if (inFlight) {
      if (inFlight.abortTimer) clearTimeout(inFlight.abortTimer)
      inFlight.controller.abort()
      inFlight = null
    }

    const controller = new AbortController()
    const entry: InFlightEntry<T> = {
      key,
      controller,
      subscribers: 1,
      abortTimer: null,
      promise: null as unknown as Promise<T>,
    }

    entry.promise = fetcher(controller.signal, key)
      .then((data) => {
        if (!controller.signal.aborted) {
          cache = { key, data, fetchedAt: Date.now() }
        }
        return data
      })
      .finally(() => {
        if (inFlight === entry) {
          inFlight = null
        }
      })

    inFlight = entry
    return {
      promise: entry.promise,
      release: () => releaseEntry(entry),
    }
  }

  return { getCached, load, invalidate }
}
