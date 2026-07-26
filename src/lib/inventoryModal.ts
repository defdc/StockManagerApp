export interface BatchModalItem {
  id?: string
  batch_name?: string | null
  batch_modal_total?: number | null
  modal_price?: number
}

/**
 * Calculates the live modal price for an inventory item based on its batch's current total
 * and current sibling item count.
 *
 * For unbooked/unsold inventory items, modal price is dynamic and updates whenever
 * items are added/removed from the batch.
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
