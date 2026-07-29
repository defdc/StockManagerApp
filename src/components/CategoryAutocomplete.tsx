import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

interface CategoryAutocompleteProps {
  value: string
  onChange: (value: string) => void
  label?: string
  required?: boolean
  placeholder?: string
}

export default function CategoryAutocomplete({
  value,
  onChange,
  label = 'Category',
  required,
  placeholder = 'Search or enter category...',
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
    if (!open || categories.length > 0) return

    let cancelled = false
    setLoading(true)

    async function loadCategories() {
      const { data } = await supabase
        .from('inventory_items')
        .select('category')
        .not('category', 'is', null)
        .order('category')
        .limit(2000)

      if (cancelled) return

      // Deduplicate: trim + case-insensitive comparison, preserve first-seen casing
      const seen = new Map<string, string>() // normalized key → original display value
      for (const row of data ?? []) {
        const raw = (row.category as string).trim()
        if (!raw) continue
        const key = raw.toLowerCase()
        if (!seen.has(key)) seen.set(key, raw)
      }

      setCategories([...seen.values()].sort((a, b) => a.localeCompare(b)))
      setLoading(false)
    }

    loadCategories()
    return () => { cancelled = true }
  }, [open, categories.length])

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return categories.slice(0, 10)
    return categories.filter((c) => c.toLowerCase().includes(q)).slice(0, 10)
  }, [categories, value])

  // Whether the typed value matches an existing category (case-insensitive)
  const isExisting = categories.some((c) => c.toLowerCase() === value.trim().toLowerCase())

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
                Press Enter or click away to create <strong>{value.trim()}</strong>
              </p>
            ) : (
              <p className="px-3 py-3 text-sm text-gray-500">No categories yet — type to create one</p>
            )
          ) : (
            <>
              {filtered.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  role="option"
                  aria-selected={cat.toLowerCase() === value.trim().toLowerCase()}
                  onClick={() => {
                    onChange(cat)
                    setOpen(false)
                  }}
                  className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-gray-50"
                >
                  {cat}
                </button>
              ))}
              {value.trim() && !isExisting && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(value.trim())
                    setOpen(false)
                  }}
                  className="block w-full border-t border-gray-200 px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                >
                  + Create &ldquo;{value.trim()}&rdquo;
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
