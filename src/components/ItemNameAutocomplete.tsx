import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

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
    if (!open || records.length > 0) return

    let cancelled = false
    setLoading(true)

    async function loadItemNames() {
      const { data } = await supabase
        .from('inventory_items')
        .select('item_name, category, notes')
        .not('item_name', 'is', null)
        .order('created_at', { ascending: false })
        .limit(2000)

      if (cancelled) return

      const seen = new Map<string, ItemSuggestionRecord>()
      for (const row of data ?? []) {
        const raw = (row.item_name as string || '').trim()
        if (!raw) continue
        const key = raw.toLowerCase()
        if (!seen.has(key)) {
          seen.set(key, {
            item_name: raw,
            category: row.category ? String(row.category).trim() : null,
            notes: row.notes ? String(row.notes).trim() : null,
          })
        }
      }

      setRecords([...seen.values()].sort((a, b) => a.item_name.localeCompare(b.item_name)))
      setLoading(false)
    }

    loadItemNames()
    return () => {
      cancelled = true
    }
  }, [open, records.length])

  const combinedRecords = useMemo(() => {
    const seen = new Map<string, ItemSuggestionRecord>()

    // 1. Extra records from session
    for (const rec of extraRecords) {
      const raw = (rec.item_name || '').trim()
      if (!raw) continue
      const key = raw.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, {
          item_name: raw,
          category: rec.category ? rec.category.trim() : null,
          notes: rec.notes ? rec.notes.trim() : null,
        })
      }
    }

    // 2. Extra string suggestions
    for (const item of extraSuggestions) {
      const raw = (item || '').trim()
      if (!raw) continue
      const key = raw.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, { item_name: raw })
      }
    }

    // 3. Database records
    for (const rec of records) {
      const raw = (rec.item_name || '').trim()
      if (!raw) continue
      const key = raw.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, rec)
      }
    }

    return [...seen.values()].sort((a, b) => a.item_name.localeCompare(b.item_name))
  }, [records, extraSuggestions, extraRecords])

  const filteredRecords = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return combinedRecords.slice(0, 10)
    return combinedRecords.filter((r) => r.item_name.toLowerCase().includes(q)).slice(0, 10)
  }, [combinedRecords, value])

  const isExisting = combinedRecords.some((r) => r.item_name.toLowerCase() === value.trim().toLowerCase())

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
                Type new item name <strong>{value.trim()}</strong>
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
                  aria-selected={rec.item_name.toLowerCase() === value.trim().toLowerCase()}
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
                  onClick={() => {
                    const trimmed = value.trim()
                    onChange(trimmed)
                    const existingRec = combinedRecords.find((r) => r.item_name.toLowerCase() === trimmed.toLowerCase())
                    if (existingRec) {
                      onSelectRecord?.(existingRec)
                    } else {
                      onSelectRecord?.({ item_name: trimmed })
                    }
                    setOpen(false)
                  }}
                  className="block w-full border-t border-gray-200 px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                >
                  + Use &ldquo;{value.trim()}&rdquo;
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

