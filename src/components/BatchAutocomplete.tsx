import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { smartSearchRank } from '../lib/search'
import { formatIDR } from '../lib/format'
import FormattedPriceInput from './FormattedPriceInput'

interface BatchAutocompleteProps {
  value: string
  modalTotalValue?: string
  onChange: (batchName: string, batchModalTotal?: string) => void
  label?: string
  placeholder?: string
  required?: boolean
}

export interface BatchSuggestion {
  name: string
  modalTotal: number | null
  itemCount: number
  latestAt: string
}

interface BatchAutocompleteProps {
  value: string
  modalTotalValue?: string
  onChange: (batchName: string, batchModalTotal?: string) => void
  label?: string
  placeholder?: string
  required?: boolean
  existingBatches?: BatchSuggestion[]
}

export default function BatchAutocomplete({
  value,
  modalTotalValue = '',
  onChange,
  label = 'Batch',
  placeholder = 'Search or enter batch name...',
  required,
  existingBatches,
}: BatchAutocompleteProps) {
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<BatchSuggestion[]>([])
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
    // If existingBatches is passed by parent, skip fetching from Supabase
    if (existingBatches || !open || suggestions.length > 0) return

    let cancelled = false
    setLoading(true)

    async function loadBatches() {
      const { data } = await supabase
        .from('inventory_items')
        .select('batch_name, batch_modal_total, created_at')
        .not('batch_name', 'is', null)
        .order('created_at', { ascending: false })
        .limit(2000)

      if (cancelled) return

      const batchMap = new Map<string, BatchSuggestion>()
      for (const row of data ?? []) {
        const name = (row.batch_name as string).trim()
        if (!name) continue
        const modalTotal = row.batch_modal_total as number | null
        const existing = batchMap.get(name)
        if (existing) {
          existing.itemCount += 1
          if (row.created_at > existing.latestAt) existing.latestAt = row.created_at as string
          if (modalTotal && !existing.modalTotal) existing.modalTotal = modalTotal
        } else {
          batchMap.set(name, {
            name,
            modalTotal,
            itemCount: 1,
            latestAt: row.created_at as string,
          })
        }
      }

      // Sort by most recently used first
      const sorted = [...batchMap.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt))
      setSuggestions(sorted)
      setLoading(false)
    }

    loadBatches()
    return () => {
      cancelled = true
    }
  }, [existingBatches, open, suggestions.length])

  const activeSuggestions = existingBatches ?? suggestions

  const filteredSuggestions = useMemo(() => {
    if (!value.trim()) return activeSuggestions.slice(0, 8)
    return activeSuggestions
      .map((suggestion) => ({
        suggestion,
        rank: smartSearchRank(value, [{ value: suggestion.name }]),
      }))
      .filter((entry): entry is { suggestion: BatchSuggestion; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 8)
      .map((entry) => entry.suggestion)
  }, [activeSuggestions, value])

  const existingMatch = useMemo(() => {
    return activeSuggestions.find((s) => s.name.trim().toLowerCase() === value.trim().toLowerCase())
  }, [activeSuggestions, value])

  const isNewBatch = Boolean(value.trim()) && !existingMatch

  return (
    <div ref={containerRef} className={`relative ${open ? 'z-40' : 'z-10'}`}>
      {label && (
        <label className="mb-1 block text-sm font-medium text-gray-700">
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
          const newName = event.target.value
          const match = activeSuggestions.find(
            (s) => s.name.trim().toLowerCase() === newName.trim().toLowerCase()
          )
          onChange(newName, match?.modalTotal ? String(match.modalTotal) : modalTotalValue)
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
            <p className="px-3 py-3 text-sm text-gray-500">Loading batches...</p>
          ) : filteredSuggestions.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500">
              Type a new batch name to create it
            </p>
          ) : (
            filteredSuggestions.map((suggestion) => (
              <button
                key={suggestion.name}
                type="button"
                role="option"
                aria-selected={suggestion.name === value}
                onClick={() => {
                  onChange(
                    suggestion.name,
                    suggestion.modalTotal ? String(suggestion.modalTotal) : ''
                  )
                  setOpen(false)
                }}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left last:border-0 hover:bg-gray-50"
              >
                <span className="block text-sm font-medium text-gray-900">{suggestion.name}</span>
                <span className="block text-xs text-gray-500">
                  {suggestion.itemCount} item{suggestion.itemCount === 1 ? '' : 's'}
                  {suggestion.modalTotal
                    ? ` · ${formatIDR(suggestion.modalTotal)}`
                    : ''}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {isNewBatch && (
        <div className="mt-2">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Batch Modal Total *
          </label>
          <FormattedPriceInput
            required
            value={modalTotalValue}
            onChange={(newModalTotal) => onChange(value, newModalTotal)}
            placeholder="Enter total modal for this batch"
          />
          <p className="mt-1 text-xs text-amber-600">
            Creating new batch &quot;{value.trim()}&quot;. Batch modal total is required.
          </p>
        </div>
      )}
    </div>
  )
}
