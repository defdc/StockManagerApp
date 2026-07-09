interface SearchField {
  value: string | null | undefined
  kind?: 'primary' | 'notes'
}

function normalize(value: string): string {
  return value.toLowerCase().trim()
}

export function searchTokens(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

export function smartSearchRank(query: string, fields: SearchField[]): number | null {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return 0

  let totalRank = 0
  for (const token of tokens) {
    let bestRank: number | null = null

    for (const field of fields) {
      const value = normalize(field.value ?? '')
      if (!value) continue

      let rank: number | null = null
      if (value.startsWith(token)) rank = field.kind === 'notes' ? 2 : 0
      else if (value.includes(token)) rank = field.kind === 'notes' ? 2 : 1

      if (rank !== null && (bestRank === null || rank < bestRank)) bestRank = rank
    }

    if (bestRank === null) return null
    totalRank += bestRank
  }

  return totalRank
}

export function compareBySmartSearch<T>(
  query: string,
  items: T[],
  fieldsForItem: (item: T) => SearchField[]
): T[] {
  return items
    .map((item) => ({ item, rank: smartSearchRank(query, fieldsForItem(item)) }))
    .filter((entry): entry is { item: T; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.item)
}
