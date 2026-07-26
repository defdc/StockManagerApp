import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { smartSearchRank } from '../lib/search'

interface BatchAutocompleteProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
}

interface BatchSuggestion {
  name: string
  itemCount: number
  latestAt: string
}

export default function BatchAutocomplete({
  value,
  onChange,
  label = 'Batch',
  placeholder = 'Search or enter batch name...',
}: BatchAutocompleteProps) {
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<BatchSuggestion[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    setLoading(true)

    async function loadBatches() {
      const { data } = await supabase
        .from('inventory_items')
        .select('batch_name, created_at')
        .not('batch_name', 'is', null)
        .order('created_at', { ascending: false })
        .limit(2000)

      if (cancelled) return

      const batchMap = new Map<string, BatchSuggestion>()
      for (const row of data ?? []) {
        const name = (row.batch_name as string).trim()
        if (!name) continue
        const existing = batchMap.get(name)
        if (existing) {
          existing.itemCount += 1
          if (row.created_at > existing.latestAt) existing.latestAt = row.created_at as string
        } else {
          batchMap.set(name, { name, itemCount: 1, latestAt: row.created_at as string })
        }
      }

      // Sort by most recently used first
      const sorted = [...batchMap.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt))
      setSuggestions(sorted)
      setLoading(false)
    }

    loadBatches()
    return () => { cancelled = true }
  }, [open])

  const filteredSuggestions = useMemo(() => {
    if (!value.trim()) return suggestions.slice(0, 8)
    return suggestions
      .map((suggestion) => ({
        suggestion,
        rank: smartSearchRank(value, [{ value: suggestion.name }]),
      }))
      .filter((entry): entry is { suggestion: BatchSuggestion; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 8)
      .map((entry) => entry.suggestion)
  }, [suggestions, value])

  return (
    <div ref={containerRef} className="relative">
      {label && <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>}
      <input
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
        >
          {loading ? (
            <p className="px-3 py-3 text-sm text-gray-500">Loading batches...</p>
          ) : filteredSuggestions.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500">Type a new batch name to create it</p>
          ) : (
            filteredSuggestions.map((suggestion) => (
              <button
                key={suggestion.name}
                type="button"
                role="option"
                aria-selected={suggestion.name === value}
                onClick={() => {
                  onChange(suggestion.name)
                  setOpen(false)
                }}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left last:border-0 hover:bg-gray-50"
              >
                <span className="block text-sm font-medium text-gray-900">{suggestion.name}</span>
                <span className="block text-xs text-gray-500">{suggestion.itemCount} item{suggestion.itemCount === 1 ? '' : 's'}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
