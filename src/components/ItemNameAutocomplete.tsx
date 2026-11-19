import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  autocorrectCategory,
  autocorrectItemName,
  expandSearchWords,
  toCompactKey,
} from '../lib/autocorrect'

export interface ItemSuggestionRecord {
  item_name: string
  category?: string | null
  notes?: string | null
}

interface ItemNameAutocompleteProps {
  value: string
  onChange: (value: string) => void
  onSelectRecord?: (record: ItemSuggestionRecord) => void
  label?: string
  labelClassName?: string
  required?: boolean
  placeholder?: string
  extraSuggestions?: string[]
  extraRecords?: ItemSuggestionRecord[]
  existingRecords?: ItemSuggestionRecord[]
}

export default function ItemNameAutocomplete({
  value,
  onChange,
  onSelectRecord,
  label,
  labelClassName = 'mb-1 block text-xs font-medium text-gray-600 sm:hidden',
  required,
  placeholder = 'Search or enter item name...',
  extraSuggestions = [],
  extraRecords = [],
  existingRecords,
}: ItemNameAutocompleteProps) {
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<ItemSuggestionRecord[]>([])
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
    // If existingRecords is passed by parent, skip fetching from Supabase
    if (existingRecords || !open) return

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
          .select('item_name, category, notes')
          .not('item_name', 'is', null)

        const searchWords = expandSearchWords(trimmed)
        searchWords.forEach((word) => {
          query = query.ilike('item_name', `%${word}%`)
        })

        const { data } = await query
          .order('item_name', { ascending: true })
          .limit(50)

        if (cancelled) return

        const allFetchedNames = (data ?? [])
          .map((row) => ((row.item_name as string) || '').trim())
          .filter(Boolean)
        const allFetchedCategories = (data ?? [])
          .map((row) => ((row.category as string) || '').trim())
          .filter(Boolean)

        const seen = new Map<string, ItemSuggestionRecord>()
        for (const row of data ?? []) {
          const raw = ((row.item_name as string) || '').trim()
          if (!raw) continue
          const canonicalName = autocorrectItemName(raw, allFetchedNames)
          const key = toCompactKey(canonicalName)
          const canonicalCat = row.category
            ? autocorrectCategory(String(row.category), allFetchedCategories)
            : null
          const existing = seen.get(key)
          if (!existing) {
            seen.set(key, {
              item_name: canonicalName,
              category: canonicalCat,
              notes: row.notes ? String(row.notes).trim() : null,
            })
          } else {
            // Fill in missing category/notes if a later row has them
            if (!existing.category && canonicalCat) existing.category = canonicalCat
            if (!existing.notes && row.notes) existing.notes = String(row.notes).trim()
          }
        }

        setRecords([...seen.values()].sort((a, b) => a.item_name.localeCompare(b.item_name)))
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
  }, [existingRecords, open, value])

  const combinedRecords = useMemo(() => {
    const sourceRecords = existingRecords ?? records
    const allNames: string[] = [
      ...extraRecords.map((r) => r.item_name),
      ...extraSuggestions,
      ...sourceRecords.map((r) => r.item_name),
    ].filter((n): n is string => Boolean(n && n.trim()))

    const allCategories: string[] = [
      ...extraRecords.map((r) => r.category),
      ...sourceRecords.map((r) => r.category),
    ].filter((c): c is string => Boolean(c && c.trim()))

    const seen = new Map<string, ItemSuggestionRecord>()

    function addRecord(rec: ItemSuggestionRecord) {
      const raw = (rec.item_name || '').trim()
      if (!raw) return
      const canonicalName = autocorrectItemName(raw, allNames)
      const key = toCompactKey(canonicalName)
      const canonicalCat = rec.category
        ? autocorrectCategory(rec.category, allCategories)
        : null
      const notes = rec.notes ? rec.notes.trim() : null
      const existing = seen.get(key)
      if (!existing) {
        seen.set(key, {
          item_name: canonicalName,
          category: canonicalCat,
          notes,
        })
      } else {
        if (!existing.category && canonicalCat) existing.category = canonicalCat
        if (!existing.notes && notes) existing.notes = notes
      }
    }

    // 1. Extra records from session
    for (const rec of extraRecords) addRecord(rec)
    // 2. Extra string suggestions
    for (const item of extraSuggestions) addRecord({ item_name: item })
    // 3. Database / provided existing records
    for (const rec of sourceRecords) addRecord(rec)

    return [...seen.values()].sort((a, b) => a.item_name.localeCompare(b.item_name))
  }, [existingRecords, records, extraSuggestions, extraRecords])

  const knownItemNames = useMemo(
    () => combinedRecords.map((r) => r.item_name),
    [combinedRecords]
  )

  const filteredRecords = useMemo(() => {
    const trimmed = value.trim()
    if (!trimmed) return combinedRecords.slice(0, 50)

    const searchWords = expandSearchWords(trimmed)
    const compactQuery = toCompactKey(trimmed)
    return combinedRecords
      .filter((r) => {
        const normalizedItemName = r.item_name.toLowerCase()
        const compactItemName = toCompactKey(r.item_name)
        return (
          searchWords.every((word) => normalizedItemName.includes(word)) ||
          (compactQuery.length > 0 && compactItemName.includes(compactQuery))
        )
      })
      .slice(0, 50)
  }, [combinedRecords, value])

  const isExisting = combinedRecords.some((r) => toCompactKey(r.item_name) === toCompactKey(value))
  const previewAutocorrected = useMemo(
    () => (value.trim() ? autocorrectItemName(value, knownItemNames) : ''),
    [value, knownItemNames]
  )

  return (
    <div ref={containerRef} className={`relative ${open ? 'z-40' : 'z-10'}`}>
      {label && (
        <label className={labelClassName}>
          {label}
          {required && ' *'}
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
          const corrected = autocorrectItemName(value, knownItemNames)
          if (corrected && corrected !== value) {
            onChange(corrected)
          }
          const matchedRecord = combinedRecords.find(
            (r) => toCompactKey(r.item_name) === toCompactKey(corrected)
          )
          if (matchedRecord) {
            onSelectRecord?.(matchedRecord)
          }
        }}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          updatePosition()
        }}
        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-500 focus:outline-none"
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
            <p className="px-3 py-3 text-sm text-gray-500">Loading suggestions...</p>
          ) : filteredRecords.length === 0 ? (
            value.trim() ? (
              <p className="px-3 py-3 text-sm text-gray-500">
                Type new item name <strong>{previewAutocorrected}</strong>
              </p>
            ) : (
              <p className="px-3 py-3 text-sm text-gray-500">Type to search existing item names</p>
            )
          ) : (
            <>
              {filteredRecords.map((rec) => (
                <button
                  key={rec.item_name}
                  type="button"
                  role="option"
                  aria-selected={toCompactKey(rec.item_name) === toCompactKey(value)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                  }}
                  onClick={() => {
                    onChange(rec.item_name)
                    onSelectRecord?.(rec)
                    setOpen(false)
                  }}
                  className="flex w-full items-center justify-between border-b border-gray-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-gray-50"
                >
                  <span className="font-medium text-gray-900">{rec.item_name}</span>
                  {rec.category && (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                      {rec.category}
                    </span>
                  )}
                </button>
              ))}
              {value.trim() && !isExisting && (
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault()
                  }}
                  onClick={() => {
                    const corrected = previewAutocorrected
                    onChange(corrected)
                    const existingRec = combinedRecords.find(
                      (r) => toCompactKey(r.item_name) === toCompactKey(corrected)
                    )
                    if (existingRec) {
                      onSelectRecord?.(existingRec)
                    } else {
                      onSelectRecord?.({ item_name: corrected })
                    }
                    setOpen(false)
                  }}
                  className="block w-full border-t border-gray-200 px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                >
                  + Use &ldquo;{previewAutocorrected}&rdquo;
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

