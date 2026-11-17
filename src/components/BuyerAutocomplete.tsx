import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

interface BuyerAutocompleteProps {
  value: string
  onChange: (value: string) => void
  label?: string
  required?: boolean
  placeholder?: string
  existingBuyers?: string[]
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
  existingBuyers,
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

    const timer = window.setTimeout(async () => {
      try {
        let query = supabase
          .from('buyer_summaries')
          .select('buyer_name, purchased, booked')
          .not('buyer_name', 'is', null)

        const searchWords = value.toLowerCase().trim().split(/\s+/).filter(Boolean)
        searchWords.forEach((word) => {
          query = query.ilike('buyer_name', `%${word}%`)
        })

        const { data } = await query
          .order('purchased', { ascending: false })
          .order('booked', { ascending: false })
          .order('buyer_name', { ascending: true })
          .limit(50)

        if (cancelled) return

        const seen = new Map<string, BuyerSuggestion>()
        for (const row of data ?? []) {
          const name = String(row.buyer_name ?? '').trim()
          if (!name) continue
          const key = name.toLowerCase()
          if (!seen.has(key)) {
            const purchases = Number(row.purchased ?? 0)
            const booked = Number(row.booked ?? 0)
            seen.set(key, {
              name,
              purchases,
              transactions: purchases + booked,
            })
          }
        }

        setSuggestions([...seen.values()])
      } catch {
        // ignore errors
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, value])

  const combinedSuggestions = useMemo(() => {
    const seen = new Map<string, BuyerSuggestion>()

    for (const suggestion of suggestions) {
      const key = suggestion.name.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, suggestion)
      }
    }

    for (const raw of existingBuyers ?? []) {
      const name = raw.trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, { name, purchases: 0, transactions: 0 })
      }
    }

    return [...seen.values()]
  }, [suggestions, existingBuyers])

  const filteredSuggestions = useMemo(() => {
    const trimmed = value.trim()
    if (!trimmed) {
      return combinedSuggestions.slice(0, 50)
    }

    const searchWords = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
    const searchLower = trimmed.toLowerCase()

    return combinedSuggestions
      .filter((buyer) => {
        const normalizedName = buyer.name.toLowerCase()
        return searchWords.every((word) => normalizedName.includes(word))
      })
      .sort((a, b) => {
        const aLower = a.name.toLowerCase()
        const bLower = b.name.toLowerCase()
        const aStarts = aLower.startsWith(searchLower) ? 0 : 1
        const bStarts = bLower.startsWith(searchLower) ? 0 : 1
        return (
          aStarts - bStarts ||
          b.purchases - a.purchases ||
          b.transactions - a.transactions ||
          a.name.localeCompare(b.name)
        )
      })
      .slice(0, 50)
  }, [combinedSuggestions, value])

  const isExisting = combinedSuggestions.some(
    (s) => s.name.toLowerCase() === value.trim().toLowerCase()
  )

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
            value.trim() ? (
              <button
                type="button"
                onClick={() => {
                  onChange(value.trim())
                  setOpen(false)
                }}
                className="block w-full px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
              >
                + Use &ldquo;{value.trim()}&rdquo;
              </button>
            ) : (
              <p className="px-3 py-3 text-sm text-gray-500">Type a new buyer name</p>
            )
          ) : (
            <>
              {filteredSuggestions.map((suggestion) => (
                <button
                  key={suggestion.name}
                  type="button"
                  role="option"
                  aria-selected={suggestion.name.toLowerCase() === value.trim().toLowerCase()}
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
