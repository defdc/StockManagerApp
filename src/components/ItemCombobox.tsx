import { useEffect, useId, useRef, useState } from 'react'
import { formatIDR, formatStatus } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { InventoryItem } from '../types/database'

interface ItemComboboxProps {
  value: string | null
  onChange: (item: InventoryItem | null) => void
  allowedStatuses?: string[]
  placeholder?: string
  label?: string
  required?: boolean
}

const SEARCH_FIELDS = ['item_name', 'item_code', 'category', 'notes'] as const
const SUGGESTION_LIMIT = 20
const DEFAULT_ALLOWED_STATUSES = ['ready']

function itemLabel(item: InventoryItem): string {
  return `${item.item_code ? `[${item.item_code}] ` : ''}${item.item_name}`
}

async function findItems(search: string, statuses: string[]): Promise<InventoryItem[]> {
  const fields = search ? SEARCH_FIELDS : SEARCH_FIELDS.slice(0, 1)
  const results = await Promise.all(
    fields.map(async (field) => {
      let query = supabase
        .from('inventory_items')
        .select('*')
        .in('status', statuses)
        .order('item_name')
        .limit(SUGGESTION_LIMIT)

      if (search) query = query.ilike(field, `%${search}%`)

      const { data, error } = await query
      if (error) throw new Error(error.message)
      return data ?? []
    })
  )

  const uniqueItems = new Map<string, InventoryItem>()
  for (const item of results.flat()) uniqueItems.set(item.id, item)

  return [...uniqueItems.values()]
    .sort((a, b) => a.item_name.localeCompare(b.item_name))
    .slice(0, SUGGESTION_LIMIT)
}

export default function ItemCombobox({
  value,
  onChange,
  allowedStatuses,
  placeholder = 'Search by name, code, category, or notes...',
  label,
  required,
}: ItemComboboxProps) {
  const listboxId = useId()
  const statusKey = (allowedStatuses ?? DEFAULT_ALLOWED_STATUSES).join(',')
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<InventoryItem[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!value) {
      if (!selectedItem) return
      setSelectedItem(null)
      setQuery('')
      return
    }

    if (selectedItem?.id === value) return

    let cancelled = false
    async function loadSelectedItem() {
      const { data, error: itemError } = await supabase
        .from('inventory_items')
        .select('*')
        .eq('id', value)
        .single()

      if (!cancelled && !itemError && data) {
        setSelectedItem(data)
        setQuery(itemLabel(data))
      }
    }
    loadSelectedItem()

    return () => {
      cancelled = true
    }
  }, [selectedItem, value])

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  useEffect(() => {
    if (!open || selectedItem) return

    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(async () => {
      setError(null)
      try {
        const items = await findItems(query.trim(), statusKey.split(','))
        if (!cancelled) setSuggestions(items)
      } catch (searchError) {
        if (!cancelled) {
          setSuggestions([])
          setError(searchError instanceof Error ? searchError.message : 'Unable to search items.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, selectedItem, statusKey])

  function selectItem(item: InventoryItem) {
    setSelectedItem(item)
    setQuery(itemLabel(item))
    setOpen(false)
    onChange(item)
  }

  function clearItem() {
    setSelectedItem(null)
    setQuery('')
    setSuggestions([])
    setOpen(true)
    onChange(null)
  }

  return (
    <div ref={containerRef} className="relative">
      {label && <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>}
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          required={required}
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            if (selectedItem) {
              setSelectedItem(null)
              onChange(null)
            }
            setQuery(event.target.value)
            setOpen(true)
          }}
          className="w-full rounded-md border border-gray-300 px-3 py-2 pr-9 text-sm focus:border-gray-500 focus:outline-none"
        />
        {value && (
          <button
            type="button"
            onClick={clearItem}
            aria-label="Clear selected item"
            className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-700"
          >
            ✕
          </button>
        )}
      </div>

      {open && !selectedItem && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
        >
          {loading ? (
            <p className="px-3 py-3 text-sm text-gray-500">Searching items...</p>
          ) : error ? (
            <p className="px-3 py-3 text-sm text-red-600">{error}</p>
          ) : suggestions.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500">No matching items</p>
          ) : (
            suggestions.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={item.id === value}
                onClick={() => selectItem(item)}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left last:border-0 hover:bg-gray-50"
              >
                <span className="block text-sm font-medium text-gray-900">{itemLabel(item)}</span>
                <span className="block text-xs text-gray-500">
                  {item.category ?? 'Uncategorized'} · {formatStatus(item.status)} · Qty: {item.quantity} · Modal:{' '}
                  {formatIDR(item.modal_price)} · Target: {formatIDR(item.target_price)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
