import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, formatStatus } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { logActivity } from '../lib/activityLog'
import { smartSearchRank } from '../lib/search'
import { ITEM_STATUSES, STATUS_BADGE_CLASSES } from '../lib/constants'
import type { Booking, InventoryItem, Sale } from '../types/database'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'
import BatchAutocomplete from '../components/BatchAutocomplete'
import CategoryAutocomplete from '../components/CategoryAutocomplete'
import ItemNameAutocomplete from '../components/ItemNameAutocomplete'
import { getLiveModalPrice } from '../lib/inventoryModal'

// ─── Types ────────────────────────────────────────────────────────────────────

type BookingRow = Booking & { inventory_items: { item_name: string } | null }

type AddMode = 'single' | 'multiple'

interface MultiItemRow {
  id: string
  item_name: string
  category: string
  notes: string
}

const emptyForm = {
  item_name: '',
  category: '',
  batch_name: '',
  batch_modal_total: '',
  notes: '',
}

const emptyBulkBookingForm = {
  buyer_name: '',
  total_deal_price: '0',
  deadline: '',
  notes: '',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COLLAPSED_KEY = 'inventory_collapsed_categories'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
  } catch {
    // ignore storage errors
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Inventory() {
  const { user, canWrite } = useAuth()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Category collapse state — persisted in localStorage
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(loadCollapsed)

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addMode, setAddMode] = useState<AddMode>('single')

  // Single item form state
  const [form, setForm] = useState(emptyForm)

  // Multiple items form state
  const [multiBatchName, setMultiBatchName] = useState('')
  const [multiBatchModalTotal, setMultiBatchModalTotal] = useState('')
  const [multiItems, setMultiItems] = useState<MultiItemRow[]>([
    { id: crypto.randomUUID(), item_name: '', category: '', notes: '' },
  ])

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([])
  const [showBulkBookingModal, setShowBulkBookingModal] = useState(false)
  const [bulkBookingForm, setBulkBookingForm] = useState(emptyBulkBookingForm)
  const [bulkBookingSaving, setBulkBookingSaving] = useState(false)
  const [bulkBookingError, setBulkBookingError] = useState<string | null>(null)

  // Detail drawer
  const [drawerItem, setDrawerItem] = useState<InventoryItem | null>(null)
  const [drawerBookings, setDrawerBookings] = useState<BookingRow[]>([])
  const [drawerSales, setDrawerSales] = useState<Sale[]>([])
  const [drawerLoading, setDrawerLoading] = useState(false)

  // ── Data loading ─────────────────────────────────────────────────────────

  async function loadItems() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('inventory_items')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setItems(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadItems()
  }, [])

  // Load drawer history when an item is selected
  useEffect(() => {
    if (!drawerItem) return

    const itemId = drawerItem.id
    let cancelled = false
    setDrawerLoading(true)

    async function loadHistory() {
      const [bookingsRes, salesRes] = await Promise.all([
        supabase
          .from('bookings')
          .select('*, inventory_items(item_name)')
          .eq('inventory_item_id', itemId)
          .order('created_at', { ascending: false }),
        supabase
          .from('sales')
          .select('*')
          .eq('inventory_item_id', itemId)
          .order('sale_date', { ascending: false }),
      ])
      if (cancelled) return
      setDrawerBookings((bookingsRes.data as BookingRow[]) ?? [])
      setDrawerSales((salesRes.data as Sale[]) ?? [])
      setDrawerLoading(false)
    }

    loadHistory()
    return () => {
      cancelled = true
    }
  }, [drawerItem])

  // ── Filtering & grouping ─────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return items
      .map((item) => ({
        item,
        rank: smartSearchRank(search, [
          { value: item.item_name },
          { value: item.category },
          { value: item.batch_name },
          { value: item.notes, kind: 'notes' },
        ]),
      }))
      .filter(({ item, rank }) => (statusFilter ? item.status === statusFilter : true) && rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.item.item_name.localeCompare(b.item.item_name))
      .map(({ item }) => item)
  }, [items, search, statusFilter])

  // Group items by category for the collapsible view
  const grouped = useMemo(() => {
    const map = new Map<string, InventoryItem[]>()
    for (const item of filtered) {
      const key = item.category?.trim() || 'Uncategorised'
      const arr = map.get(key) ?? []
      arr.push(item)
      map.set(key, arr)
    }
    // Sort groups alphabetically; 'Uncategorised' goes last
    return [...map.entries()].sort(([a], [b]) => {
      if (a === 'Uncategorised') return 1
      if (b === 'Uncategorised') return -1
      return a.localeCompare(b)
    })
  }, [filtered])

  // ── Selection helpers ────────────────────────────────────────────────────

  const selectedItems = useMemo(
    () => items.filter((item) => selectedItemIds.includes(item.id)),
    [items, selectedItemIds]
  )

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((item) => selectedItemIds.includes(item.id))

  function toggleItemSelection(itemId: string) {
    setSelectedItemIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]
    )
  }

  function toggleSelectAll() {
    const filteredIds = filtered.map((item) => item.id)
    if (allFilteredSelected) {
      setSelectedItemIds((current) => current.filter((id) => !filteredIds.includes(id)))
      return
    }
    setSelectedItemIds((current) => Array.from(new Set([...current, ...filteredIds])))
  }

  // ── Category collapse ────────────────────────────────────────────────────

  function toggleCategory(cat: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      saveCollapsed(next)
      return next
    })
  }

  // ── Modals ───────────────────────────────────────────────────────────────

  function openBulkBookingModal() {
    if (selectedItems.length === 0) return
    const nonReadyItems = selectedItems.filter((item) => item.status !== 'ready')
    if (nonReadyItems.length > 0) {
      alert('Only ready inventory items can be bulk booked. Please deselect booked, sold, or cancelled items.')
      return
    }
    setBulkBookingForm(emptyBulkBookingForm)
    setBulkBookingError(null)
    setShowBulkBookingModal(true)
  }

  function openAddModal() {
    setEditingId(null)
    setAddMode('single')
    setForm(emptyForm)
    setMultiBatchName('')
    setMultiBatchModalTotal('')
    setMultiItems([{ id: crypto.randomUUID(), item_name: '', category: '', notes: '' }])
    setFormError(null)
    setShowModal(true)
  }

  function openEditModal(item: InventoryItem) {
    setEditingId(item.id)
    setAddMode('single')
    setForm({
      item_name: item.item_name,
      category: item.category ?? '',
      batch_name: item.batch_name ?? '',
      batch_modal_total: item.batch_modal_total ? String(item.batch_modal_total) : '',
      notes: item.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  // ── Dynamic multi-item row handlers ──────────────────────────────────────

  function addMultiRow() {
    setMultiItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), item_name: '', category: '', notes: '' },
    ])
  }

  function updateMultiRow(id: string, field: keyof MultiItemRow, value: string) {
    setMultiItems((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    )
  }

  function removeMultiRow(id: string) {
    if (multiItems.length === 1) return
    setMultiItems((prev) => prev.filter((row) => row.id !== id))
  }

  // ── Submit handlers ──────────────────────────────────────────────────────

  async function handleMultiSubmit() {
    const batchName = multiBatchName.trim()
    const modalTotal = multiBatchModalTotal.trim() ? Number(multiBatchModalTotal) : null

    if (!batchName) {
      setFormError('Please select or create a batch before saving.')
      return
    }

    // Validate items
    const validItems = multiItems.filter((i) => i.item_name.trim() || i.category.trim())
    if (validItems.length === 0) {
      setFormError('Please add at least one item.')
      return
    }

    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i]
      if (!item.item_name.trim()) {
        setFormError(`Item #${i + 1} is missing a name.`)
        return
      }
      if (!item.category.trim()) {
        setFormError(`Item #${i + 1} ("${item.item_name}") is missing a category.`)
        return
      }
    }

    setSaving(true)
    setFormError(null)

    const itemsPayload = validItems.map((item) => ({
      item_name: item.item_name.trim(),
      category: item.category.trim() || null,
      batch_name: batchName || null,
      batch_modal_total: batchName ? modalTotal : null,
      modal_price: 0,
      quantity: 1,
      status: 'ready' as const,
      notes: item.notes.trim() || null,
      created_by: user?.id,
    }))

    const { error } = await supabase.from('inventory_items').insert(itemsPayload)

    // Sync batch_modal_total across all items in that batch if provided
    if (batchName && modalTotal !== null && !error) {
      await supabase
        .from('inventory_items')
        .update({ batch_modal_total: modalTotal })
        .eq('batch_name', batchName)
    }

    setSaving(false)
    if (error) {
      setFormError(error.message)
      return
    }

    void logActivity({
      action: 'Bulk Add Items',
      entity: 'inventory_items',
      userId: user?.id,
      details: { count: validItems.length, batch_name: batchName || 'Unassigned' },
    })

    setShowModal(false)
    loadItems()
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()

    if (addMode === 'multiple' && !editingId) {
      return handleMultiSubmit()
    }

    if (!form.item_name.trim()) {
      setFormError('Item name is required.')
      return
    }

    const batchName = form.batch_name.trim()
    const modalTotal = form.batch_modal_total.trim() ? Number(form.batch_modal_total) : null

    setSaving(true)
    setFormError(null)

    const payload: Record<string, unknown> = {
      item_name: form.item_name.trim(),
      category: form.category.trim() || null,
      batch_name: batchName || null,
      batch_modal_total: batchName ? modalTotal : null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    let error
    if (editingId) {
      ;({ error } = await supabase.from('inventory_items').update(payload).eq('id', editingId))
    } else {
      ;({ error } = await supabase.from('inventory_items').insert({
        ...payload,
        modal_price: 0,
        quantity: 1,
        status: 'ready',
        created_by: user?.id,
      }))
    }

    // Sync batch_modal_total across all items in that batch if provided
    if (batchName && modalTotal !== null && !error) {
      await supabase
        .from('inventory_items')
        .update({ batch_modal_total: modalTotal })
        .eq('batch_name', batchName)
    }

    setSaving(false)
    if (error) {
      setFormError(error.message)
      return
    }
    setShowModal(false)
    loadItems()
  }

  async function handleBulkBookingSubmit(e: FormEvent) {
    e.preventDefault()
    if (selectedItems.length === 0) {
      setBulkBookingError('Please select at least one item.')
      return
    }
    if (!bulkBookingForm.buyer_name.trim()) {
      setBulkBookingError('Buyer name is required.')
      return
    }

    const nonReadyItems = selectedItems.filter((item) => item.status !== 'ready')
    if (nonReadyItems.length > 0) {
      setBulkBookingError('Only ready inventory items can be bulk booked.')
      return
    }

    setBulkBookingSaving(true)
    setBulkBookingError(null)

    const groupId = selectedItems.length > 1 ? crypto.randomUUID() : null
    const totalDealPrice = Number(bulkBookingForm.total_deal_price) || 0
    const itemCount = selectedItems.length
    const base = Math.floor(totalDealPrice / itemCount)
    const remainder = totalDealPrice - base * itemCount

    const bookingsPayload = selectedItems.map((item, index) => ({
      inventory_item_id: item.id,
      booking_group_id: groupId,
      group_total_deal_price: totalDealPrice,
      buyer_name: bulkBookingForm.buyer_name.trim(),
      deal_price: index === itemCount - 1 ? base + remainder : base,
      // Snapshot modal_price at booking-creation time (Step 1)
      modal_price: getLiveModalPrice(item, items),
      dp_amount: 0,
      remaining_amount: 0,
      deadline: bulkBookingForm.deadline || null,
      status: 'active',
      notes: bulkBookingForm.notes.trim() || null,
      created_by: user?.id,
    }))

    const { error: bookingError } = await supabase.from('bookings').insert(bookingsPayload)
    if (bookingError) {
      setBulkBookingSaving(false)
      setBulkBookingError(bookingError.message)
      return
    }

    const { error: itemError } = await supabase
      .from('inventory_items')
      .update({ status: 'booked', updated_at: new Date().toISOString() })
      .in('id', selectedItems.map((item) => item.id))

    setBulkBookingSaving(false)
    if (itemError) {
      setBulkBookingError(itemError.message)
      return
    }

    setShowBulkBookingModal(false)
    setSelectedItemIds([])
    void logActivity({
      action: 'Bulk Booking',
      entity: 'inventory_items',
      userId: user?.id,
      details: { count: selectedItems.length, buyer_name: bulkBookingForm.buyer_name.trim(), booking_group_id: groupId },
    })
    loadItems()
  }

  async function handleDelete(item: InventoryItem) {
    if (!confirm(`Delete "${item.item_name}"? This cannot be undone.`)) return
    const { error } = await supabase.from('inventory_items').delete().eq('id', item.id)
    if (error) alert(error.message)
    else {
      void logActivity({
        action: 'Delete',
        entity: 'inventory_items',
        entityId: item.id,
        userId: user?.id,
        details: { item_name: item.item_name },
      })
      loadItems()
    }
  }

  function handleExport() {
    exportToCSV(
      'inventory.csv',
      items.map((item) => ({
        item_name: item.item_name,
        category: item.category,
        batch_name: item.batch_name,
        batch_modal_total: item.batch_modal_total,
        modal_price: getLiveModalPrice(item, items),
        status: item.status,
        notes: item.notes,
        created_at: item.created_at,
      }))
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Inventory</h1>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Export CSV
          </button>
          {canWrite && (
            <button
              onClick={openAddModal}
              className="rounded-md bg-pink-600 px-3 py-2 text-sm font-medium text-white hover:bg-pink-700"
            >
              + Add item(s)
            </button>
          )}
        </div>
      </div>

      {/* Search + filter bar */}
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Search item, category, batch, or notes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        >
          <option value="">All statuses</option>
          {ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {formatStatus(s)}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk-action bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
        <label className="flex items-center gap-2 text-gray-700">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAll}
            disabled={filtered.length === 0}
            className="h-4 w-4 rounded border-gray-300"
          />
          Select all visible
        </label>
        {selectedItemIds.length > 0 && (
          <>
            <span className="text-gray-500">{selectedItemIds.length} selected</span>
            {canWrite && (
              <button
                onClick={openBulkBookingModal}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
              >
                Book Selected
              </button>
            )}
            <button
              onClick={() => setSelectedItemIds([])}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Grouped inventory table */}
      {loading ? (
        <p className="text-gray-500">Loading inventory...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-400">No items found.</p>
      ) : (
        <div className="space-y-3">
          {grouped.map(([category, catItems]) => {
            const isCollapsed = collapsedCategories.has(category)
            return (
              <div key={category} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                {/* Category header */}
                <button
                  type="button"
                  onClick={() => toggleCategory(category)}
                  className="flex w-full items-center justify-between bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-100"
                >
                  <span>
                    {isCollapsed ? '▶' : '▼'} {category}
                    <span className="ml-2 font-normal text-gray-500">({catItems.length})</span>
                  </span>
                </button>

                {/* Item rows */}
                {!isCollapsed && (
                  <>
                    {/* Mobile Cards List (< 768px) */}
                    <div className="space-y-3 p-3 bg-gray-50/50 border-t border-gray-200 md:hidden">
                      {catItems.map((item) => (
                        <div key={item.id} className="rounded-lg border border-gray-200 bg-white p-3.5 shadow-sm space-y-2.5">
                          {/* Header: Checkbox + Item Name + Status Badge */}
                          <div className="flex items-start gap-2.5">
                            <input
                              type="checkbox"
                              checked={selectedItemIds.includes(item.id)}
                              onChange={() => toggleItemSelection(item.id)}
                              aria-label={`Select ${item.item_name}`}
                              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300"
                            />
                            <div className="min-w-0 flex-1">
                              <button
                                onClick={() => setDrawerItem(item)}
                                className="font-bold text-gray-900 text-base leading-snug break-words hover:text-blue-700 text-left"
                              >
                                {item.item_name}
                              </button>
                            </div>
                            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[item.status]}`}>
                              {formatStatus(item.status)}
                            </span>
                          </div>

                          {/* Details Grid */}
                          <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 bg-gray-50/70 p-2.5 rounded-md">
                            <div>
                              <span className="text-gray-400 block text-[11px]">Batch</span>
                              <span className="font-medium text-gray-800">{item.batch_name ?? '-'}</span>
                            </div>
                            <div>
                              <span className="text-gray-400 block text-[11px]">Category</span>
                              <span className="font-medium text-gray-800">{item.category ?? 'Uncategorized'}</span>
                            </div>
                            <div>
                              <span className="text-gray-400 block text-[11px]">Created</span>
                              <span className="font-medium text-gray-800">{formatDate(item.created_at)}</span>
                            </div>
                          </div>

                          {/* Action Buttons (Min 40px touch targets) */}
                          {canWrite && (
                            <div className="pt-1 flex flex-wrap items-center justify-end gap-2 border-t border-gray-100">
                              <button
                                type="button"
                                onClick={() => openEditModal(item)}
                                className="min-h-[40px] rounded-md border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(item)}
                                className="min-h-[40px] rounded-md border border-red-200 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Desktop Table View (≥ 768px) */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-100 text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Select</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Item</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Batch</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Status</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Created</th>
                            {canWrite && <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Actions</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {catItems.map((item) => (
                            <tr key={item.id} className="hover:bg-gray-50">
                              <td className="whitespace-nowrap px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={selectedItemIds.includes(item.id)}
                                  onChange={() => toggleItemSelection(item.id)}
                                  aria-label={`Select ${item.item_name}`}
                                  className="h-4 w-4 rounded border-gray-300"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <button
                                  onClick={() => setDrawerItem(item)}
                                  className="font-medium text-blue-700 hover:underline"
                                >
                                  {item.item_name}
                                </button>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                                {item.batch_name ?? '-'}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2">
                                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[item.status]}`}>
                                  {formatStatus(item.status)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                                {formatDate(item.created_at)}
                              </td>
                              {canWrite && (
                                <td className="whitespace-nowrap px-3 py-2">
                                  <div className="flex gap-2">
                                    <button onClick={() => openEditModal(item)} className="text-blue-600 hover:underline">
                                      Edit
                                    </button>
                                    <button onClick={() => handleDelete(item)} className="text-red-600 hover:underline">
                                      Delete
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add / Edit Item Modal */}
      {showModal && (
        <Modal
          title={editingId ? 'Edit item' : 'Add inventory items'}
          onClose={() => setShowModal(false)}
          wide={addMode === 'multiple'}
        >
          {/* Mode Selector Tabs (only when adding new items) */}
          {!editingId && (
            <div className="mb-4 flex border-b border-gray-200 text-sm font-medium">
              <button
                type="button"
                onClick={() => setAddMode('single')}
                className={`border-b-2 px-4 py-2 text-sm font-medium ${
                  addMode === 'single'
                    ? 'border-pink-600 text-pink-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Single Item
              </button>
              <button
                type="button"
                onClick={() => setAddMode('multiple')}
                className={`border-b-2 px-4 py-2 text-sm font-medium ${
                  addMode === 'multiple'
                    ? 'border-pink-600 text-pink-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Multiple Items (Bulk Add)
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {addMode === 'single' ? (
              /* Single Item Form */
              <>
                <ItemNameAutocomplete
                  required
                  label="Item name"
                  labelClassName="mb-1 block text-sm font-medium text-gray-700"
                  value={form.item_name}
                  onChange={(name) => setForm({ ...form, item_name: name })}
                  placeholder="e.g. Hot Wheels 71 Datsun Bluebird U"
                />

                <CategoryAutocomplete
                  required
                  value={form.category}
                  onChange={(cat) => setForm({ ...form, category: cat })}
                />

                <BatchAutocomplete
                  value={form.batch_name}
                  modalTotalValue={form.batch_modal_total}
                  onChange={(batchName, modalTotal) =>
                    setForm({
                      ...form,
                      batch_name: batchName,
                      batch_modal_total: modalTotal ?? form.batch_modal_total,
                    })
                  }
                />

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
                  />
                </div>
              </>
            ) : (
              /* Multiple Items Form */
              <div className="space-y-4">
                {/* Shared Batch Header */}
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <BatchAutocomplete
                    required
                    value={multiBatchName}
                    modalTotalValue={multiBatchModalTotal}
                    onChange={(batchName, modalTotal) => {
                      setMultiBatchName(batchName)
                      if (modalTotal !== undefined) setMultiBatchModalTotal(modalTotal)
                    }}
                    label="Batch for all items below"
                    placeholder="Select or create a batch for these items..."
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    This batch and its modal total will be shared across all items added in this session.
                  </p>
                </div>

                {/* Items Table */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-900">
                      Items list ({multiItems.length})
                    </label>
                    <button
                      type="button"
                      onClick={addMultiRow}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      + Add another item
                    </button>
                  </div>

                  <div className="space-y-2">
                    {multiItems.map((itemRow, index) => (
                      <div
                        key={itemRow.id}
                        className="relative z-10 focus-within:z-30 transition-all grid grid-cols-1 gap-2 rounded-md border border-gray-200 p-3 sm:grid-cols-12 sm:items-start"
                      >
                        <div className="sm:col-span-4">
                          <ItemNameAutocomplete
                            required
                            label="Item Name *"
                            placeholder={`Item #${index + 1} name *`}
                            value={itemRow.item_name}
                            onChange={(name) => updateMultiRow(itemRow.id, 'item_name', name)}
                          />
                        </div>

                        <div className="sm:col-span-4">
                          <label className="mb-1 block text-xs font-medium text-gray-600 sm:hidden">
                            Category *
                          </label>
                          <CategoryAutocomplete
                            required
                            label=""
                            placeholder="Category *"
                            value={itemRow.category}
                            onChange={(cat) => updateMultiRow(itemRow.id, 'category', cat)}
                          />
                        </div>

                        <div className="sm:col-span-3">
                          <label className="mb-1 block text-xs font-medium text-gray-600 sm:hidden">
                            Notes
                          </label>
                          <input
                            type="text"
                            value={itemRow.notes}
                            onChange={(e) => updateMultiRow(itemRow.id, 'notes', e.target.value)}
                            placeholder="Notes (optional)"
                            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-500 focus:outline-none"
                          />
                        </div>

                        <div className="flex justify-end sm:col-span-1 sm:pt-1">
                          <button
                            type="button"
                            onClick={() => removeMultiRow(itemRow.id)}
                            disabled={multiItems.length === 1}
                            aria-label="Remove item row"
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-30"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={addMultiRow}
                    className="w-full rounded-md border border-dashed border-gray-300 py-2 text-center text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50"
                  >
                    + Add another item row
                  </button>
                </div>
              </div>
            )}

            {formError && <p className="text-sm text-red-600">{formError}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || (addMode === 'multiple' && !multiBatchName.trim())}
                className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
              >
                {saving
                  ? 'Saving...'
                  : addMode === 'multiple' && !editingId
                  ? `Save ${multiItems.filter((i) => i.item_name.trim()).length || multiItems.length} items`
                  : 'Save item'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Bulk Booking Modal */}
      {showBulkBookingModal && (
        <Modal
          title={`Book ${selectedItems.length} selected item${selectedItems.length === 1 ? '' : 's'}`}
          onClose={() => setShowBulkBookingModal(false)}
        >
          <form onSubmit={handleBulkBookingSubmit} className="space-y-3">
            <BuyerAutocomplete
              required
              value={bulkBookingForm.buyer_name}
              onChange={(buyerName) => setBulkBookingForm({ ...bulkBookingForm, buyer_name: buyerName })}
            />
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Total deal price (Rp)</label>
              <input
                type="number"
                min="0"
                value={bulkBookingForm.total_deal_price}
                onChange={(e) => setBulkBookingForm({ ...bulkBookingForm, total_deal_price: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
              Creates one booking group. Price is split evenly across {selectedItems.length} item{selectedItems.length === 1 ? '' : 's'}.
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Deadline</label>
              <input
                type="date"
                value={bulkBookingForm.deadline}
                onChange={(e) => setBulkBookingForm({ ...bulkBookingForm, deadline: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={bulkBookingForm.notes}
                onChange={(e) => setBulkBookingForm({ ...bulkBookingForm, notes: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            {bulkBookingError && <p className="text-sm text-red-600">{bulkBookingError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowBulkBookingModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={bulkBookingSaving}
                className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
              >
                {bulkBookingSaving ? 'Booking...' : 'Create bookings'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Detail Drawer */}
      {drawerItem && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={() => setDrawerItem(null)}>
          <aside
            className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <h2 className="text-lg font-semibold text-gray-900">{drawerItem.item_name}</h2>
                <p className="text-sm text-gray-500">
                  Category: <span className="font-medium text-gray-700">{drawerItem.category ?? '-'}</span>
                </p>
                <p className="text-sm text-gray-500">
                  Batch: <span className="font-medium text-gray-700">{drawerItem.batch_name ?? '-'}</span>
                </p>
                <p className="text-sm text-gray-500">
                  Modal/item: <span className="font-medium text-gray-700">{formatIDR(getLiveModalPrice(drawerItem, items))}</span>
                </p>
                <p className="text-sm text-gray-500">
                  Status:{' '}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[drawerItem.status]}`}>
                    {formatStatus(drawerItem.status)}
                  </span>
                </p>
                <p className="text-sm text-gray-500">Added: {formatDate(drawerItem.created_at)}</p>
                {drawerItem.notes && (
                  <p className="text-sm text-gray-500">Notes: {drawerItem.notes}</p>
                )}
              </div>
              <button
                onClick={() => setDrawerItem(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>

            {drawerLoading ? (
              <p className="text-sm text-gray-500">Loading history...</p>
            ) : (
              <div className="space-y-5">
                <section>
                  <h3 className="mb-2 font-medium text-gray-900">Booking History</h3>
                  {drawerBookings.length === 0 ? (
                    <p className="text-sm text-gray-400">No bookings found.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {drawerBookings.map((booking) => (
                        <li key={booking.id} className="rounded-md border border-gray-200 p-3">
                          <p className="font-medium text-gray-800">{booking.buyer_name}</p>
                          <p className="text-gray-500">Deal: {formatIDR(booking.deal_price)}</p>
                          <p className="text-gray-500">Booking date: {formatDate(booking.created_at)}</p>
                          <p className="text-gray-500">
                            Status:{' '}
                            <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[booking.status]}`}>
                              {formatStatus(booking.status)}
                            </span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="mb-2 font-medium text-gray-900">Sales History</h3>
                  {drawerSales.length === 0 ? (
                    <p className="text-sm text-gray-400">No sales found.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {drawerSales.map((sale) => (
                        <li key={sale.id} className="rounded-md border border-gray-200 p-3">
                          <p className="font-medium text-gray-800">{sale.buyer_name}</p>
                          <p className="text-gray-500">Sale date: {formatDate(sale.sale_date)}</p>
                          <p className="text-gray-500">Sale price: {formatIDR(sale.sale_price)}</p>
                          <p className="text-gray-500">Gross profit: {formatIDR(sale.gross_profit)}</p>
                          <p className="text-gray-500">Net profit: {formatIDR(sale.net_profit)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
