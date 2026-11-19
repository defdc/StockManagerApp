/**
 * Helpers for normalizing and autocorrecting category names and item names.
 *
 * Unifies casing and spacing variants (e.g. "Matchbox" vs "MatchBox",
 * "prem" vs "Prem", "Blister Pop Race ..." vs "Blister POPRACE ...")
 * toward canonical / dominant casing without firing extra database queries.
 */

/**
 * Collapses multiple whitespace characters into a single space and trims ends.
 */
export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * Known brand / category token normalization rules.
 * Handles common diecast brand and category casing/spacing variants.
 */
const CANONICAL_BRAND_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bmatch\s*box\b/gi, replacement: 'Matchbox' },
  { pattern: /\bpop\s*race\b/gi, replacement: 'Pop Race' },
  { pattern: /\bhot\s*wheels\b/gi, replacement: 'Hot Wheels' },
  { pattern: /\bmini\s*gt\b/gi, replacement: 'Mini GT' },
  { pattern: /\bkaido\s*house\b/gi, replacement: 'Kaido House' },
  { pattern: /\btarmac\s*works\b/gi, replacement: 'Tarmac Works' },
  { pattern: /\btomica\b/gi, replacement: 'Tomica' },
  { pattern: /\binno\s*64\b/gi, replacement: 'Inno64' },
  { pattern: /\bmajorette\b/gi, replacement: 'Majorette' },
  { pattern: /\bgreen\s*light\b/gi, replacement: 'Greenlight' },
  { pattern: /\bjohnny\s*lightning\b/gi, replacement: 'Johnny Lightning' },
  { pattern: /\bblister\b/gi, replacement: 'Blister' },
  { pattern: /\bprem\b/gi, replacement: 'Prem' },
  { pattern: /\bpremium\b/gi, replacement: 'Premium' },
  { pattern: /\breg\b/gi, replacement: 'Reg' },
  { pattern: /\bregular\b/gi, replacement: 'Regular' },
  { pattern: /\bloose\b/gi, replacement: 'Loose' },
]

/**
 * Applies canonical brand and category token replacements while preserving
 * surrounding words and model identifiers.
 */
export function applyCanonicalBrandCasing(value: string): string {
  let result = normalizeWhitespace(value)
  if (!result) return ''
  for (const { pattern, replacement } of CANONICAL_BRAND_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return normalizeWhitespace(result)
}

/**
 * Normalized case-insensitive key after applying canonical brand token expansion.
 */
export function toCanonicalKey(value: string): string {
  return applyCanonicalBrandCasing(value).toLowerCase()
}

/**
 * Compact alphanumeric comparison key (strips spaces, hyphens, underscores)
 * so variants like "Pop Race" and "POPRACE" map to the same key.
 */
export function toCompactKey(value: string): string {
  return toCanonicalKey(value).replace(/[\s\-_]+/g, '')
}

/**
 * Scores the casing quality of a candidate display string so that clean
 * Title/Canonical casing ("Matchbox", "Prem", "Blister Pop Race") wins over
 * inconsistent variants ("MatchBox", "prem", "Blister POPRACE") even when
 * frequency counts are tied (e.g. in deduplicated autocomplete lists).
 */
export function scoreCasingQuality(value: string): number {
  const cleaned = normalizeWhitespace(value)
  if (!cleaned) return -100

  let score = 0
  const brandCanonical = applyCanonicalBrandCasing(cleaned)
  if (cleaned === brandCanonical) {
    score += 50
  }

  const words = cleaned.split(/\s+/)
  for (const word of words) {
    if (/^[A-Z][a-z0-9'-]*$/.test(word)) {
      // Clean Title Case word (e.g. "Matchbox", "Prem", "Blister", "Pop", "Race")
      score += 10
    } else if (/^[A-Z0-9-]{1,4}$/.test(word)) {
      // Short acronym / model code (e.g. "GT", "R34", "LBWK", "JDM", "STH")
      score += 8
    } else if (/^[a-z]+$/.test(word)) {
      // All-lowercase word (e.g. "prem", "matchbox")
      score -= 10
    } else if (/^[A-Z]{5,}$/.test(word)) {
      // Long all-uppercase word (e.g. "POPRACE", "MATCHBOX", "BLISTER")
      score -= 8
    } else if (/^[A-Z][a-z]+[A-Z][a-zA-Z]*$/.test(word)) {
      // Mid-word camelCase hump without digits (e.g. "MatchBox", "PopRace")
      score -= 5
    }
  }

  return score
}

interface VariantStats {
  counts: Map<string, number>
}

function addVariantToStats(map: Map<string, VariantStats>, key: string, variant: string) {
  if (!key || !variant) return
  let stats = map.get(key)
  if (!stats) {
    stats = { counts: new Map() }
    map.set(key, stats)
  }
  stats.counts.set(variant, (stats.counts.get(variant) ?? 0) + 1)
}

function resolveBestVariant(stats: VariantStats): string {
  let bestVariant = ''
  let bestScore = -Infinity

  for (const [variant, count] of stats.counts.entries()) {
    // Combine casing quality with frequency count so dominant clean casing wins,
    // while canonical brand fixes still override legacy casing typos.
    const totalScore = scoreCasingQuality(variant) + Math.min(count, 20) * 2
    if (totalScore > bestScore) {
      bestScore = totalScore
      bestVariant = variant
    }
  }

  return applyCanonicalBrandCasing(bestVariant)
}

/**
 * Builds lookup maps (by canonical key, compact key, and individual word)
 * from an iterable of existing strings.
 */
export function buildCanonicalLookup(knownValues: Iterable<string> = []) {
  const byCanonicalKey = new Map<string, VariantStats>()
  const byCompactKey = new Map<string, VariantStats>()
  const byWordKey = new Map<string, VariantStats>()

  for (const raw of knownValues) {
    if (!raw) continue
    const cleaned = normalizeWhitespace(raw)
    if (!cleaned) continue

    const canonicalVariant = applyCanonicalBrandCasing(cleaned)
    const cKey = toCanonicalKey(cleaned)
    const compactKey = toCompactKey(cleaned)

    addVariantToStats(byCanonicalKey, cKey, cleaned)
    addVariantToStats(byCanonicalKey, cKey, canonicalVariant)
    addVariantToStats(byCompactKey, compactKey, cleaned)
    addVariantToStats(byCompactKey, compactKey, canonicalVariant)

    for (const word of canonicalVariant.split(/\s+/)) {
      if (word.length >= 2) {
        addVariantToStats(byWordKey, word.toLowerCase(), word)
      }
    }
  }

  return {
    matchExactOrCompact(input: string): string | null {
      const cKey = toCanonicalKey(input)
      const exactStats = byCanonicalKey.get(cKey)
      if (exactStats) return resolveBestVariant(exactStats)

      const compactKey = toCompactKey(input)
      const compactStats = byCompactKey.get(compactKey)
      if (compactStats) return resolveBestVariant(compactStats)

      return null
    },
    matchWord(word: string): string | null {
      const stats = byWordKey.get(word.toLowerCase())
      return stats ? resolveBestVariant(stats) : null
    },
  }
}

/**
 * Autocorrects a category name:
 * 1. Collapses whitespace and trims.
 * 2. Applies canonical brand/category patterns ("MatchBox" -> "Matchbox", "prem" -> "Prem", "POPRACE" -> "Pop Race").
 * 3. Matches case-insensitively (and compact-insensitively) against known categories.
 * 4. Capitalizes leading lowercase category words (e.g. "diecast" -> "Diecast") while preserving acronyms.
 */
export function autocorrectCategory(
  input: string,
  knownCategories: Iterable<string> = []
): string {
  const cleaned = normalizeWhitespace(input)
  if (!cleaned) return ''

  const lookup = buildCanonicalLookup(knownCategories)
  const matched = lookup.matchExactOrCompact(cleaned)
  if (matched) return matched

  const brandNormalized = applyCanonicalBrandCasing(cleaned)
  const matchedAfterBrand = lookup.matchExactOrCompact(brandNormalized)
  if (matchedAfterBrand) return matchedAfterBrand

  // For new categories, capitalize all-lowercase words (e.g. "prem" -> "Prem")
  return brandNormalized
    .split(/\s+/)
    .map((word) => {
      const knownWord = lookup.matchWord(word)
      if (knownWord && /^[a-z]+$/.test(word)) return knownWord
      if (/^[a-z]/.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1)
      }
      return word
    })
    .join(' ')
}

/**
 * Autocorrects an item name:
 * 1. Collapses whitespace and trims.
 * 2. Applies canonical brand/category patterns ("Blister POPRACE ..." -> "Blister Pop Race ...", "MatchBox" -> "Matchbox").
 * 3. Matches case-insensitively (and compact-insensitively) against known item names.
 * 4. For partially new item names, upgrades all-lowercase words that have a known dominant casing in existing items.
 */
export function autocorrectItemName(
  input: string,
  knownItemNames: Iterable<string> = []
): string {
  const cleaned = normalizeWhitespace(input)
  if (!cleaned) return ''

  const lookup = buildCanonicalLookup(knownItemNames)
  const matched = lookup.matchExactOrCompact(cleaned)
  if (matched) return matched

  const brandNormalized = applyCanonicalBrandCasing(cleaned)
  const matchedAfterBrand = lookup.matchExactOrCompact(brandNormalized)
  if (matchedAfterBrand) return matchedAfterBrand

  return brandNormalized
    .split(/\s+/)
    .map((word) => {
      if (/^[a-z]+$/.test(word)) {
        const knownWord = lookup.matchWord(word)
        if (knownWord) return knownWord
      }
      return word
    })
    .join(' ')
}

/**
 * Deduplicates and canonicalizes a list of category strings, sorted alphabetically.
 */
export function deduplicateCategories(categories: Iterable<string>): string[] {
  const all = Array.from(categories).filter((c): c is string => Boolean(c && c.trim()))
  const lookup = buildCanonicalLookup(all)
  const seen = new Map<string, string>()

  for (const raw of all) {
    const canonical = lookup.matchExactOrCompact(raw) ?? autocorrectCategory(raw)
    if (!canonical) continue
    const key = toCompactKey(canonical)
    if (!seen.has(key)) {
      seen.set(key, canonical)
    }
  }

  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * Expands a search query into normalized lowercase words so searching for
 * "POPRACE" or "MatchBox" matches "Pop Race" or "Matchbox" in database ILIKE and local filters.
 */
export function expandSearchWords(query: string): string[] {
  const normalized = applyCanonicalBrandCasing(query).toLowerCase()
  return normalized.split(/\s+/).filter(Boolean)
}
