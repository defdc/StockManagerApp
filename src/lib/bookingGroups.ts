/**
 * Returns a sequential display ID like "BG-0001" for a booking group.
 * Used primarily for CSV export and fallback display.
 */
export function bookingGroupDisplayId(groupId: string | null | undefined, knownGroupIds: string[]): string {
  if (!groupId) return '-'
  const uniqueGroupIds = Array.from(new Set(knownGroupIds.filter(Boolean))).sort()
  const index = uniqueGroupIds.indexOf(groupId)
  if (index < 0) return 'BG-????'
  return `BG-${String(index + 1).padStart(4, '0')}`
}

/**
 * Returns a human-readable group label like "Shakasky · 22 Jul".
 * If all bookings/sales in the group share the same buyer, shows "{buyer} · {date}".
 * Falls back to BG-XXXX if buyers are mixed (shouldn't normally happen).
 */
export function bookingGroupFriendlyLabel(
  groupId: string | null | undefined,
  rows: Array<{ booking_group_id: string | null | undefined; buyer_name: string; created_at: string }>,
  knownGroupIds: string[]
): string {
  if (!groupId) return '-'

  const groupRows = rows.filter((r) => r.booking_group_id === groupId)
  if (groupRows.length === 0) return bookingGroupDisplayId(groupId, knownGroupIds)

  // Check if all buyers match
  const buyers = Array.from(new Set(groupRows.map((r) => r.buyer_name.trim())))
  if (buyers.length !== 1) {
    // Mixed buyers — fall back to BG-XXXX
    return bookingGroupDisplayId(groupId, knownGroupIds)
  }

  // Format date as "22 Jul" from the first row's created_at
  const firstRow = groupRows[0]
  const date = new Date(firstRow.created_at)
  const dateLabel = Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' }).format(date)

  return dateLabel ? `${buyers[0]} · ${dateLabel}` : buyers[0]
}
