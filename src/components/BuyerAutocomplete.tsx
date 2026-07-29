import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { smartSearchRank } from '../lib/search'

interface BuyerAutocompleteProps {
  value: string
  onChange: (value: string) => void
  label?: string
  required?: boolean
  placeholder?: string
}

interface BuyerSuggestion {
  name: string
  purchases: number
  transactions: number
}

export default function BuyerAutocomplete({
  value,
  onChange,
  label = 'Buyer name',
  required,
  placeholder = 'Search or enter buyer name...',
}: BuyerAutocompleteProps) {
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<BuyerSuggestion[]>([])
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
    if (!open) return

    let cancelled = false
    setLoading(true)

    async function loadBuyerNames() {
      const [bookingsRes, salesRes] = await Promise.all([
        supabase.from('bookings').select('buyer_name').limit(1000),
        supabase.from('sales').select('buyer_name').limit(1000),
      ])

      if (cancelled) return

      const suggestionsByName = new Map<string, BuyerSuggestion>()
      function ensureSuggestion(rawName: string): BuyerSuggestion {
        const name = rawName.trim()
        const existingName = [...suggestionsByName.keys()].find(
          (candidate) => candidate.toLowerCase() === name.toLowerCase()
        )
        if (existingName) return suggestionsByName.get(existingName) as BuyerSuggestion
        const suggestion = { name, purchases: 0, transactions: 0 }
        suggestionsByName.set(name, suggestion)
        return suggestion
      }

      for (const row of bookingsRes.data ?? []) {
        const name = row.buyer_name?.trim()
        if (!name) continue
        ensureSuggestion(name).transactions += 1
      }

      for (const row of salesRes.data ?? []) {
        const name = row.buyer_name?.trim()
        if (!name) continue
        const suggestion = ensureSuggestion(name)
        suggestion.transactions += 1
        suggestion.purchases += 1
      }

      setSuggestions(
        [...suggestionsByName.values()].sort(
          (a, b) => b.purchases - a.purchases || b.transactions - a.transactions || a.name.localeCompare(b.name)
        )
      )
      setLoading(false)
    }

    loadBuyerNames()

    return () => {
      cancelled = true
    }
  }, [open])

  const filteredSuggestions = useMemo(() => {
    return suggestions
      .map((suggestion) => ({
        suggestion,
        rank: smartSearchRank(value, [{ value: suggestion.name }]),
      }))
      .filter((entry): entry is { suggestion: BuyerSuggestion; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank || b.suggestion.purchases - a.suggestion.purchases)
      .slice(0, 8)
      .map((entry) => entry.suggestion)
  }, [suggestions, value])

  return (
    <div ref={containerRef} className={`relative ${open ? 'z-40' : 'z-10'}`}>
      {label && <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>}
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
            <p className="px-3 py-3 text-sm text-gray-500">Loading buyers...</p>
          ) : filteredSuggestions.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500">Type a new buyer name</p>
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
                <span className="block text-xs text-gray-500">
                  {suggestion.purchases} previous purchase{suggestion.purchases === 1 ? '' : 's'}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
