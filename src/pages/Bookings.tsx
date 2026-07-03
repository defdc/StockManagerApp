import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, todayISO } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { STATUS_BADGE_CLASSES } from '../lib/constants'
import type { Booking, BookingStatus, InventoryItem } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import Modal from '../components/Modal'

type BookingRow = Booking & { inventory_items: { item_name: string } | null }

const emptyForm = {
  inventory_item_id: '',
  buyer_name: '',
  deal_price: '0',
  dp_amount: '0',
  deadline: '',
  status: 'active' as BookingStatus,
  notes: '',
}

export default function Bookings() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [availableItems, setAvailableItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingItemName, setEditingItemName] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function loadBookings() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('bookings')
      .select('*, inventory_items(item_name)')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setBookings((data as unknown as BookingRow[]) ?? [])
    setLoading(false)
  }

  async function loadAvailableItems() {
    const { data } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('status', 'ready')
      .order('item_name')
    setAvailableItems(data ?? [])
  }

  useEffect(() => {
    loadBookings()
    loadAvailableItems()
  }, [])

  const filtered = useMemo(() => {
    return bookings.filter((b) => {
      const matchesSearch = b.buyer_name.toLowerCase().includes(search.toLowerCase())
      const matchesStatus = statusFilter ? b.status === statusFilter : true
      return matchesSearch && matchesStatus
    })
  }, [bookings, search, statusFilter])

  function openAddModal() {
    setEditingId(null)
    setEditingItemId(null)
    setForm(emptyForm)
    setFormError(null)
    setShowModal(true)
  }

  function openEditModal(b: BookingRow) {
    setEditingId(b.id)
    setEditingItemId(b.inventory_item_id)
    setEditingItemName(b.inventory_items?.item_name ?? '-')
    setForm({
      inventory_item_id: b.inventory_item_id ?? '',
      buyer_name: b.buyer_name,
      deal_price: String(b.deal_price),
      dp_amount: String(b.dp_amount),
      deadline: b.deadline ?? '',
      status: b.status === 'converted_to_sale' ? 'active' : b.status,
      notes: b.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.inventory_item_id) {
      setFormError('Please select an item.')
      return
    }
    if (!form.buyer_name.trim()) {
      setFormError('Buyer name is required.')
      return
    }
    setSaving(true)
    setFormError(null)

    const dealPrice = Number(form.deal_price) || 0
    const dpAmount = Number(form.dp_amount) || 0
    const remaining = Math.max(dealPrice - dpAmount, 0)

    const payload = {
      inventory_item_id: form.inventory_item_id,
      buyer_name: form.buyer_name.trim(),
      deal_price: dealPrice,
      dp_amount: dpAmount,
      remaining_amount: remaining,
      deadline: form.deadline || null,
      status: form.status,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    if (editingId) {
      const { error } = await supabase.from('bookings').update(payload).eq('id', editingId)
      if (error) {
        setSaving(false)
        setFormError(error.message)
        return
      }
      // If cancelled, free up the inventory item back to ready.
      if (form.status === 'cancelled' && editingItemId) {
        await supabase
          .from('inventory_items')
          .update({ status: 'ready' })
          .eq('id', editingItemId)
          .eq('status', 'booked')
      }
    } else {
      const { error } = await supabase
        .from('bookings')
        .insert({ ...payload, created_by: user?.id })
      if (error) {
        setSaving(false)
        setFormError(error.message)
        return
      }
      await supabase.from('inventory_items').update({ status: 'booked' }).eq('id', form.inventory_item_id)
    }

    setSaving(false)
    setShowModal(false)
    loadBookings()
    loadAvailableItems()
  }

  async function handleDelete(b: BookingRow) {
    if (!confirm(`Delete booking for "${b.buyer_name}"? This cannot be undone.`)) return
    const { error } = await supabase.from('bookings').delete().eq('id', b.id)
    if (error) {
      alert(error.message)
      return
    }
    if (b.status === 'active' && b.inventory_item_id) {
      await supabase
        .from('inventory_items')
        .update({ status: 'ready' })
        .eq('id', b.inventory_item_id)
        .eq('status', 'booked')
    }
    loadBookings()
    loadAvailableItems()
  }

  async function handleConvertToSale(b: BookingRow) {
    if (!b.inventory_item_id) {
      alert('This booking has no linked inventory item.')
      return
    }
    if (!confirm(`Convert booking for "${b.buyer_name}" into a sale?`)) return

    const { data: item, error: itemError } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('id', b.inventory_item_id)
      .single()
    if (itemError || !item) {
      alert(itemError?.message ?? 'Inventory item not found.')
      return
    }

    const modalPrice = item.modal_price
    const salePrice = b.deal_price
    const grossProfit = salePrice - modalPrice
    const netProfit = grossProfit

    const { error: saleError } = await supabase.from('sales').insert({
      inventory_item_id: b.inventory_item_id,
      customer_id: b.customer_id,
      buyer_name: b.buyer_name,
      platform: 'Other',
      sale_price: salePrice,
      modal_price: modalPrice,
      marketplace_fee: 0,
      packing_cost: 0,
      shipping_subsidy: 0,
      gross_profit: grossProfit,
      net_profit: netProfit,
      sale_date: todayISO(),
      notes: 'Converted from booking',
      created_by: user?.id,
    })
    if (saleError) {
      alert(saleError.message)
      return
    }

    await supabase.from('inventory_items').update({ status: 'sold' }).eq('id', b.inventory_item_id)
    await supabase.from('bookings').update({ status: 'converted_to_sale' }).eq('id', b.id)

    alert('Booking converted to sale. You can edit fees/costs in the Sales page.')
    loadBookings()
    loadAvailableItems()
    navigate('/sales')
  }

  function handleExport() {
    exportToCSV(
      'bookings.csv',
      bookings.map((b) => ({
        item_name: b.inventory_items?.item_name ?? '',
        buyer_name: b.buyer_name,
        deal_price: b.deal_price,
        dp_amount: b.dp_amount,
        remaining_amount: b.remaining_amount,
        deadline: b.deadline,
        status: b.status,
        created_at: b.created_at,
      }))
    )
  }

  const columns: Column<BookingRow>[] = [
    { header: 'Item', render: (b) => b.inventory_items?.item_name ?? '-' },
    { header: 'Buyer', render: (b) => b.buyer_name },
    { header: 'Deal price', render: (b) => formatIDR(b.deal_price) },
    { header: 'DP', render: (b) => formatIDR(b.dp_amount) },
    { header: 'Remaining', render: (b) => formatIDR(b.remaining_amount) },
    { header: 'Deadline', render: (b) => formatDate(b.deadline) },
    {
      header: 'Status',
      render: (b) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[b.status]}`}>
          {b.status}
        </span>
      ),
    },
    {
      header: 'Actions',
      render: (b) => (
        <div className="flex flex-wrap gap-2">
          {b.status === 'active' && (
            <button onClick={() => handleConvertToSale(b)} className="text-green-700 hover:underline">
              Convert to sale
            </button>
          )}
          <button onClick={() => openEditModal(b)} className="text-blue-600 hover:underline">
            Edit
          </button>
          <button onClick={() => handleDelete(b)} className="text-red-600 hover:underline">
            Delete
          </button>
        </div>
      ),
    },
  ]

  const dealPrice = Number(form.deal_price) || 0
  const dpAmount = Number(form.dp_amount) || 0
  const remainingPreview = Math.max(dealPrice - dpAmount, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Bookings</h1>
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
            + Add booking
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Search buyer name..."
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
          <option value="active">active</option>
          <option value="cancelled">cancelled</option>
          <option value="converted_to_sale">converted_to_sale</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading bookings...</p>
      ) : (
        <DataTable columns={columns} data={filtered} keyField={(b) => b.id} />
      )}

      {showModal && (
        <Modal title={editingId ? 'Edit booking' : 'Add booking'} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Item *</label>
              {editingId ? (
                <input
                  disabled
                  value={editingItemName}
                  className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm"
                />
              ) : (
                <>
                  <select
                    required
                    value={form.inventory_item_id}
                    onChange={(e) => setForm({ ...form, inventory_item_id: e.target.value })}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">Select item...</option>
                    {availableItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.item_name}
                      </option>
                    ))}
                  </select>
                  {availableItems.length === 0 && (
                    <p className="mt-1 text-xs text-gray-400">No ready items available to book.</p>
                  )}
                </>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Buyer name *</label>
              <input
                required
                value={form.buyer_name}
                onChange={(e) => setForm({ ...form, buyer_name: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Deal price (Rp)</label>
                <input
                  type="number"
                  min="0"
                  value={form.deal_price}
                  onChange={(e) => setForm({ ...form, deal_price: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">DP amount (Rp)</label>
                <input
                  type="number"
                  min="0"
                  value={form.dp_amount}
                  onChange={(e) => setForm({ ...form, dp_amount: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
              Remaining payment: <span className="font-medium">{formatIDR(remainingPreview)}</span>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Deadline</label>
              <input
                type="date"
                value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            {editingId && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as BookingStatus })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="active">active</option>
                  <option value="cancelled">cancelled</option>
                </select>
                <p className="mt-1 text-xs text-gray-400">
                  Use the "Convert to sale" action on the list to mark this as sold.
                </p>
              </div>
            )}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
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
    </div>
  )
}
