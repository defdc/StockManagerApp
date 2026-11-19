import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  autocorrectCategory,
  buildCanonicalLookup,
  deduplicateCategories,
  expandSearchWords,
  toCompactKey,
  type CanonicalLookup,
} from '../lib/autocorrect'

interface IndexedCategory {
  name: string
  lowerName: string
  compactName: string
}

interface CategoryAutocompleteProps {
  value: string
  onChange: (value: string) => void
  label?: string
  required?: boolean
  placeholder?: string
  extraSuggestions?: string[]
  existingCategories?: string[]
  categoryLookup?: CanonicalLookup
}

const EMPTY_STRING_ARRAY: string[] = []

export default function CategoryAutocomplete({
  value,
  onChange,
  label = 'Category',
  required,
  placeholder = 'Search or enter category...',
  extraSuggestions = EMPTY_STRING_ARRAY,
  existingCategories,
  categoryLookup: externalCategoryLookup,
}: CategoryAutocompleteProps) {
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  const [openUpward, setOpenUpward] = useState(false)

  const updatePosition = () => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    setOpenUpward(spaceBelow < 220 && spaceAbove > spaceBelow)
  }

  useEffect(() => {
    if (open) {
      updatePosition()
      window.addEventListener('resize', updatePosition)
      window.addEventListener('scroll', updatePosition, true)
      return () => {
        window.removeEventListener('resize', updatePosition)
        window.removeEventListener('scroll', updatePosition, true)
      }
    }
  }, [open])

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  useEffect(() => {
    // If existingCategories is passed by parent, skip fetching from Supabase
    if (existingCategories || !open) return

    const trimmed = value.trim()
    if (trimmed.length < 2) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    const timer = window.setTimeout(async () => {
      try {
        let query = supabase
          .from('inventory_items')
          .select('category')
          .not('category', 'is', null)

        const searchWords = expandSearchWords(trimmed)
        searchWords.forEach((word) => {
          query = query.ilike('category', `%${word}%`)
        })

        const { data } = await query
          .order('category')
          .limit(50)

        if (cancelled) return

        const rawCategories = (data ?? [])
          .map((row) => (row.category as string | null) ?? '')
          .filter((raw) => Boolean(raw.trim()))

        setCategories(deduplicateCategories(rawCategories))
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }, 600)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [existingCategories, open, value])

  const { indexedCategories, compactCategorySet, activeCategoryLookup } = useMemo(() => {
    const sourceCategories = existingCategories ?? categories
    const allRaw = [...extraSuggestions, ...sourceCategories]
    const lookup = externalCategoryLookup ?? buildCanonicalLookup(allRaw)
    const deduped = deduplicateCategories(allRaw, lookup)
    const compactSet = new Set<string>()
    const indexed: IndexedCategory[] = deduped.map((cat) => {
      const compact = toCompactKey(cat)
      compactSet.add(compact)
      return {
        name: cat,
        lowerName: cat.toLowerCase(),
        compactName: compact,
      }
    })
    return {
      indexedCategories: indexed,
      compactCategorySet: compactSet,
      activeCategoryLookup: lookup,
    }
  }, [existingCategories, categories, extraSuggestions, externalCategoryLookup])

  const filtered = useMemo(() => {
    const trimmed = value.trim()
    if (!trimmed) return indexedCategories.slice(0, 10)
    const searchWords = expandSearchWords(trimmed)
    const compactQuery = toCompactKey(trimmed)
    const results: IndexedCategory[] = []

    for (let i = 0; i < indexedCategories.length; i++) {
      const c = indexedCategories[i]
      if (
        searchWords.every((w) => c.lowerName.includes(w)) ||
        (compactQuery.length > 0 && c.compactName.includes(compactQuery))
      ) {
        results.push(c)
        if (results.length >= 10) break
      }
    }

    return results
  }, [indexedCategories, value])

  // Whether the typed value matches an existing category (case-insensitive / canonical)
  const valueCompactKey = useMemo(() => (value.trim() ? toCompactKey(value) : ''), [value])
  const isExisting = valueCompactKey ? compactCategorySet.has(valueCompactKey) : false
  const previewAutocorrected = useMemo(
    () => (value.trim() ? autocorrectCategory(value, activeCategoryLookup) : ''),
    [value, activeCategoryLookup]
  )

  return (
    <div ref={containerRef} className={`relative ${open ? 'z-40' : 'z-10'}`}>
      {label && (
        <label className="mb-1 block text-sm font-medium text-gray-700">
          {label}{required && ' *'}
        </label>
      )}
      <input
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        required={required}
        value={value}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true)
          updatePosition()
        }}
        onBlur={() => {
          if (!value.trim()) return
          const corrected = autocorrectCategory(value, activeCategoryLookup)
          if (corrected && corrected !== value) {
            onChange(corrected)
          }
        }}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          updatePosition()
        }}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className={`absolute z-50 w-full max-h-56 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-xl ${
            openUpward ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {loading ? (
            <p className="px-3 py-3 text-sm text-gray-500">Loading categories...</p>
          ) : filtered.length === 0 ? (
            value.trim() ? (
              <p className="px-3 py-3 text-sm text-gray-500">
                Press Enter or click away to create <strong>{previewAutocorrected}</strong>
              </p>
            ) : (
              <p className="px-3 py-3 text-sm text-gray-500">No categories yet — type to create one</p>
            )
          ) : (
            <>
              {filtered.map((cat) => (
                <button
                  key={cat.name}
                  type="button"
                  role="option"
                  aria-selected={cat.compactName === valueCompactKey}
                  onMouseDown={(event) => {
                    // Prevent input onBlur from firing before option click applies
                    event.preventDefault()
                  }}
                  onClick={() => {
                    onChange(cat.name)
                    setOpen(false)
                  }}
                  className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-gray-50"
                >
                  {cat.name}
                </button>
              ))}
              {value.trim() && !isExisting && (
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault()
                  }}
                  onClick={() => {
                    onChange(previewAutocorrected)
                    setOpen(false)
                  }}
                  className="block w-full border-t border-gray-200 px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                >
                  + Create &ldquo;{previewAutocorrected}&rdquo;
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
