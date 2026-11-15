import { supabase } from './supabase'

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

const BATCH_COUNT_CONCURRENCY = 10

/**
 * Fetches exact total item counts per batch from `inventory_items` using 0-byte
 * `head: true, count: 'exact'` queries. Immune to client pagination and PostgREST's
 * 1000-row response limit while transferring near-zero egress payload.
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

  for (let i = 0; i < uniqueRawNames.length; i += BATCH_COUNT_CONCURRENCY) {
    const chunk = uniqueRawNames.slice(i, i + BATCH_COUNT_CONCURRENCY)
    const results = await Promise.all(
      chunk.map(async (rawName) => {
        const { count, error } = await supabase
          .from('inventory_items')
          .select('id', { count: 'exact', head: true })
          .eq('batch_name', rawName)
        return { rawName, count, error }
      })
    )

    for (const { rawName, count, error } of results) {
      if (!error && typeof count === 'number' && count > 0) {
        const normalizedKey = rawName.trim()
        countsMap.set(normalizedKey, (countsMap.get(normalizedKey) ?? 0) + count)
      }
    }
  }

  return countsMap
}
