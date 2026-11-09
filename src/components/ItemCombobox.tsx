import { useEffect, useId, useRef, useState } from 'react'
import { formatIDR, formatStatus } from '../lib/format'
import { smartSearchRank } from '../lib/search'
import { supabase } from '../lib/supabase'
import type { InventoryItem } from '../types/database'
import { getLiveModalPrice } from '../lib/inventoryModal'

interface ItemComboboxProps {
  value: string | null
  onChange: (item: InventoryItem | null) => void
  allowedStatuses?: string[]
  placeholder?: string
  label?: string
  required?: boolean
  excludeIds?: string[]
}

const SUGGESTION_LIMIT = 50
const DEFAULT_ALLOWED_STATUSES = ['ready']
const ITEM_COMBOBOX_COLUMNS = 'id, item_name, category, batch_name, batch_modal_total, modal_price, status, notes, created_at'

function itemLabel(item: InventoryItem): string {
  return item.item_name
}

async function findItems(search: string, statuses: string[], excludeIds: string[] = []): Promise<InventoryItem[]> {
  const searchWords = search.toLowerCase().trim().split(/\s+/).filter(Boolean)

  let nameQuery = supabase
    .from('inventory_items')
    .select(ITEM_COMBOBOX_COLUMNS)
    .in('status', statuses)

  searchWords.forEach((word) => {
    nameQuery = nameQuery.ilike('item_name', `%${word}%`)
  })

  if (excludeIds.length > 0) {
    nameQuery = nameQuery.not('id', 'in', `(${excludeIds.join(',')})`)
  }

  const queries = [
    nameQuery.order('item_name', { ascending: true }).limit(SUGGESTION_LIMIT),
  ]

  if (searchWords.length > 0) {
    let extraQuery = supabase
      .from('inventory_items')
      .select(ITEM_COMBOBOX_COLUMNS)
      .in('status', statuses)

    for (const word of searchWords) {
      const safeWord = word.replace(/[,()]/g, '')
      if (!safeWord) continue
      extraQuery = extraQuery.or(
        `item_name.ilike.%${safeWord}%,category.ilike.%${safeWord}%,batch_name.ilike.%${safeWord}%,notes.ilike.%${safeWord}%`
      )
    }

    if (excludeIds.length > 0) {
      extraQuery = extraQuery.not('id', 'in', `(${excludeIds.join(',')})`)
    }

    queries.push(extraQuery.order('item_name', { ascending: true }).limit(SUGGESTION_LIMIT))
  }

  const responses = await Promise.all(queries)
  for (const res of responses) {
    if (res.error) throw new Error(res.error.message)
  }

  const uniqueItems = new Map<string, InventoryItem>()
  for (const res of responses) {
    for (const item of ((res.data as unknown as InventoryItem[]) ?? [])) {
      if (!excludeIds.includes(item.id)) {
        uniqueItems.set(item.id, item)
      }
    }
  }

  return [...uniqueItems.values()]
    .map((item) => ({
      item,
      rank: smartSearchRank(search, [
        { value: item.item_name },
        { value: item.category },
        { value: item.batch_name },
        { value: item.notes, kind: 'notes' },
      ]),
    }))
    .filter((entry) => !search || entry.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.item.item_name.localeCompare(b.item.item_name))
    .map(({ item }) => item)
    .slice(0, SUGGESTION_LIMIT)
}

export default function ItemCombobox({
  value,
  onChange,
  allowedStatuses,
  placeholder = 'Search by name, code, category, or notes...',
  label,
  required,
  excludeIds = [],
}: ItemComboboxProps) {
  const listboxId = useId()
  const statusKey = (allowedStatuses ?? DEFAULT_ALLOWED_STATUSES).join(',')
  const excludeKey = excludeIds.join(',')
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
        .select(ITEM_COMBOBOX_COLUMNS)
        .eq('id', value)
        .single()

      if (!cancelled && !itemError && data) {
        const item = data as unknown as InventoryItem
        setSelectedItem(item)
        setQuery(itemLabel(item))
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
        const currentExcludeIds = excludeKey ? excludeKey.split(',') : []
        const items = await findItems(query.trim(), statusKey.split(','), currentExcludeIds)
        if (!cancelled) setSuggestions(items)
      } catch (searchError) {
        if (!cancelled) {
          setSuggestions([])
          setError(searchError instanceof Error ? searchError.message : 'Unable to search items.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, selectedItem, statusKey, excludeKey])

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
    updatePosition()
  }

  return (
    <div ref={containerRef} className={`relative ${open ? 'z-40' : 'z-10'}`}>
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
          onFocus={() => {
            setOpen(true)
            updatePosition()
          }}
          onChange={(event) => {
            if (selectedItem) {
              setSelectedItem(null)
              onChange(null)
            }
            setQuery(event.target.value)
            setOpen(true)
            updatePosition()
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
          className={`absolute z-50 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-xl max-h-56 ${
            openUpward ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
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
                  {item.batch_name ? `${item.batch_name} · ` : ''}
                  {item.category ?? 'Uncategorized'} · {formatStatus(item.status)} · Modal:{' '}
                  {formatIDR(getLiveModalPrice(item, suggestions))}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
