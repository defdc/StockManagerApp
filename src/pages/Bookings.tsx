import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, formatStatus, todayISO, splitAmount } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { logActivity } from '../lib/activityLog'
import { bookingGroupDisplayId } from '../lib/bookingGroups'
import { smartSearchRank } from '../lib/search'
import { STATUS_BADGE_CLASSES, FULFILLMENT_STATUSES, FULFILLMENT_LABELS } from '../lib/constants'
import type { Booking, BookingStatus, FulfillmentStatus } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import ItemCombobox from '../components/ItemCombobox'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'

type BookingRow = Booking & { inventory_items: { item_name: string; modal_price: number } | null }
type BookingItemSelection = { inventory_item_id: string }

const emptyForm = {
  inventory_item_id: '',
  buyer_name: '',
  deal_price: '0',
  deadline: '',
  status: 'active' as BookingStatus,
  notes: '',
}

const emptyBulkSaleForm = {
  buyer_name: '',
  total_sale_price: '0',
  sale_date: todayISO(),
  notes: '',
}

/** Priority order for default status sort: active first, then converted, then cancelled. */
const STATUS_ORDER: Record<string, number> = { active: 0, converted_to_sale: 1, cancelled: 2 }

function BundlePriceInput({
  value,
  onChange,
}: {
  value: string
  onChange: (raw: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const display = value ? parseInt(value, 10).toLocaleString('id-ID') : ''

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, '')
    const cursor = e.target.selectionStart ?? 0
    const digitsBeforeCursor = (e.target.value.slice(0, cursor).match(/\d/g) || []).length

    onChange(raw)

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const fv = inputRef.current.value
        let pos = 0
        let digitsSeen = 0
        for (let i = 0; i < fv.length && digitsSeen < digitsBeforeCursor; i++) {
          if (/\d/.test(fv[i])) digitsSeen++
          pos = i + 1
        }
        if (digitsBeforeCursor >= raw.length || raw.length === 0) pos = fv.length
        inputRef.current.setSelectionRange(pos, pos)
      }
    })
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm font-medium text-gray-500">
        Rp
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={display}
        onChange={handleInput}
        placeholder="0"
        className="w-full rounded-md border border-gray-300 px-3 py-2 pl-10 text-sm focus:border-gray-500 focus:outline-none"
      />
    </div>
  )
}

export default function Bookings() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [statusSort, setStatusSort] = useState<'asc' | 'desc'>('asc')

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingItemName, setEditingItemName] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [newBookingItems, setNewBookingItems] = useState<BookingItemSelection[]>([{ inventory_item_id: '' }])
  const [newBookingBuyer, setNewBookingBuyer] = useState('')
  const [newBookingBundlePrice, setNewBookingBundlePrice] = useState('')
  const [newBookingDeadline, setNewBookingDeadline] = useState('')
  const [newBookingNotes, setNewBookingNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([])
  const [showBulkSaleModal, setShowBulkSaleModal] = useState(false)
  const [bulkSaleForm, setBulkSaleForm] = useState(emptyBulkSaleForm)
  const [bulkSaleSaving, setBulkSaleSaving] = useState(false)
  const [bulkSaleError, setBulkSaleError] = useState<string | null>(null)
  const [bulkPurchase, setBulkPurchase] = useState(false)
  const [bulkFulfillmentStatus, setBulkFulfillmentStatus] = useState<FulfillmentStatus>('parking')

  const [singleConvertTarget, setSingleConvertTarget] = useState<BookingRow | null>(null)
  const [singleConvertFulfillment, setSingleConvertFulfillment] = useState<FulfillmentStatus>('parking')
  const [singleConvertSaving, setSingleConvertSaving] = useState(false)

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

  // Priority order for status when no search query drives ranking
  const filtered = useMemo(() => {
    const hasQuery = search.trim().length > 0

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
      .sort((a, b) => {
        // 1. If there's an active search query, rank takes first priority
        if (hasQuery) {
          const rankDiff = (a.rank ?? 0) - (b.rank ?? 0)
          if (rankDiff !== 0) return rankDiff
        }

        // 2. Status ordering (respects sort direction toggle)
        const aOrder = STATUS_ORDER[a.booking.status] ?? 99
        const bOrder = STATUS_ORDER[b.booking.status] ?? 99
        const statusDiff = statusSort === 'asc' ? aOrder - bOrder : bOrder - aOrder
        if (statusDiff !== 0) return statusDiff

        // 3. Within the same status: newest first
        return b.booking.created_at.localeCompare(a.booking.created_at)
      })
      .map(({ booking }) => booking)
  }, [bookings, search, statusFilter, statusSort])

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
    setBulkPurchase(false)
    setBulkFulfillmentStatus('parking')
    setShowBulkSaleModal(true)
  }

  function openAddModal() {
    setEditingId(null)
    setEditingItemId(null)
    setForm(emptyForm)
    setNewBookingItems([{ inventory_item_id: '' }])
    setNewBookingBuyer('')
    setNewBookingBundlePrice('')
    setNewBookingDeadline('')
    setNewBookingNotes('')
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
      deadline: b.deadline ?? '',
      status: b.status === 'converted_to_sale' ? 'active' : b.status,
      notes: b.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  function openSingleConvertModal(b: BookingRow) {
    if (!b.inventory_item_id) {
      alert('This booking has no linked inventory item.')
      return
    }
    setSingleConvertTarget(b)
    setSingleConvertFulfillment('parking')
  }

  function addNewBookingItem() {
    setNewBookingItems((current) => [...current, { inventory_item_id: '' }])
  }

  function updateNewBookingItem(index: number, inventoryItemId: string) {
    setNewBookingItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, inventory_item_id: inventoryItemId } : item)))
  }

  function removeNewBookingItem(index: number) {
    if (newBookingItems.length === 1) return
    setNewBookingItems((current) => current.filter((_, itemIndex) => itemIndex !== index))
  }



  const canSave = useMemo(() => {
    if (editingId) return true
    const selectedCount = newBookingItems.filter((item) => item.inventory_item_id).length
    if (selectedCount === 0) return false
    if (!newBookingBuyer.trim()) return false
    if (newBookingBundlePrice === '') return false
    if (parseInt(newBookingBundlePrice, 10) <= 0) return false
    return true
  }, [editingId, newBookingItems, newBookingBuyer, newBookingBundlePrice])

  const bundleSummary = useMemo(() => {
    const selectedCount = newBookingItems.filter((item) => item.inventory_item_id).length
    const rawPrice = parseInt(newBookingBundlePrice, 10) || 0

    if (editingId) return null

    if (selectedCount === 0) {
      return (
        <p className="text-xs italic text-gray-400">
          Select at least one item to see the price distribution.
        </p>
      )
    }

    if (selectedCount === 1) {
      return (
        <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
          <p className="font-medium">1 item selected</p>
          <p className="mt-1 text-xs text-gray-500">
            This item will receive the full bundle price.
          </p>
        </div>
      )
    }

    if (rawPrice <= 0) {
      return (
        <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
          <p className="font-medium">{selectedCount} items selected</p>
          <p className="mt-1 text-xs italic text-gray-400">
            Enter a price to see the distribution.
          </p>
        </div>
      )
    }

    const [firstSlot] = splitAmount(rawPrice, selectedCount)
    const base = firstSlot
    const remainder = rawPrice - base * selectedCount
    const perItemFormatted = base.toLocaleString('id-ID')
    const bundleFormatted = rawPrice.toLocaleString('id-ID')

    return (
      <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
        <p className="font-medium">{selectedCount} items selected</p>
        <div className="mt-1 space-y-0.5 text-xs">
          <p>
            Bundle price: <span className="font-medium">Rp {bundleFormatted}</span>
          </p>
          <p>
            ≈ <span className="font-medium">Rp {perItemFormatted}</span> per item
          </p>
          {remainder > 0 && (
            <p className="text-gray-400">
              Remaining Rp {remainder.toLocaleString('id-ID')} is automatically assigned to the last item.
            </p>
          )}
        </div>
      </div>
    )
  }, [newBookingItems, newBookingBundlePrice, editingId])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()

    if (editingId) {
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
      const payload = {
        inventory_item_id: form.inventory_item_id,
        buyer_name: form.buyer_name.trim(),
        deal_price: dealPrice,
        deadline: form.deadline || null,
        status: form.status,
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      }

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

      setSaving(false)
      setShowModal(false)
      loadBookings()
      return
    }

    const selectedItems = newBookingItems.filter((item) => item.inventory_item_id)
    if (selectedItems.length === 0) {
      setFormError('Please select at least one item.')
      return
    }
    if (!newBookingBuyer.trim()) {
      setFormError('Buyer name is required.')
      return
    }

    setSaving(true)
    setFormError(null)

    const bookingGroupId = crypto.randomUUID()
    const bundleDealPrice = parseInt(newBookingBundlePrice, 10) || 0
    const splitPrices = splitAmount(bundleDealPrice, selectedItems.length)
    const selectedItemIds = selectedItems.map((item) => item.inventory_item_id)

    // Fetch inventory item details (including batch info) to compute live modal_price snapshot
    const { data: itemRows, error: fetchError } = await supabase
      .from('inventory_items')
      .select('id, batch_name, batch_modal_total, modal_price')
      .in('id', selectedItemIds)
    if (fetchError) {
      setSaving(false)
      setFormError(fetchError.message)
      return
    }

    const batchNames = Array.from(
      new Set(
        (itemRows ?? [])
          .map((r) => r.batch_name?.trim())
          .filter((name): name is string => Boolean(name))
      )
    )

    let allBatchItems: { batch_name: string | null; batch_modal_total: number | null }[] = []
    if (batchNames.length > 0) {
      const { data: bItems } = await supabase
        .from('inventory_items')
        .select('batch_name, batch_modal_total')
        .in('batch_name', batchNames)
      allBatchItems = bItems ?? []
    }

    const modalByItemId = new Map<string, number>()
    for (const item of itemRows ?? []) {
      const batchName = item.batch_name?.trim()
      if (batchName) {
        const siblings = allBatchItems.filter((i) => i.batch_name?.trim() === batchName)
        const batchTotal =
          siblings.find((i) => (i.batch_modal_total ?? 0) > 0)?.batch_modal_total ??
          item.batch_modal_total ??
          0
        const liveModal =
          batchTotal > 0 && siblings.length > 0
            ? Math.floor(batchTotal / siblings.length)
            : item.modal_price ?? 0
        modalByItemId.set(item.id, liveModal)
      } else {
        modalByItemId.set(item.id, item.modal_price ?? 0)
      }
    }

    const bookingPayloads = selectedItems.map((item, index) => ({
      inventory_item_id: item.inventory_item_id,
      booking_group_id: bookingGroupId,
      group_total_deal_price: bundleDealPrice,
      buyer_name: newBookingBuyer.trim(),
      deal_price: splitPrices[index] ?? 0,
      modal_price: modalByItemId.get(item.inventory_item_id) ?? 0,
      dp_amount: 0,
      remaining_amount: 0,
      deadline: newBookingDeadline || null,
      status: 'active' as BookingStatus,
      notes: newBookingNotes.trim() || null,
      created_by: user?.id,
    }))

    const { error } = await supabase.from('bookings').insert(bookingPayloads)
    if (error) {
      setSaving(false)
      setFormError(error.message)
      return
    }

    const inventoryItemIds = selectedItems.map((item) => item.inventory_item_id)
    const { error: itemError } = await supabase
      .from('inventory_items')
      .update({ status: 'booked', updated_at: new Date().toISOString() })
      .in('id', inventoryItemIds)
    if (itemError) {
      setSaving(false)
      setFormError(itemError.message)
      return
    }

    void logActivity({
      action: 'Booking',
      entity: 'bookings',
      userId: user?.id,
      details: {
        buyer_name: newBookingBuyer.trim(),
        booking_group_id: bookingGroupId,
        count: selectedItems.length,
      },
    })

    setSaving(false)
    setShowModal(false)
    setNewBookingItems([{ inventory_item_id: '' }])
    setNewBookingBuyer('')
    setNewBookingBundlePrice('')
    setNewBookingDeadline('')
    setNewBookingNotes('')
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
    void logActivity({
      action: 'Delete',
      entity: 'bookings',
      entityId: b.id,
      userId: user?.id,
      details: { buyer_name: b.buyer_name },
    })
    loadBookings()
  }

  async function handleSingleConvertSubmit(e: FormEvent) {
    e.preventDefault()
    const b = singleConvertTarget
    if (!b) return

    setSingleConvertSaving(true)

    // Use the modal_price that was snapshotted at booking-creation time.
    // Do NOT re-fetch the item's current modal_price — it may have changed.
    const modalPrice = b.modal_price
    const salePrice = b.deal_price
    const grossProfit = salePrice - modalPrice
    const netProfit = grossProfit

    const { error: saleError } = await supabase.from('sales').insert({
      inventory_item_id: b.inventory_item_id,
      customer_id: b.customer_id,
      booking_group_id: b.booking_group_id,
      buyer_name: b.buyer_name,
      sale_price: salePrice,
      modal_price: modalPrice,
      marketplace_fee: 0,
      packing_cost: 0,
      gross_profit: grossProfit,
      net_profit: netProfit,
      sale_date: todayISO(),
      fulfillment_status: singleConvertFulfillment,
      notes: 'Converted from booking',
      created_by: user?.id,
    })
    if (saleError) {
      setSingleConvertSaving(false)
      alert(saleError.message)
      return
    }

    await supabase.from('inventory_items').update({ status: 'sold' }).eq('id', b.inventory_item_id)
    await supabase.from('bookings').update({ status: 'converted_to_sale' }).eq('id', b.id)
    void logActivity({
      action: 'Sale',
      entity: 'sales',
      userId: user?.id,
      details: { buyer_name: b.buyer_name, booking_id: b.id, inventory_item_id: b.inventory_item_id },
    })

    setSingleConvertSaving(false)
    setSingleConvertTarget(null)
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

    const invalidBookings = selectedBookings.filter((booking) => booking.status !== 'active' || !booking.inventory_item_id)
    if (invalidBookings.length > 0) {
      setBulkSaleError('Only active bookings with linked inventory items can be converted in bulk.')
      return
    }

    // Bulk Purchase mode: all bookings must share the same buyer
    if (bulkPurchase) {
      if (!bulkSaleForm.buyer_name.trim()) {
        setBulkSaleError('Buyer name is required for Bulk Purchase.')
        return
      }
      const uniqueBuyers = new Set(selectedBookings.map((b) => b.buyer_name.trim().toLowerCase()))
      if (uniqueBuyers.size > 1) {
        setBulkSaleError(
          'Bulk Purchase requires all selected bookings to belong to the same buyer.'
        )
        return
      }
    }

    setBulkSaleSaving(true)
    setBulkSaleError(null)

    const totalSalePrice = Number(bulkSaleForm.total_sale_price) || 0
    const splitSalePrices = splitAmount(totalSalePrice, selectedBookings.length)

    const salesPayload = selectedBookings.map((booking, index) => {
      // Use modal_price snapshotted at booking-creation time (frozen, never recalculated).
      const modalPrice = booking.modal_price
      const salePrice = bulkPurchase ? splitSalePrices[index] : booking.deal_price
      const grossProfit = salePrice - modalPrice
      return {
        inventory_item_id: booking.inventory_item_id,
        customer_id: booking.customer_id,
        // Always preserve each booking's own group — never merge groups
        booking_group_id: booking.booking_group_id,
        buyer_name: bulkPurchase ? bulkSaleForm.buyer_name.trim() : booking.buyer_name.trim(),
        sale_price: salePrice,
        modal_price: modalPrice,
        marketplace_fee: 0,
        packing_cost: 0,
        gross_profit: grossProfit,
        net_profit: grossProfit,
        sale_date: bulkSaleForm.sale_date || todayISO(),
        fulfillment_status: bulkFulfillmentStatus,
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
    void logActivity({
      action: 'Bulk Sale',
      entity: 'sales',
      userId: user?.id,
      details: {
        count: selectedBookings.length,
        buyer_name: bulkSaleForm.buyer_name.trim(),
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
    { header: 'Deadline', render: (b) => formatDate(b.deadline) },
    {
      header: 'Status',
      headerNode: (
        <button
          type="button"
          onClick={() => setStatusSort((s) => (s === 'asc' ? 'desc' : 'asc'))}
          className="flex items-center gap-1 hover:text-gray-900"
          title="Sort by status"
        >
          Status
          <span className="text-xs">{statusSort === 'asc' ? '▲' : '▼'}</span>
        </button>
      ),
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
            <button onClick={() => openSingleConvertModal(b)} className="text-green-700 hover:underline">
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

  const bulkSaleHelperText = bulkPurchase
    ? 'Total price will be split evenly across all selected items (remainder goes to last item).'
    : 'Each booking will be converted at its own deal price, preserving all individual booking details.'

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
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="converted_to_sale">Converted to Sale</option>
          <option value="cancelled">Cancelled</option>
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

      {/* Single Convert to Sale Modal */}
      {singleConvertTarget && (
        <Modal title={`Convert to sale — ${singleConvertTarget.buyer_name}`} onClose={() => setSingleConvertTarget(null)}>
          <form onSubmit={handleSingleConvertSubmit} className="space-y-3">
            <p className="text-sm text-gray-600">
              Item: <span className="font-medium">{singleConvertTarget.inventory_items?.item_name ?? '-'}</span>
              <br />
              Deal price: <span className="font-medium">{formatIDR(singleConvertTarget.deal_price)}</span>
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Shipping status *</label>
              <select
                value={singleConvertFulfillment}
                onChange={(e) => setSingleConvertFulfillment(e.target.value as FulfillmentStatus)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                required
              >
                {FULFILLMENT_STATUSES.filter((s) => s !== 'delivered').map((status) => (
                  <option key={status} value={status}>
                    {FULFILLMENT_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSingleConvertTarget(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={singleConvertSaving}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {singleConvertSaving ? 'Converting...' : 'Convert to sale'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showModal && (
        <Modal title={editingId ? 'Edit booking' : 'Add booking'} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            {!editingId && (
              <>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="block text-sm font-medium text-gray-700">Items</label>
                    <button type="button" onClick={addNewBookingItem} className="text-sm font-medium text-blue-700 hover:underline">
                      + Add Item
                    </button>
                  </div>
                  <div className="space-y-2">
                    {newBookingItems.map((item, index) => (
                      <div key={`${item.inventory_item_id}-${index}`} className="flex items-start gap-2">
                        <div className="flex-1">
                          <ItemCombobox
                            required
                            value={item.inventory_item_id || null}
                            onChange={(selectedItem) => updateNewBookingItem(index, selectedItem?.id ?? '')}
                            placeholder="Search ready items..."
                          />
                        </div>
                        {newBookingItems.length > 1 && (
                          <button type="button" onClick={() => removeNewBookingItem(index)} className="rounded-md border border-gray-300 px-2 py-2 text-sm text-gray-600 hover:bg-gray-50">
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <BuyerAutocomplete
                    required
                    label="Buyer name *"
                    value={newBookingBuyer}
                    onChange={(buyerName) => setNewBookingBuyer(buyerName)}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Bundle deal price *</label>
                  <BundlePriceInput
                    value={newBookingBundlePrice}
                    onChange={setNewBookingBundlePrice}
                  />
                </div>

                {bundleSummary}

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Deadline</label>
                  <input
                    type="date"
                    value={newBookingDeadline}
                    onChange={(event) => setNewBookingDeadline(event.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
                  <textarea
                    value={newBookingNotes}
                    onChange={(event) => setNewBookingNotes(event.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </>
            )}

            {editingId && (
              <>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Item *</label>
                  <input disabled value={editingItemName} className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm" />
                </div>
                <div>
                  <BuyerAutocomplete
                    required
                    label="Buyer name *"
                    value={form.buyer_name}
                    onChange={(buyerName) => setForm({ ...form, buyer_name: buyerName })}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Deal price (Rp)</label>
                  <input
                    type="number"
                    min="0"
                    value={form.deal_price}
                    onChange={(event) => setForm({ ...form, deal_price: event.target.value })}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Deadline</label>
                  <input
                    type="date"
                    value={form.deadline}
                    onChange={(event) => setForm({ ...form, deadline: event.target.value })}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Status</label>
                  <select
                    value={form.status}
                    onChange={(event) => setForm({ ...form, status: event.target.value as BookingStatus })}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="active">{formatStatus('active')}</option>
                    <option value="cancelled">{formatStatus('cancelled')}</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-400">Use the "Convert to sale" action on the list to mark this as sold.</p>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
                  <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={2} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </>
            )}

            {formError && <p className="text-sm text-red-600">{formError}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowModal(false)} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700">
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || (!editingId && !canSave)}
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
            {bulkPurchase && (
              <div>
                <BuyerAutocomplete
                  required
                  label="Buyer *"
                  value={bulkSaleForm.buyer_name}
                  onChange={(buyerName) => setBulkSaleForm({ ...bulkSaleForm, buyer_name: buyerName })}
                />
              </div>
            )}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Sale date</label>
              <input
                type="date"
                value={bulkSaleForm.sale_date}
                onChange={(e) => setBulkSaleForm({ ...bulkSaleForm, sale_date: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Shipping status *</label>
              <select
                value={bulkFulfillmentStatus}
                onChange={(e) => setBulkFulfillmentStatus(e.target.value as FulfillmentStatus)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                required
              >
                {FULFILLMENT_STATUSES.filter((s) => s !== 'delivered').map((status) => (
                  <option key={status} value={status}>
                    {FULFILLMENT_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
              <input
                id="bulk-purchase-toggle"
                type="checkbox"
                checked={bulkPurchase}
                onChange={(event) => setBulkPurchase(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <label htmlFor="bulk-purchase-toggle" className="text-sm font-medium text-gray-700">
                Bulk Purchase (Borongan)
              </label>
            </div>
            {bulkPurchase && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Total deal price (Rp)</label>
                <input
                  type="number"
                  min="0"
                  value={bulkSaleForm.total_sale_price}
                  onChange={(e) => setBulkSaleForm({ ...bulkSaleForm, total_sale_price: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            )}
            <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">{bulkSaleHelperText}</div>
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
