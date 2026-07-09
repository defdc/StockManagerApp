import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, formatStatus, todayISO } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { logActivity } from '../lib/activityLog'
import { bookingGroupDisplayId } from '../lib/bookingGroups'
import { smartSearchRank } from '../lib/search'
import { PLATFORMS, STATUS_BADGE_CLASSES } from '../lib/constants'
import type { Booking, BookingStatus, Platform } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import ItemCombobox from '../components/ItemCombobox'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'

type BookingRow = Booking & { inventory_items: { item_name: string; modal_price: number } | null }

const emptyForm = {
  inventory_item_id: '',
  buyer_name: '',
  deal_price: '0',
  dp_amount: '0',
  deadline: '',
  status: 'active' as BookingStatus,
  notes: '',
}

const emptyBulkSaleForm = {
  buyer_name: '',
  platform: 'Other' as Platform,
  total_sale_price: '0',
  sale_date: todayISO(),
  notes: '',
}

export default function Bookings() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [bookings, setBookings] = useState<BookingRow[]>([])
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
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([])
  const [showBulkSaleModal, setShowBulkSaleModal] = useState(false)
  const [bulkSaleForm, setBulkSaleForm] = useState(emptyBulkSaleForm)
  const [bulkSaleSaving, setBulkSaleSaving] = useState(false)
  const [bulkSaleError, setBulkSaleError] = useState<string | null>(null)

  async function loadBookings() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('bookings')
      .select('*, inventory_items(item_name, modal_price)')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setBookings((data as unknown as BookingRow[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadBookings()
  }, [])

  const filtered = useMemo(() => {
    return bookings
      .map((b) => ({
        booking: b,
        rank: smartSearchRank(search, [
          { value: b.buyer_name },
          { value: b.inventory_items?.item_name },
          { value: b.notes, kind: 'notes' },
        ]),
      }))
      .filter(({ booking, rank }) => (statusFilter ? booking.status === statusFilter : true) && rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.booking.buyer_name.localeCompare(b.booking.buyer_name))
      .map(({ booking }) => booking)
  }, [bookings, search, statusFilter])

  const knownGroupIds = useMemo(
    () => bookings.map((booking) => booking.booking_group_id).filter((id): id is string => Boolean(id)),
    [bookings]
  )

  const selectedBookings = useMemo(
    () => bookings.filter((booking) => selectedBookingIds.includes(booking.id)),
    [bookings, selectedBookingIds]
  )

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((booking) => selectedBookingIds.includes(booking.id))

  function toggleBookingSelection(bookingId: string) {
    setSelectedBookingIds((current) =>
      current.includes(bookingId)
        ? current.filter((id) => id !== bookingId)
        : [...current, bookingId]
    )
  }

  function toggleSelectAll() {
    const filteredIds = filtered.map((booking) => booking.id)
    if (allFilteredSelected) {
      setSelectedBookingIds((current) => current.filter((id) => !filteredIds.includes(id)))
      return
    }
    setSelectedBookingIds((current) => Array.from(new Set([...current, ...filteredIds])))
  }

  function openBulkSaleModal() {
    if (selectedBookings.length === 0) return
    const invalidBookings = selectedBookings.filter((booking) => booking.status !== 'active' || !booking.inventory_item_id)
    if (invalidBookings.length > 0) {
      alert('Only active bookings with linked inventory items can be converted in bulk.')
      return
    }

    const groupIds = Array.from(
      new Set(selectedBookings.map((booking) => booking.booking_group_id).filter(Boolean))
    )
    if (groupIds.length > 1) {
      alert('Please convert one booking group at a time.')
      return
    }

    const firstBuyer = selectedBookings[0]?.buyer_name ?? ''
    const allSameBuyer = selectedBookings.every((booking) => booking.buyer_name === firstBuyer)
    const totalDealPrice = selectedBookings.reduce((sum, booking) => sum + booking.deal_price, 0)

    setBulkSaleForm({
      ...emptyBulkSaleForm,
      buyer_name: allSameBuyer ? firstBuyer : '',
      total_sale_price: String(totalDealPrice),
      sale_date: todayISO(),
    })
    setBulkSaleError(null)
    setShowBulkSaleModal(true)
  }

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
      await logActivity({
        action: 'Booking',
        entity: 'bookings',
        userId: user?.id,
        details: { buyer_name: form.buyer_name.trim(), inventory_item_id: form.inventory_item_id },
      })
    }

    setSaving(false)
    setShowModal(false)
    loadBookings()
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
    await logActivity({
      action: 'Delete',
      entity: 'bookings',
      entityId: b.id,
      userId: user?.id,
      details: { buyer_name: b.buyer_name },
    })
    loadBookings()
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
      booking_group_id: b.booking_group_id,
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
    await logActivity({
      action: 'Sale',
      entity: 'sales',
      userId: user?.id,
      details: { buyer_name: b.buyer_name, booking_id: b.id, inventory_item_id: b.inventory_item_id },
    })

    alert('Booking converted to sale. You can edit fees/costs in the Sales page.')
    loadBookings()
    navigate('/sales')
  }

  async function handleBulkConvertToSale(e: FormEvent) {
    e.preventDefault()
    if (selectedBookings.length === 0) {
      setBulkSaleError('Please select at least one booking.')
      return
    }
    if (!bulkSaleForm.buyer_name.trim()) {
      setBulkSaleError('Buyer name is required.')
      return
    }

    const invalidBookings = selectedBookings.filter((booking) => booking.status !== 'active' || !booking.inventory_item_id)
    if (invalidBookings.length > 0) {
      setBulkSaleError('Only active bookings with linked inventory items can be converted in bulk.')
      return
    }

    const existingGroupIds = Array.from(
      new Set(selectedBookings.map((booking) => booking.booking_group_id).filter(Boolean))
    )
    if (existingGroupIds.length > 1) {
      setBulkSaleError('Please convert one booking group at a time.')
      return
    }

    setBulkSaleSaving(true)
    setBulkSaleError(null)

    const bookingGroupId = existingGroupIds[0] ?? crypto.randomUUID()
    const totalSalePrice = Number(bulkSaleForm.total_sale_price) || 0
    const salePricePerItem = totalSalePrice / selectedBookings.length
    const groupTotalDealPrice =
      selectedBookings.find((booking) => booking.group_total_deal_price !== null)?.group_total_deal_price ??
      selectedBookings.reduce((sum, booking) => sum + booking.deal_price, 0)

    const salesPayload = selectedBookings.map((booking) => {
      const modalPrice = booking.inventory_items?.modal_price ?? 0
      const grossProfit = salePricePerItem - modalPrice
      return {
        inventory_item_id: booking.inventory_item_id,
        customer_id: booking.customer_id,
        booking_group_id: bookingGroupId,
        buyer_name: bulkSaleForm.buyer_name.trim(),
        platform: bulkSaleForm.platform,
        sale_price: salePricePerItem,
        modal_price: modalPrice,
        marketplace_fee: 0,
        packing_cost: 0,
        shipping_subsidy: 0,
        gross_profit: grossProfit,
        net_profit: grossProfit,
        sale_date: bulkSaleForm.sale_date || todayISO(),
        notes: bulkSaleForm.notes.trim() || null,
        created_by: user?.id,
      }
    })

    const { error: saleError } = await supabase.from('sales').insert(salesPayload)
    if (saleError) {
      setBulkSaleSaving(false)
      setBulkSaleError(saleError.message)
      return
    }

    const inventoryItemIds = selectedBookings
      .map((booking) => booking.inventory_item_id)
      .filter((id): id is string => Boolean(id))
    const { error: itemError } = await supabase
      .from('inventory_items')
      .update({ status: 'sold', updated_at: new Date().toISOString() })
      .in('id', inventoryItemIds)

    if (itemError) {
      setBulkSaleSaving(false)
      setBulkSaleError(itemError.message)
      return
    }

    const { error: bookingError } = await supabase
      .from('bookings')
      .update({
        status: 'converted_to_sale',
        booking_group_id: bookingGroupId,
        group_total_deal_price: groupTotalDealPrice,
        updated_at: new Date().toISOString(),
      })
      .in(
        'id',
        selectedBookings.map((booking) => booking.id)
      )

    setBulkSaleSaving(false)
    if (bookingError) {
      setBulkSaleError(bookingError.message)
      return
    }

    setShowBulkSaleModal(false)
    setSelectedBookingIds([])
    await logActivity({
      action: 'Bulk Sale',
      entity: 'sales',
      userId: user?.id,
      details: {
        count: selectedBookings.length,
        buyer_name: bulkSaleForm.buyer_name.trim(),
        booking_group_id: bookingGroupId,
      },
    })
    loadBookings()
    navigate('/sales')
  }

  function handleExport() {
    exportToCSV(
      'bookings.csv',
      bookings.map((b) => ({
        item_name: b.inventory_items?.item_name ?? '',
        buyer_name: b.buyer_name,
        booking_group: bookingGroupDisplayId(b.booking_group_id, knownGroupIds),
        group_total_deal_price: b.group_total_deal_price,
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
    {
      header: 'Select',
      render: (b) => (
        <input
          type="checkbox"
          checked={selectedBookingIds.includes(b.id)}
          onChange={() => toggleBookingSelection(b.id)}
          aria-label={`Select booking for ${b.buyer_name}`}
          className="h-4 w-4 rounded border-gray-300"
        />
      ),
    },
    { header: 'Item', render: (b) => b.inventory_items?.item_name ?? '-' },
    { header: 'Group', render: (b) => bookingGroupDisplayId(b.booking_group_id, knownGroupIds) },
    { header: 'Buyer', render: (b) => b.buyer_name },
    { header: 'Deal price', render: (b) => formatIDR(b.deal_price) },
    { header: 'DP', render: (b) => formatIDR(b.dp_amount) },
    { header: 'Remaining', render: (b) => formatIDR(b.remaining_amount) },
    { header: 'Deadline', render: (b) => formatDate(b.deadline) },
    {
      header: 'Status',
      render: (b) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[b.status]}`}>
          {formatStatus(b.status)}
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
          placeholder="Search buyer, item, or notes..."
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
          <option value="active">{formatStatus('active')}</option>
          <option value="cancelled">{formatStatus('cancelled')}</option>
          <option value="converted_to_sale">{formatStatus('converted_to_sale')}</option>
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
        {selectedBookingIds.length > 0 && (
          <>
            <span className="text-gray-500">{selectedBookingIds.length} selected</span>
            <button
              onClick={openBulkSaleModal}
              className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800"
            >
              Convert Selected to Sale
            </button>
            <button
              onClick={() => setSelectedBookingIds([])}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Clear
            </button>
          </>
        )}
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
              {editingId ? (
                <>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Item *</label>
                <input
                  disabled
                  value={editingItemName}
                  className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm"
                />
                </>
              ) : (
                <ItemCombobox
                  required
                  label="Item *"
                  value={form.inventory_item_id || null}
                  onChange={(item) =>
                    setForm((current) => ({ ...current, inventory_item_id: item?.id ?? '' }))
                  }
                  placeholder="Search ready items..."
                />
              )}
            </div>
            <div>
              <BuyerAutocomplete
                required
                label="Buyer name *"
                value={form.buyer_name}
                onChange={(buyerName) => setForm({ ...form, buyer_name: buyerName })}
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
                  <option value="active">{formatStatus('active')}</option>
                  <option value="cancelled">{formatStatus('cancelled')}</option>
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

      {showBulkSaleModal && (
        <Modal title={`Convert ${selectedBookings.length} booking${selectedBookings.length === 1 ? '' : 's'} to sale`} onClose={() => setShowBulkSaleModal(false)}>
          <form onSubmit={handleBulkConvertToSale} className="space-y-3">
            <div>
              <BuyerAutocomplete
                required
                label="Buyer *"
                value={bulkSaleForm.buyer_name}
                onChange={(buyerName) => setBulkSaleForm({ ...bulkSaleForm, buyer_name: buyerName })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Platform</label>
                <select
                  value={bulkSaleForm.platform}
                  onChange={(e) => setBulkSaleForm({ ...bulkSaleForm, platform: e.target.value as Platform })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Sale date</label>
                <input
                  type="date"
                  value={bulkSaleForm.sale_date}
                  onChange={(e) => setBulkSaleForm({ ...bulkSaleForm, sale_date: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Total sale price (Rp)</label>
              <input
                type="number"
                min="0"
                value={bulkSaleForm.total_sale_price}
                onChange={(e) => setBulkSaleForm({ ...bulkSaleForm, total_sale_price: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
              This creates grouped sale rows with one shared booking group ID. The Sales page will show them as one expandable transaction.
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={bulkSaleForm.notes}
                onChange={(e) => setBulkSaleForm({ ...bulkSaleForm, notes: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            {bulkSaleError && <p className="text-sm text-red-600">{bulkSaleError}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowBulkSaleModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={bulkSaleSaving}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {bulkSaleSaving ? 'Converting...' : 'Convert to sale'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
