import { supabase } from './supabase'
import { fetchAllRows } from './supabasePagination'
import { subscribeDataChanges } from './dataSync'

export interface BatchModalItem {
  id?: string
  batch_name?: string | null
  batch_modal_total?: number | null
  modal_price?: number
}

export interface IndividualModalInput {
  itemModal?: number | null
  batchModalTotal?: number | null
  batchItemCount?: number | null
  fallbackModal?: number | null
}

/**
 * Calculates the live modal price for an inventory item based on its batch's current total
 * and current sibling item count.
 *
 * NOTE: Only pass a COMPLETE list of all inventory items into `allItems`. For paginated
 * or filtered views, use `fetchExactBatchItemCounts` + `resolveIndividualItemModal` instead.
 */
export function getLiveModalPrice<T extends BatchModalItem>(
  item: T,
  allItems: T[]
): number {
  const batchName = item.batch_name?.trim()
  if (!batchName) return item.modal_price ?? 0

  const batchItems = allItems.filter((i) => i.batch_name?.trim() === batchName)
  if (batchItems.length === 0) return item.modal_price ?? 0

  const batchModalTotal =
    batchItems.find((i) => (i.batch_modal_total ?? 0) > 0)?.batch_modal_total ??
    item.batch_modal_total ??
    0

  if (!batchModalTotal) return item.modal_price ?? 0

  return Math.floor(batchModalTotal / batchItems.length)
}

/**
 * Resolves a single item's individual capital cost (modal_price), ensuring an unsplit
 * `batch_modal_total` or truncated partial-page division is never used as one item's modal.
 *
 * Priority:
 * 1. `inventory_items.modal_price` (> 0), unless it mistakenly equals/exceeds `batch_modal_total`
 *    on a confirmed multi-item batch (`batchItemCount > 1`).
 * 2. `Math.floor(batch_modal_total / exactBatchItemCount)` for UI-added batch items stored with
 *    `modal_price = 0` (or mistakenly storing the unsplit batch total).
 * 3. `fallbackModal` (e.g., stored `sale.modal_price` or `booking.modal_price`) only when the
 *    linked inventory item provides neither an individual modal nor a batch-derived modal.
 */
export function resolveIndividualItemModal({
  itemModal,
  batchModalTotal,
  batchItemCount,
  fallbackModal,
}: IndividualModalInput): number {
  const safeItemModal = Math.max(0, Number(itemModal) || 0)
  const safeBatchTotal = Math.max(0, Number(batchModalTotal) || 0)
  const safeBatchCount = Math.max(0, Math.floor(Number(batchItemCount) || 0))
  const safeFallback = Math.max(0, Number(fallbackModal) || 0)

  const perItemFromBatch =
    safeBatchTotal > 0 && safeBatchCount > 0
      ? Math.floor(safeBatchTotal / safeBatchCount)
      : 0

  const isUnsplitItemModal =
    safeBatchTotal > 0 && safeBatchCount > 1 && safeItemModal >= safeBatchTotal

  if (safeItemModal > 0 && !isUnsplitItemModal) {
    return safeItemModal
  }

  if (perItemFromBatch > 0) {
    return perItemFromBatch
  }

  return safeFallback
}

/**
 * Returns true if resolving an item's individual modal requires querying the exact database
 * item count for its batch (e.g. `batch_modal_total > 0` and item `modal_price` is 0 or
 * looks like an unsplit batch total).
 */
export function shouldFetchBatchCountForItem(
  item:
    | {
        batch_name?: string | null
        batch_modal_total?: number | null
        modal_price?: number | null
      }
    | null
    | undefined
): boolean {
  if (!item?.batch_name?.trim()) return false
  const batchTotal = Number(item.batch_modal_total) || 0
  if (batchTotal <= 0) return false
  const itemModal = Number(item.modal_price) || 0
  return itemModal <= 0 || itemModal >= batchTotal
}

const BATCH_IN_CHUNK_SIZE = 100
const BATCH_COUNT_CACHE_TTL_MS = 5 * 60_000

const batchCountCache = new Map<string, { count: number; fetchedAt: number }>()

subscribeDataChanges((tables) => {
  if (tables.includes('*') || tables.includes('inventory_items')) {
    batchCountCache.clear()
  }
})

interface BatchItemCountRpcRow {
  batch_name: string | null
  item_count: number | string | null
}

/**
 * Fetches exact total item counts per batch from `inventory_items` using the
 * `get_batch_item_counts` Postgres RPC (immune to PostgREST's 1,000-row cap and zero row-scan
 * egress) plus a 5-minute in-memory cache invalidated on `inventory_items` mutations.
 *
 * Returns a Map keyed by trimmed batch name (`batchName.trim()`).
 */
export async function fetchExactBatchItemCounts(
  batchNames: (string | null | undefined)[]
): Promise<Map<string, number>> {
  const uniqueRawNames = Array.from(
    new Set(batchNames.filter((name): name is string => Boolean(name && name.trim())))
  )
  const countsMap = new Map<string, number>()
  if (uniqueRawNames.length === 0) return countsMap

  const now = Date.now()
  const missingBatchNames: string[] = []

  for (const rawName of uniqueRawNames) {
    const key = rawName.trim()
    const cached = batchCountCache.get(key)
    if (cached && now - cached.fetchedAt < BATCH_COUNT_CACHE_TTL_MS) {
      countsMap.set(key, cached.count)
    } else {
      missingBatchNames.push(rawName)
    }
  }

  if (missingBatchNames.length === 0) {
    return countsMap
  }

  const freshlyCounted = new Map<string, number>()
  const { data: rpcData, error: rpcError } = await supabase.rpc('get_batch_item_counts', {
    p_batch_names: missingBatchNames,
  })

  if (!rpcError && Array.isArray(rpcData)) {
    for (const row of rpcData as BatchItemCountRpcRow[]) {
      const key = row.batch_name?.trim()
      const count = Number(row.item_count) || 0
      if (!key || count <= 0) continue
      freshlyCounted.set(key, (freshlyCounted.get(key) ?? 0) + count)
    }
  } else {
    // Fallback if RPC is unavailable in an older environment
    for (let i = 0; i < missingBatchNames.length; i += BATCH_IN_CHUNK_SIZE) {
      const chunk = missingBatchNames.slice(i, i + BATCH_IN_CHUNK_SIZE)
      const rows = await fetchAllRows<{ batch_name: string | null }>(
        (from, to) =>
          supabase
            .from('inventory_items')
            .select('batch_name')
            .in('batch_name', chunk)
            .range(from, to) as unknown as PromiseLike<{
            data: { batch_name: string | null }[] | null
            error: { message: string } | null
          }>,
        1000
      )

      for (const row of rows) {
        const key = row.batch_name?.trim()
        if (!key) continue
        freshlyCounted.set(key, (freshlyCounted.get(key) ?? 0) + 1)
      }
    }
  }

  for (const rawName of missingBatchNames) {
    const key = rawName.trim()
    const count = freshlyCounted.get(key) ?? 0
    if (count > 0) {
      countsMap.set(key, count)
    }
    batchCountCache.set(key, { count, fetchedAt: now })
  }

  return countsMap
}
