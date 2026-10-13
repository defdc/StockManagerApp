import { useEffect } from 'react'
import { supabase } from './supabase'
import { hasPendingMutations, notifyRemoteChange } from './dataSync'

/**
 * Supabase Realtime watcher.
 *
 * Subscribes to Postgres changes (INSERT / UPDATE / DELETE) on the tables that drive the
 * app's derived views, and turns bursts of events into a single debounced "data changed"
 * signal that pages consume through `useDataInvalidation` (see dataSync.ts).
 */

const REALTIME_TABLES = ['sales', 'bookings', 'inventory_items'] as const

/** Quiet period after the *last* event before refetching (a 50-row bulk update => 1 refetch). */
const REALTIME_DEBOUNCE_MS = 800
/** If this tab still has writes in flight, wait for them instead of refetching mid-save. */
const BUSY_RETRY_MS = 400

/**
 * Starts the Realtime subscription for as long as the calling component is mounted.
 * Mount once, high in the authenticated tree (Layout). Cleanup removes the channel and any
 * pending timer, so nothing leaks on unmount / logout / hot reload.
 */
export function useRealtimeSync() {
  useEffect(() => {
    const pendingTables = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    function flush() {
      timer = null
      if (disposed || pendingTables.size === 0) return
      if (hasPendingMutations()) {
        timer = setTimeout(flush, BUSY_RETRY_MS)
        return
      }
      const tables = [...pendingTables]
      pendingTables.clear()
      notifyRemoteChange(tables)
    }

    function schedule(table: string) {
      pendingTables.add(table)
      if (timer) clearTimeout(timer) // trailing-edge debounce
      timer = setTimeout(flush, REALTIME_DEBOUNCE_MS)
    }

    // Unique name per mount so StrictMode's double-mount never reuses a channel mid-teardown.
    const channel = supabase.channel(`data-sync-${crypto.randomUUID()}`)
    for (const table of REALTIME_TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => schedule(table))
    }
    channel.subscribe((status, err) => {
      if (disposed) return
      if (status === 'SUBSCRIBED') {
        // (Re)connected: we may have missed events while offline, so catch up once.
        schedule('*')
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // supabase-js retries automatically; the focus-refetch in pages is the safety net.
        console.warn('[realtime] channel issue:', status, err?.message ?? '')
      }
    })

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [])
}
