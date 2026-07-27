import { supabase } from './supabase'

/**
 * Normalizes a buyer name for comparison:
 * Trims whitespace, replaces multiple spaces with a single space, and lowercases.
 */
export function normalizeBuyerName(name: string): string {
  return name.trim().replaceAll(/\s+/g, ' ').toLowerCase()
}

/**
 * Strip punctuation / non-alphanumeric chars at start & end of string
 */
export function cleanBuyerName(name: string): string {
  return normalizeBuyerName(name).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}

/**
 * Computes standard Levenshtein distance between strings a and b.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion
        dp[i][j - 1] + 1,       // insertion
        dp[i - 1][j - 1] + cost // substitution
      )
    }
  }

  return dp[m][n]
}

/**
 * Calculates string similarity percentage (0.0 to 1.0).
 */
export function stringSimilarity(a: string, b: string): number {
  const normA = normalizeBuyerName(a)
  const normB = normalizeBuyerName(b)
  if (normA === normB) return 1
  const maxLen = Math.max(normA.length, normB.length)
  if (maxLen === 0) return 1
  const dist = levenshteinDistance(normA, normB)
  return 1 - dist / maxLen
}

export type BuyerMatchStatus = 'exact' | 'single_match' | 'ambiguous' | 'new'

export interface BuyerMatchResult {
  importedName: string
  status: BuyerMatchStatus
  selectedName: string // The buyer name to be used (target)
  candidates: { name: string; similarity: number; distance: number }[]
  confidence: number // 0 to 1
}

/**
 * Fetches all distinct existing buyer names from Supabase (from bookings and sales tables).
 * Preserves the original casing as stored in the DB.
 */
export async function fetchExistingBuyerNames(): Promise<string[]> {
  const [bookingsRes, salesRes] = await Promise.all([
    supabase.from('bookings').select('buyer_name').limit(2000),
    supabase.from('sales').select('buyer_name').limit(2000),
  ])

  const nameMap = new Map<string, string>() // normalized -> canonical name
  for (const row of [...(bookingsRes.data ?? []), ...(salesRes.data ?? [])]) {
    const raw = row.buyer_name?.trim()
    if (!raw) continue
    const norm = normalizeBuyerName(raw)
    if (!nameMap.has(norm)) {
      nameMap.set(norm, raw)
    }
  }

  return [...nameMap.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * Matches an imported buyer name against a list of existing buyer names using fuzzy logic.
 */
export function matchBuyerName(
  importedName: string,
  existingNames: string[]
): BuyerMatchResult {
  const trimmed = importedName.trim()
  const normImported = normalizeBuyerName(trimmed)
  const cleanedImported = cleanBuyerName(trimmed)

  if (!trimmed) {
    return {
      importedName: trimmed,
      status: 'new',
      selectedName: trimmed,
      candidates: [],
      confidence: 0,
    }
  }

  // 1. Exact match check (case-insensitive & whitespace normalized)
  const exact = existingNames.find((existing) => normalizeBuyerName(existing) === normImported)
  if (exact) {
    return {
      importedName: trimmed,
      status: 'exact',
      selectedName: exact,
      candidates: [{ name: exact, similarity: 1, distance: 0 }],
      confidence: 1,
    }
  }

  // 1b. Cleaned match check (ignoring trailing punctuation like backslashes/dots)
  const cleanedExact = existingNames.find(
    (existing) => cleanBuyerName(existing) === cleanedImported && cleanedImported.length >= 3
  )
  if (cleanedExact) {
    return {
      importedName: trimmed,
      status: 'exact',
      selectedName: cleanedExact,
      candidates: [{ name: cleanedExact, similarity: 0.98, distance: 0 }],
      confidence: 0.98,
    }
  }

  // 2. Fuzzy matching against existing buyers
  const candidates: { name: string; similarity: number; distance: number }[] = []

  for (const existing of existingNames) {
    const normExisting = normalizeBuyerName(existing)
    const dist = levenshteinDistance(normImported, normExisting)
    const sim = stringSimilarity(normImported, normExisting)
    const minLen = Math.min(normImported.length, normExisting.length)

    // Threshold rules to avoid false positives (e.g. "Andi" vs "Budi"):
    // - Short names (len <= 3): must be exact (handled above)
    // - Medium names (len 4-7): max distance <= 1 AND similarity >= 0.75
    // - Longer names (len >= 8): max distance <= 2 AND similarity >= 0.75
    let matchesThreshold = false
    if (minLen <= 3) {
      matchesThreshold = false
    } else if (minLen <= 7) {
      matchesThreshold = dist <= 1 && sim >= 0.75
    } else {
      matchesThreshold = dist <= 2 && sim >= 0.75
    }

    if (matchesThreshold) {
      candidates.push({ name: existing, similarity: sim, distance: dist })
    }
  }

  // Sort candidates by best similarity (highest sim, lowest distance)
  candidates.sort((a, b) => b.similarity - a.similarity || a.distance - b.distance)

  if (candidates.length === 1) {
    return {
      importedName: trimmed,
      status: 'single_match',
      selectedName: candidates[0].name,
      candidates,
      confidence: candidates[0].similarity,
    }
  } else if (candidates.length > 1) {
    const topSim = candidates[0].similarity
    const secondSim = candidates[1].similarity

    if (topSim - secondSim >= 0.15 && topSim >= 0.9) {
      return {
        importedName: trimmed,
        status: 'single_match',
        selectedName: candidates[0].name,
        candidates,
        confidence: topSim,
      }
    }

    return {
      importedName: trimmed,
      status: 'ambiguous',
      selectedName: candidates[0].name, // Default to top candidate for dropdown
      candidates,
      confidence: candidates[0].similarity,
    }
  }

  return {
    importedName: trimmed,
    status: 'new',
    selectedName: trimmed,
    candidates: [],
    confidence: 0,
  }
}
