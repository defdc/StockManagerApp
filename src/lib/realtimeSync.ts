import { useEffect } from 'react'
import { supabase } from './supabase'
import { hasPendingMutations, notifyRemoteChange } from './dataSync'

/**
 * Supabase Realtime watcher.
 *
 * Subscribes to Postgres changes (INSERT / UPDATE / DELETE) on the tables that drive the
 * app's derived views, and turns bursts of events into a single debounced "data changed"
 * signal that pages consume through `useDataInvalidation` (see dataSync.ts).
 *
 * Quota protection:
 * - Debounces bursts of row changes over 2500ms so bulk operations coalesce into 1 refresh.
 * - Uses a single shared channel and pauses Realtime subscription when the tab is hidden
 *   (`document.visibilityState !== 'visible'`), preventing background Realtime churn and
 *   HMR duplicate channels.
 */

const REALTIME_TABLES = ['sales', 'bookings', 'inventory_items'] as const

/** Quiet period after the *last* event before refetching (a 50-row bulk update => 1 refetch). */
export const REALTIME_DEBOUNCE_MS = 2500
/** If this tab still has writes in flight, wait for them instead of refetching mid-save. */
const BUSY_RETRY_MS = 500
const SHARED_CHANNEL_NAME = 'stock-manager-shared-sync'

let activeChannel: ReturnType<typeof supabase.channel> | null = null
let activeSubscribers = 0

/**
 * Starts the Realtime subscription for as long as the calling component is mounted and the
 * browser tab is visible.
 */
export function useRealtimeSync() {
  useEffect(() => {
    activeSubscribers += 1
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
      if (disposed) return
      pendingTables.add(table)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, REALTIME_DEBOUNCE_MS)
    }

    function connectChannel() {
      if (disposed || activeChannel) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

      const channel = supabase.channel(SHARED_CHANNEL_NAME)
      activeChannel = channel

      for (const table of REALTIME_TABLES) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => schedule(table))
      }

      channel.subscribe((status, err) => {
        if (disposed) return
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[realtime] channel issue:', status, err?.message ?? '')
        }
      })
    }

    function disconnectChannel() {
      if (!activeChannel) return
      const ch = activeChannel
      activeChannel = null
      void supabase.removeChannel(ch)
    }

    function handleVisibilityChange() {
      if (disposed) return
      if (document.visibilityState === 'visible') {
        connectChannel()
      } else {
        disconnectChannel()
      }
    }

    connectChannel()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      disposed = true
      activeSubscribers = Math.max(0, activeSubscribers - 1)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pendingTables.clear()
      if (activeSubscribers === 0) {
        disconnectChannel()
      }
    }
  }, [])
}
