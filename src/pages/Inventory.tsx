import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, formatStatus } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { logActivity } from '../lib/activityLog'
import { smartSearchRank } from '../lib/search'
import { CATEGORIES, ITEM_CONDITIONS, ITEM_STATUSES, STATUS_BADGE_CLASSES } from '../lib/constants'
import type { Booking, InventoryItem, ItemCondition, ItemStatus, Partner, Sale } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'

const emptyForm = {
  item_code: '',
  item_name: '',
  brand: '',
  category: CATEGORIES[0],
  condition: 'unknown' as ItemCondition,
  quantity: '1',
  modal_price: '0',
  target_price: '0',
  batch_name: '',
  batch_modal_total: '',
  status: 'ready' as ItemStatus,
  owner: 'shared',
  notes: '',
}

const emptyBulkBookingForm = {
  buyer_name: '',
  total_deal_price: '0',
  deadline: '',
  notes: '',
}

export default function Inventory() {
  const { user } = useAuth()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

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
  const [historyItem, setHistoryItem] = useState<InventoryItem | null>(null)
  const [historyBookings, setHistoryBookings] = useState<Booking[]>([])
  const [historySales, setHistorySales] = useState<Sale[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

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

  async function loadPartners() {
    const { data } = await supabase.from('partners').select('*').order('name')
    setPartners(data ?? [])
  }

  useEffect(() => {
    loadItems()
    loadPartners()
  }, [])

  const filtered = useMemo(() => {
    return items
      .map((item) => ({
        item,
        rank: smartSearchRank(search, [
          { value: item.item_name },
          { value: item.item_code },
          { value: item.category },
          { value: item.notes, kind: 'notes' },
        ]),
      }))
      .filter(({ item, rank }) => (statusFilter ? item.status === statusFilter : true) && rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.item.item_name.localeCompare(b.item.item_name))
      .map(({ item }) => item)
  }, [items, search, statusFilter])

  useEffect(() => {
    if (!historyItem) return

    const historyItemId = historyItem.id
    let cancelled = false
    setHistoryLoading(true)
    async function loadHistory() {
      const [bookingsRes, salesRes] = await Promise.all([
        supabase
          .from('bookings')
          .select('*')
          .eq('inventory_item_id', historyItemId)
          .order('created_at', { ascending: false }),
        supabase
          .from('sales')
          .select('*')
          .eq('inventory_item_id', historyItemId)
          .order('sale_date', { ascending: false }),
      ])

      if (cancelled) return
      setHistoryBookings((bookingsRes.data as Booking[]) ?? [])
      setHistorySales((salesRes.data as Sale[]) ?? [])
      setHistoryLoading(false)
    }

    loadHistory()
    return () => {
      cancelled = true
    }
  }, [historyItem])

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
      item_code: item.item_code ?? '',
      item_name: item.item_name,
      brand: item.brand ?? '',
      category: item.category ?? CATEGORIES[0],
      condition: item.condition,
      quantity: String(item.quantity),
      modal_price: String(item.modal_price),
      target_price: String(item.target_price),
      batch_name: item.batch_name ?? '',
      batch_modal_total:
        item.batch_modal_total === null || item.batch_modal_total === undefined
          ? ''
          : String(item.batch_modal_total),
      status: item.status,
      owner: item.owner,
      notes: item.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.item_name.trim()) {
      setFormError('Item name is required.')
      return
    }
    setSaving(true)
    setFormError(null)

    const payload = {
      item_code: form.item_code.trim() || null,
      item_name: form.item_name.trim(),
      brand: form.brand.trim() || null,
      category: form.category || null,
      condition: form.condition,
      quantity: Number(form.quantity) || 0,
      modal_price: Number(form.modal_price) || 0,
      target_price: Number(form.target_price) || 0,
      batch_name: form.batch_name.trim() || null,
      batch_modal_total:
        form.batch_modal_total.trim() === '' ? null : Number(form.batch_modal_total) || 0,
      status: form.status,
      owner: form.owner.trim() || 'shared',
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    let error
    if (editingId) {
      ;({ error } = await supabase.from('inventory_items').update(payload).eq('id', editingId))
    } else {
      ;({ error } = await supabase
        .from('inventory_items')
        .insert({ ...payload, created_by: user?.id }))
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
    const dealPricePerItem = totalDealPrice / itemCount

    const bookingsPayload = selectedItems.map((item) => ({
      inventory_item_id: item.id,
      booking_group_id: groupId,
      group_total_deal_price: totalDealPrice,
      buyer_name: bulkBookingForm.buyer_name.trim(),
      deal_price: dealPricePerItem,
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
      .in(
        'id',
        selectedItems.map((item) => item.id)
      )

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
        item_code: item.item_code,
        item_name: item.item_name,
        brand: item.brand,
        category: item.category,
        condition: item.condition,
        quantity: item.quantity,
        modal_price: item.modal_price,
        target_price: item.target_price,
        batch_name: item.batch_name,
        batch_modal_total: item.batch_modal_total,
        status: item.status,
        owner: item.owner,
        notes: item.notes,
        created_at: item.created_at,
      }))
    )
  }

  const columns: Column<InventoryItem>[] = [
    {
      header: 'Select',
      render: (i) => (
        <input
          type="checkbox"
          checked={selectedItemIds.includes(i.id)}
          onChange={() => toggleItemSelection(i.id)}
          aria-label={`Select ${i.item_name}`}
          className="h-4 w-4 rounded border-gray-300"
        />
      ),
    },
    { header: 'Code', render: (i) => i.item_code ?? '-' },
    {
      header: 'Item name',
      render: (i) => (
        <button onClick={() => setHistoryItem(i)} className="font-medium text-blue-700 hover:underline">
          {i.item_name}
        </button>
      ),
    },
    { header: 'Brand', render: (i) => i.brand ?? '-' },
    { header: 'Category', render: (i) => i.category ?? '-' },
    { header: 'Condition', render: (i) => i.condition },
    { header: 'Qty', render: (i) => i.quantity },
    { header: 'Batch', render: (i) => i.batch_name ?? '-' },
    {
      header: 'Batch Modal',
      render: (i) =>
        i.batch_modal_total === null || i.batch_modal_total === undefined
          ? '-'
          : formatIDR(i.batch_modal_total),
    },
    { header: 'Modal', render: (i) => formatIDR(i.modal_price) },
    { header: 'Target price', render: (i) => formatIDR(i.target_price) },
    {
      header: 'Status',
      render: (i) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[i.status]}`}>
          {formatStatus(i.status)}
        </span>
      ),
    },
    { header: 'Owner', render: (i) => i.owner },
    { header: 'Created', render: (i) => formatDate(i.created_at) },
    {
      header: 'Actions',
      render: (i) => (
        <div className="flex gap-2">
          <button onClick={() => openEditModal(i)} className="text-blue-600 hover:underline">
            Edit
          </button>
          <button onClick={() => handleDelete(i)} className="text-red-600 hover:underline">
            Delete
          </button>
        </div>
      ),
    },
  ]

  const ownerOptions = ['shared', ...partners.map((p) => p.name)]

  return (
    <div className="space-y-4">
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

      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Search name, code, category, or notes..."
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
      {loading ? (
        <p className="text-gray-500">Loading inventory...</p>
      ) : (
        <DataTable columns={columns} data={filtered} keyField={(i) => i.id} />
      )}

      {showModal && (
        <Modal title={editingId ? 'Edit item' : 'Add item'} onClose={() => setShowModal(false)} wide>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Item code</label>
              <input
                value={form.item_code}
                onChange={(e) => setForm({ ...form, item_code: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Item name *</label>
              <input
                required
                value={form.item_name}
                onChange={(e) => setForm({ ...form, item_name: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Brand</label>
              <input
                value={form.brand}
                onChange={(e) => setForm({ ...form, brand: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Category</label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Condition</label>
              <select
                value={form.condition}
                onChange={(e) => setForm({ ...form, condition: e.target.value as ItemCondition })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {ITEM_CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Quantity</label>
              <input
                type="number"
                min="0"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Modal price (Rp)</label>
              <input
                type="number"
                min="0"
                value={form.modal_price}
                onChange={(e) => setForm({ ...form, modal_price: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Target price (Rp)</label>
              <input
                type="number"
                min="0"
                value={form.target_price}
                onChange={(e) => setForm({ ...form, target_price: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Batch name</label>
              <input
                value={form.batch_name}
                onChange={(e) => setForm({ ...form, batch_name: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Batch modal total (Rp)</label>
              <input
                type="number"
                min="0"
                value={form.batch_modal_total}
                onChange={(e) => setForm({ ...form, batch_modal_total: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as ItemStatus })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {ITEM_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {formatStatus(s)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Owner</label>
              <select
                value={ownerOptions.includes(form.owner) ? form.owner : 'shared'}
                onChange={(e) => setForm({ ...form, owner: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {ownerOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            {formError && <p className="text-sm text-red-600 sm:col-span-2">{formError}</p>}

            <div className="flex justify-end gap-2 sm:col-span-2">
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

      {showBulkBookingModal && (
        <Modal title={`Book ${selectedItems.length} selected item${selectedItems.length === 1 ? '' : 's'}`} onClose={() => setShowBulkBookingModal(false)}>
          <form onSubmit={handleBulkBookingSubmit} className="space-y-3">
            <div>
              <BuyerAutocomplete
                required
                value={bulkBookingForm.buyer_name}
                onChange={(buyerName) => setBulkBookingForm({ ...bulkBookingForm, buyer_name: buyerName })}
              />
            </div>
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
              This creates one shared booking group. Existing item rows receive split bookkeeping values internally, but you do not need to enter per-item prices.
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

      {historyItem && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={() => setHistoryItem(null)}>
          <aside
            className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{historyItem.item_name}</h2>
                <p className="text-sm text-gray-500">Current status: {formatStatus(historyItem.status)}</p>
                <p className="text-sm text-gray-500">Imported date: {formatDate(historyItem.created_at)}</p>
              </div>
              <button
                onClick={() => setHistoryItem(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>

            {historyLoading ? (
              <p className="text-sm text-gray-500">Loading item history...</p>
            ) : (
              <div className="space-y-5">
                <section>
                  <h3 className="mb-2 font-medium text-gray-900">Booking History</h3>
                  {historyBookings.length === 0 ? (
                    <p className="text-sm text-gray-400">No bookings found.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {historyBookings.map((booking) => (
                        <li key={booking.id} className="rounded-md border border-gray-200 p-3">
                          <p className="font-medium text-gray-800">{booking.buyer_name}</p>
                          <p className="text-gray-500">Booking date: {formatDate(booking.created_at)}</p>
                          <p className="text-gray-500">
                            Converted to sale: {booking.status === 'converted_to_sale' ? 'Yes' : 'No'}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="mb-2 font-medium text-gray-900">Sales History</h3>
                  {historySales.length === 0 ? (
                    <p className="text-sm text-gray-400">No sales found.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {historySales.map((sale) => (
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
