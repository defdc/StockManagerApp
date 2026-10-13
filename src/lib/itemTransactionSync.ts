import { supabase } from './supabase'
import type { InventoryItem } from '../types/database'

export interface RelatedSaleRecord {
  sale_price?: number | null
  buyer_name?: string | null
  created_at?: string | null
}

export interface RelatedBookingRecord {
  deal_price?: number | null
  group_total_deal_price?: number | null
  buyer_name?: string | null
  status?: string | null
  created_at?: string | null
}

export type InventoryItemWithRelations = InventoryItem & {
  sales?: RelatedSaleRecord[] | RelatedSaleRecord | null
  bookings?: RelatedBookingRecord[] | RelatedBookingRecord | null
}

function normalizeRelationArray<T>(rel: T[] | T | null | undefined): T[] {
  if (!rel) return []
  return Array.isArray(rel) ? rel : [rel]
}

export function isConvertedBookingStatus(status: string | null | undefined): boolean {
  if (!status) return false
  const normalized = status.toLowerCase().trim().replace(/\s+/g, '_')
  return normalized === 'converted_to_sale'
}

/**
 * Resolves Sold Price and Buyer Name for an item using the strict 3-tier fallback hierarchy:
 * a. Primary: sales.sale_price and sales.buyer_name
 * b. Secondary: If item status is 'sold' or linked booking is 'Converted to sale',
 *    fallback to booking.deal_price and booking.buyer_name
 * c. Tertiary: inventory_items.sold_price and inventory_items.buyer_name
 */
export function resolveItemTransactionDetails(
  item: InventoryItemWithRelations,
  extraSales: RelatedSaleRecord[] = [],
  extraBookings: RelatedBookingRecord[] = []
): {
  salePrice: number | null
  buyerName: string | null
  hasSaleOrConvertedBooking: boolean
} {
  const allSales = [...normalizeRelationArray(item.sales), ...extraSales].sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? '')
  )

  const allBookings = [...normalizeRelationArray(item.bookings), ...extraBookings].sort((a, b) => {
    const aConverted = isConvertedBookingStatus(a.status) ? 0 : (a.status ?? '').toLowerCase() === 'cancelled' ? 2 : 1
    const bConverted = isConvertedBookingStatus(b.status) ? 0 : (b.status ?? '').toLowerCase() === 'cancelled' ? 2 : 1
    if (aConverted !== bConverted) return aConverted - bConverted
    return (b.created_at ?? '').localeCompare(a.created_at ?? '')
  })

  const itemIsSold = (item.status ?? '').toLowerCase().trim() === 'sold'
  const hasConvertedBooking = allBookings.some((b) => isConvertedBookingStatus(b.status))
  const hasSale = allSales.length > 0

  // a. Primary: sales.sale_price and sales.buyer_name
  let primaryPrice: number | null = null
  let primaryBuyer: string | null = null

  for (const s of allSales) {
    const price = typeof s.sale_price === 'number' ? s.sale_price : Number(s.sale_price)
    if (primaryPrice === null && Number.isFinite(price) && price > 0) {
      primaryPrice = price
    }
    const buyer = s.buyer_name?.trim()
    if (!primaryBuyer && buyer) {
      primaryBuyer = buyer
    }
  }

  // b. Secondary: If item status is 'sold' or linked booking is 'Converted to sale',
  //    fallback to booking.deal_price and booking.buyer_name
  let secondaryPrice: number | null = null
  let secondaryBuyer: string | null = null

  if (itemIsSold || hasConvertedBooking) {
    for (const b of allBookings) {
      if ((b.status ?? '').toLowerCase().trim() === 'cancelled' && !isConvertedBookingStatus(b.status)) {
        continue
      }
      const dealPrice = typeof b.deal_price === 'number' ? b.deal_price : Number(b.deal_price)
      if (secondaryPrice === null && Number.isFinite(dealPrice) && dealPrice > 0) {
        secondaryPrice = dealPrice
      }
      const buyer = b.buyer_name?.trim()
      if (!secondaryBuyer && buyer) {
        secondaryBuyer = buyer
      }
    }
  }

  // c. Tertiary: inventory_items.sold_price / inventory_items.buyer_name
  const rawTertiaryPrice =
    item.sold_price !== undefined && item.sold_price !== null ? Number(item.sold_price) : NaN
  const tertiaryPrice = Number.isFinite(rawTertiaryPrice) && rawTertiaryPrice > 0 ? rawTertiaryPrice : null
  const tertiaryBuyer = item.buyer_name?.trim() || null

  // Fallback price resolution (prefer positive value along hierarchy a -> b -> c)
  let salePrice: number | null = primaryPrice ?? secondaryPrice ?? tertiaryPrice
  if (salePrice === null && hasSale) {
    const firstSalePrice = Number(allSales[0]?.sale_price ?? 0)
    salePrice = Number.isFinite(firstSalePrice) ? firstSalePrice : 0
  }

  const buyerName: string | null = primaryBuyer ?? secondaryBuyer ?? tertiaryBuyer ?? null

  return {
    salePrice,
    buyerName,
    hasSaleOrConvertedBooking: itemIsSold || hasSale || hasConvertedBooking,
  }
}

// Cache whether the database schema includes flat sold_price / buyer_name columns on inventory_items
let supportsFlatInventorySaleFields: boolean | null = null

export function detectFlatInventorySaleFields(sampleItem: Record<string, unknown> | null | undefined) {
  if (!sampleItem || supportsFlatInventorySaleFields !== null) return
  supportsFlatInventorySaleFields = 'sold_price' in sampleItem && 'buyer_name' in sampleItem
}

function isMissingColumnError(message: string | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return (
    (lower.includes('sold_price') || lower.includes('buyer_name')) &&
    (lower.includes('column') || lower.includes('schema cache') || lower.includes('does not exist'))
  )
}

/**
 * Updates an inventory_items row to status = 'sold' and writes sold_price / buyer_name
 * if those columns exist on inventory_items, falling back to status + updated_at otherwise.
 */
export async function updateInventoryItemSoldState(
  itemId: string,
  salePrice: number,
  buyerName: string
): Promise<{ error: { message: string } | null }> {
  const now = new Date().toISOString()

  if (supportsFlatInventorySaleFields !== false) {
    const { error } = await supabase
      .from('inventory_items')
      .update({
        status: 'sold',
        sold_price: salePrice,
        buyer_name: buyerName,
        updated_at: now,
      } as Record<string, unknown>)
      .eq('id', itemId)

    if (!error) {
      supportsFlatInventorySaleFields = true
      return { error: null }
    }

    if (isMissingColumnError(error.message)) {
      supportsFlatInventorySaleFields = false
    } else {
      return { error }
    }
  }

  const { error } = await supabase
    .from('inventory_items')
    .update({
      status: 'sold',
      updated_at: now,
    })
    .eq('id', itemId)

  return { error }
}

/**
 * Clears flat sold_price / buyer_name (if supported) and updates status when a sale is undone or deleted.
 */
export async function revertInventoryItemsSaleState(
  itemIds: string[],
  targetStatus: 'ready' | 'booked'
): Promise<{ error: { message: string } | null }> {
  if (itemIds.length === 0) return { error: null }
  const now = new Date().toISOString()

  if (supportsFlatInventorySaleFields === true) {
    const { error } = await supabase
      .from('inventory_items')
      .update({
        status: targetStatus,
        sold_price: null,
        buyer_name: null,
        updated_at: now,
      } as Record<string, unknown>)
      .in('id', itemIds)

    if (!error) return { error: null }
    if (isMissingColumnError(error.message)) {
      supportsFlatInventorySaleFields = false
    } else {
      return { error }
    }
  }

  const { error } = await supabase
    .from('inventory_items')
    .update({
      status: targetStatus,
      updated_at: now,
    })
    .in('id', itemIds)

  return { error }
}
