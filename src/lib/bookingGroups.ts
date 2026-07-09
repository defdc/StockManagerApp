export function bookingGroupDisplayId(groupId: string | null | undefined, knownGroupIds: string[]): string {
  if (!groupId) return '-'
  const uniqueGroupIds = Array.from(new Set(knownGroupIds.filter(Boolean))).sort()
  const index = uniqueGroupIds.indexOf(groupId)
  if (index < 0) return 'BG-????'
  return `BG-${String(index + 1).padStart(4, '0')}`
}
