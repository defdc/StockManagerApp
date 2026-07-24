const currencyFormatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
})

export function formatIDR(value: number | null | undefined): string {
  return currencyFormatter.format(value ?? 0)
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatStatus(value: string): string {
  const words = value.replaceAll('_', ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Splits `total` (integer Rupiah) evenly across `count` slots.
 * Any remainder (from integer division) is added to the last slot,
 * so the values always sum exactly to `total` with no decimals.
 *
 * @example
 * splitAmount(100000, 3) // → [33333, 33333, 33334]
 */
export function splitAmount(total: number, count: number): number[] {
  if (count <= 0) return []
  const base = Math.floor(total / count)
  const remainder = total - base * count
  return Array.from({ length: count }, (_, i) =>
    i === count - 1 ? base + remainder : base
  )
}
