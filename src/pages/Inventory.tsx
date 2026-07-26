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
import { getLiveModalPrice } from '../lib/inventoryModal'

// ─── Types ────────────────────────────────────────────────────────────────────

type BookingRow = Booking & { inventory_items: { item_name: string } | null }

const emptyForm = {
  item_name: '',
  category: '',
  batch_name: '',
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
  const { user } = useAuth()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Category collapse state — persisted in localStorage
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(loadCollapsed)

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)
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
    return () => { cancelled = true }
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
    setForm(emptyForm)
    setFormError(null)
    setShowModal(true)
  }

  function openEditModal(item: InventoryItem) {
    setEditingId(item.id)
    setForm({
      item_name: item.item_name,
      category: item.category ?? '',
      batch_name: item.batch_name ?? '',
      notes: item.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  // ── Compute modal_price at save time ─────────────────────────────────────
  // modal_price = batch_modal_total / total items in that batch (at save moment)

  async function computeModalPrice(
    batchName: string,
    isNew: boolean
  ): Promise<number> {
    if (!batchName.trim()) return 0

    const { count } = await supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('batch_name', batchName.trim())

    // For a new item, sibling count doesn't yet include it — add 1
    // For an edit, the item is already counted
    const siblingCount = (count ?? 0) + (isNew ? 1 : 0)
    if (siblingCount <= 0) return 0

    // Fetch batch_modal_total from any existing item in this batch
    const { data: batchItems } = await supabase
      .from('inventory_items')
      .select('batch_modal_total')
      .eq('batch_name', batchName.trim())
      .not('batch_modal_total', 'is', null)
      .limit(1)

    // If editing current item, we don't have updated batch_modal_total from form here.
    // We need to fetch it separately when editing — caller must pass it.
    const batchModalTotal = batchItems?.[0]?.batch_modal_total as number | null | undefined
    if (!batchModalTotal) return 0

    return Math.floor(batchModalTotal / siblingCount)
  }

  // ── Submit handlers ──────────────────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.item_name.trim()) {
      setFormError('Item name is required.')
      return
    }
    setSaving(true)
    setFormError(null)

    // Compute modal_price from batch at save time (Step 3)
    const modalPrice = await computeModalPrice(form.batch_name, !editingId)

    const payload = {
      item_name: form.item_name.trim(),
      category: form.category.trim() || null,
      batch_name: form.batch_name.trim() || null,
      modal_price: modalPrice,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    let error
    if (editingId) {
      ;({ error } = await supabase.from('inventory_items').update(payload).eq('id', editingId))
    } else {
      ;({ error } = await supabase
        .from('inventory_items')
        .insert({ ...payload, quantity: 1, status: 'ready', created_by: user?.id }))
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

    const groupId = crypto.randomUUID()
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
        modal_price: item.modal_price,
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
          <button
            onClick={openAddModal}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            + Add item
          </button>
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
            <button
              onClick={openBulkBookingModal}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
            >
              Book Selected
            </button>
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
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-100 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Select</th>
                          <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Item</th>
                          <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Batch</th>
                          <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Status</th>
                          <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Created</th>
                          <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Actions</th>
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
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add / Edit Item Modal */}
      {showModal && (
        <Modal title={editingId ? 'Edit item' : 'Add item'} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Item name *</label>
              <input
                required
                value={form.item_name}
                onChange={(e) => setForm({ ...form, item_name: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
                placeholder="e.g. Hot Wheels 71 Datsun Bluebird U"
              />
            </div>

            <CategoryAutocomplete
              required
              value={form.category}
              onChange={(cat) => setForm({ ...form, category: cat })}
            />

            <BatchAutocomplete
              value={form.batch_name}
              onChange={(batch) => setForm({ ...form, batch_name: batch })}
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

            {formError && <p className="text-sm text-red-600">{formError}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
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
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
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
