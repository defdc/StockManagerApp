import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, todayISO } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { logActivity } from '../lib/activityLog'
import { bookingGroupDisplayId, bookingGroupFriendlyLabel } from '../lib/bookingGroups'
import { smartSearchRank } from '../lib/search'
import { FULFILLMENT_BADGE_CLASSES, FULFILLMENT_LABELS, FULFILLMENT_STATUSES } from '../lib/constants'
import type { FulfillmentStatus, Sale } from '../types/database'
import ItemCombobox from '../components/ItemCombobox'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'

type SaleRow = Sale & { inventory_items: { item_name: string; batch_name: string | null } | null }

interface SaleGroup {
  key: string
  bookingGroupId: string | null
  sales: SaleRow[]
  isGrouped: boolean
  itemCount: number
  buyerName: string
  saleDate: string
  totalRevenue: number
  totalModal: number
  grossProfit: number
  netProfit: number
}

interface DailySalesGroup {
  key: string
  saleDate: string
  revenue: number
  profit: number
  transactions: number
  itemsSold: number
  transactionGroups: SaleGroup[]
}

const emptyForm = {
  inventory_item_id: '',
  buyer_name: '',
  sale_price: '0',
  modal_price: '0',
  marketplace_fee: '0',
  packing_cost: '0',
  sale_date: todayISO(),
  fulfillment_status: 'parking' as FulfillmentStatus,
  notes: '',
}

const emptyGroupEditForm = {
  buyer_name: '',
  sale_date: todayISO(),
  fulfillment_status: 'parking' as FulfillmentStatus,
  notes: '',
}

const SELLABLE_ITEM_STATUSES = ['ready', 'booked']

export default function Sales() {
  const { user } = useAuth()
  const [sales, setSales] = useState<SaleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingItemName, setEditingItemName] = useState<string>('')
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<string[]>([])
  const [expandedDateKeys, setExpandedDateKeys] = useState<string[]>([])
  const [showGroupEditModal, setShowGroupEditModal] = useState(false)
  const [groupEditTarget, setGroupEditTarget] = useState<SaleGroup | null>(null)
  const [groupEditForm, setGroupEditForm] = useState(emptyGroupEditForm)
  const [groupEditError, setGroupEditError] = useState<string | null>(null)
  const [fulfillmentFilter, setFulfillmentFilter] = useState<'all' | FulfillmentStatus>('all')

  // ── Bulk selection state ─────────────────────────────────────────────────────
  const [selectedSaleIds, setSelectedSaleIds] = useState<string[]>([])
  const [showBulkShippingModal, setShowBulkShippingModal] = useState(false)
  const [bulkShippingStatus, setBulkShippingStatus] = useState<FulfillmentStatus>('parking')
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)
  const [showBulkUndoConfirm, setShowBulkUndoConfirm] = useState(false)
  const [bulkActionSaving, setBulkActionSaving] = useState(false)
  const [bulkActionError, setBulkActionError] = useState<string | null>(null)

  async function loadSales() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('sales')
      .select('*, inventory_items(item_name, batch_name)')
      .order('sale_date', { ascending: false })
    if (error) setError(error.message)
    else setSales((data as unknown as SaleRow[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadSales()
  }, [])

  const filtered = useMemo(() => {
    return sales
      .map((sale) => ({
        sale,
        rank: smartSearchRank(search, [
          { value: sale.buyer_name },
          { value: sale.inventory_items?.item_name },
          { value: sale.notes, kind: 'notes' },
        ]),
      }))
      .filter(({ rank, sale }) => rank !== null && (fulfillmentFilter === 'all' || sale.fulfillment_status === fulfillmentFilter))
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.sale.sale_date.localeCompare(a.sale.sale_date))
      .map(({ sale }) => sale)
  }, [sales, search, fulfillmentFilter])

  const knownGroupIds = useMemo(
    () => sales.map((sale) => sale.booking_group_id).filter((id): id is string => Boolean(id)),
    [sales]
  )

  const dailySalesGroups = useMemo(() => {
    const groupedByDate = new Map<string, SaleRow[]>()
    filtered.forEach((sale) => {
      groupedByDate.set(sale.sale_date, [...(groupedByDate.get(sale.sale_date) ?? []), sale])
    })

    return Array.from(groupedByDate.entries()).map(([saleDate, daySales]) => {
      const transactionGroups = new Map<string, SaleRow[]>()
      daySales.forEach((sale) => {
        const key = sale.booking_group_id ? `group:${sale.booking_group_id}` : `sale:${sale.id}`
        transactionGroups.set(key, [...(transactionGroups.get(key) ?? []), sale])
      })

      const transactionGroupList = Array.from(transactionGroups.entries()).map(([key, groupSales]) => {
        const firstSale = groupSales[0]
        return {
          key,
          bookingGroupId: firstSale.booking_group_id,
          sales: groupSales,
          isGrouped: Boolean(firstSale.booking_group_id) && groupSales.length > 1,
          itemCount: groupSales.length,
          buyerName: firstSale.buyer_name,
          saleDate: firstSale.sale_date,
          totalRevenue: groupSales.reduce((sum, sale) => sum + sale.sale_price, 0),
          totalModal: groupSales.reduce((sum, sale) => sum + sale.modal_price, 0),
          grossProfit: groupSales.reduce((sum, sale) => sum + sale.gross_profit, 0),
          netProfit: groupSales.reduce((sum, sale) => sum + sale.net_profit, 0),
        } satisfies SaleGroup
      })

      return {
        key: saleDate,
        saleDate,
        revenue: daySales.reduce((sum, sale) => sum + sale.sale_price, 0),
        profit: daySales.reduce((sum, sale) => sum + sale.net_profit, 0),
        transactions: transactionGroupList.length,
        itemsSold: daySales.length,
        transactionGroups: transactionGroupList,
      } satisfies DailySalesGroup
    })
  }, [filtered])

  useEffect(() => {
    if (dailySalesGroups.length > 0 && expandedDateKeys.length === 0) {
      setExpandedDateKeys(dailySalesGroups.map((group) => group.key))
    }
  }, [dailySalesGroups, expandedDateKeys])

  function toggleGroupExpanded(groupKey: string) {
    setExpandedGroupKeys((current) =>
      current.includes(groupKey) ? current.filter((key) => key !== groupKey) : [...current, groupKey]
    )
  }

  function toggleDateExpanded(dateKey: string) {
    setExpandedDateKeys((current) =>
      current.includes(dateKey) ? current.filter((key) => key !== dateKey) : [...current, dateKey]
    )
  }

  function getBatchLabel(sale: SaleRow | null | undefined) {
    return sale?.inventory_items?.batch_name?.trim() || 'Unassigned'
  }

  function getBatchSummary(sales: SaleRow[]) {
    return Array.from(new Set(sales.map((sale) => getBatchLabel(sale)).filter(Boolean))).join(', ') || 'Unassigned'
  }

  // ── Bulk selection helpers ─────────────────────────────────────────────────
  // All individual sale IDs currently visible (including inside expanded groups)
  const allVisibleSaleIds = useMemo(
    () => filtered.map((s) => s.id),
    [filtered]
  )
  const selectedSales = useMemo(
    () => sales.filter((s) => selectedSaleIds.includes(s.id)),
    [sales, selectedSaleIds]
  )

  function toggleSaleSelection(saleId: string) {
    setSelectedSaleIds((cur) => cur.includes(saleId) ? cur.filter((id) => id !== saleId) : [...cur, saleId])
  }

  function toggleSelectAll() {
    const allSelected = allVisibleSaleIds.every((id) => selectedSaleIds.includes(id))
    if (allSelected) {
      setSelectedSaleIds((cur) => cur.filter((id) => !allVisibleSaleIds.includes(id)))
    } else {
      setSelectedSaleIds((cur) => Array.from(new Set([...cur, ...allVisibleSaleIds])))
    }
  }

  async function handleBulkShippingStatus(e: React.FormEvent) {
    e.preventDefault()
    setBulkActionSaving(true)
    setBulkActionError(null)
    const { error } = await supabase
      .from('sales')
      .update({ fulfillment_status: bulkShippingStatus, updated_at: new Date().toISOString() })
      .in('id', selectedSaleIds)
    setBulkActionSaving(false)
    if (error) { setBulkActionError(error.message); return }
    setShowBulkShippingModal(false)
    setSelectedSaleIds([])
    loadSales()
  }

  async function handleBulkDelete() {
    setBulkActionSaving(true)
    setBulkActionError(null)
    for (const sale of selectedSales) {
      const { error } = await supabase.from('sales').delete().eq('id', sale.id)
      if (error) { setBulkActionError(error.message); setBulkActionSaving(false); return }
      if (sale.inventory_item_id) {
        await supabase.from('inventory_items').update({ status: 'ready' }).eq('id', sale.inventory_item_id).eq('status', 'sold')
      }
    }
    setBulkActionSaving(false)
    setShowBulkDeleteConfirm(false)
    setSelectedSaleIds([])
    loadSales()
  }

  async function handleBulkUndo() {
    setBulkActionSaving(true)
    setBulkActionError(null)
    for (const sale of selectedSales) {
      let originatingBookingId: string | null = null
      if (sale.inventory_item_id) {
        let q = supabase.from('bookings').select('id').eq('inventory_item_id', sale.inventory_item_id).eq('status', 'converted_to_sale').order('updated_at', { ascending: false }).limit(1)
        if (sale.booking_group_id) q = q.eq('booking_group_id', sale.booking_group_id)
        const { data: bks } = await q
        originatingBookingId = bks?.[0]?.id ?? null
      }
      const { error } = await supabase.from('sales').delete().eq('id', sale.id)
      if (error) { setBulkActionError(error.message); setBulkActionSaving(false); return }
      if (originatingBookingId) {
        await supabase.from('bookings').update({ status: 'active', updated_at: new Date().toISOString() }).eq('id', originatingBookingId)
        if (sale.inventory_item_id) {
          await supabase.from('inventory_items').update({ status: 'booked', updated_at: new Date().toISOString() }).eq('id', sale.inventory_item_id)
        }
      } else if (sale.inventory_item_id) {
        await supabase.from('inventory_items').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', sale.inventory_item_id).eq('status', 'sold')
      }
    }
    setBulkActionSaving(false)
    setShowBulkUndoConfirm(false)
    setSelectedSaleIds([])
    loadSales()
  }

  async function copySummary(group: DailySalesGroup) {
    const items = group.transactionGroups.flatMap((transactionGroup) => transactionGroup.sales)
    const itemLines = items.flatMap((sale, index) => [
      `${index + 1}.`,
      sale.inventory_items?.item_name ?? '-',
      `Batch : ${getBatchLabel(sale)}`,
      `Buyer : ${sale.buyer_name}`,
      `Sale : ${formatIDR(sale.sale_price)}`,
      '',
    ])

    const summary = [
      formatDate(group.saleDate),
      '',
      'Revenue',
      formatIDR(group.revenue),
      '',
      'Profit',
      formatIDR(group.profit),
      '',
      'Transactions',
      String(group.transactions),
      '',
      'Items Sold',
      String(group.itemsSold),
      '',
      ...itemLines,
      'End of Report',
    ].join('\n')

    try {
      await navigator.clipboard.writeText(summary)
    } catch {
      // Ignore clipboard failures in unsupported contexts.
    }
  }

  function openAddModal() {
    setEditingId(null)
    setForm(emptyForm)
    setFormError(null)
    setShowModal(true)
  }

  function openGroupEditModal(group: SaleGroup) {
    const firstSale = group.sales[0]
    setGroupEditTarget(group)
    setGroupEditForm({
      buyer_name: firstSale.buyer_name,
      sale_date: firstSale.sale_date,
      fulfillment_status: firstSale.fulfillment_status ?? 'parking',
      notes: firstSale.notes ?? '',
    })
    setGroupEditError(null)
    setShowGroupEditModal(true)
  }

  function openEditModal(s: SaleRow) {
    setEditingId(s.id)
    setEditingItemName(s.inventory_items?.item_name ?? '-')
    setForm({
      inventory_item_id: s.inventory_item_id ?? '',
      buyer_name: s.buyer_name,
      sale_price: String(Math.round(s.sale_price)),
      modal_price: String(Math.round(s.modal_price)),
      marketplace_fee: String(Math.round(s.marketplace_fee)),
      packing_cost: String(Math.round(s.packing_cost)),
      sale_date: s.sale_date,
      fulfillment_status: s.fulfillment_status ?? 'parking',
      notes: s.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  const salePrice = Number(form.sale_price) || 0
  const modalPrice = Number(form.modal_price) || 0
  const marketplaceFee = Number(form.marketplace_fee) || 0
  const packingCost = Number(form.packing_cost) || 0
  const grossProfitPreview = salePrice - modalPrice
  const netProfitPreview = grossProfitPreview - marketplaceFee - packingCost

  async function handleGroupEditSubmit(e: FormEvent) {
    e.preventDefault()
    if (!groupEditTarget?.bookingGroupId) {
      setGroupEditError('This transaction does not have a shared booking group.')
      return
    }
    if (!groupEditForm.buyer_name.trim()) {
      setGroupEditError('Buyer name is required.')
      return
    }

    setSaving(true)
    setGroupEditError(null)

    const { error } = await supabase
      .from('sales')
      .update({
        buyer_name: groupEditForm.buyer_name.trim(),
        sale_date: groupEditForm.sale_date || todayISO(),
        fulfillment_status: groupEditForm.fulfillment_status,
        notes: groupEditForm.notes.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('booking_group_id', groupEditTarget.bookingGroupId)

    setSaving(false)
    if (error) {
      setGroupEditError(error.message)
      return
    }

    setShowGroupEditModal(false)
    setGroupEditTarget(null)
    loadSales()
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!editingId && !form.inventory_item_id) {
      setFormError('Please select an item.')
      return
    }
    if (!form.buyer_name.trim()) {
      setFormError('Buyer name is required.')
      return
    }
    setSaving(true)
    setFormError(null)

    const payload = {
      buyer_name: form.buyer_name.trim(),
      sale_price: salePrice,
      modal_price: modalPrice,
      marketplace_fee: marketplaceFee,
      packing_cost: packingCost,
      gross_profit: grossProfitPreview,
      net_profit: netProfitPreview,
      sale_date: form.sale_date || todayISO(),
      fulfillment_status: form.fulfillment_status,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    if (editingId) {
      const { error } = await supabase.from('sales').update(payload).eq('id', editingId)
      if (error) {
        setSaving(false)
        setFormError(error.message)
        return
      }
    } else {
      const { error } = await supabase.from('sales').insert({
        ...payload,
        inventory_item_id: form.inventory_item_id,
        created_by: user?.id,
      })
      if (error) {
        setSaving(false)
        setFormError(error.message)
        return
      }
      await supabase.from('inventory_items').update({ status: 'sold' }).eq('id', form.inventory_item_id)
      void logActivity({
        action: 'Sale',
        entity: 'sales',
        userId: user?.id,
        details: { buyer_name: form.buyer_name.trim(), inventory_item_id: form.inventory_item_id },
      })
    }

    setSaving(false)
    setShowModal(false)
    loadSales()
  }

  async function handleDelete(s: SaleRow) {
    if (!confirm(`Delete sale to "${s.buyer_name}"? This cannot be undone.`)) return
    const { error } = await supabase.from('sales').delete().eq('id', s.id)
    if (error) {
      alert(error.message)
      return
    }
    if (s.inventory_item_id) {
      await supabase
        .from('inventory_items')
        .update({ status: 'ready' })
        .eq('id', s.inventory_item_id)
        .eq('status', 'sold')
    }
    void logActivity({
      action: 'Delete',
      entity: 'sales',
      entityId: s.id,
      userId: user?.id,
      details: { buyer_name: s.buyer_name, inventory_item_id: s.inventory_item_id },
    })
    loadSales()
  }

  async function handleUndoSale(s: SaleRow) {
    if (!confirm(`Undo sale to "${s.buyer_name}"? The sale record will be deleted.`)) return

    let originatingBookingId: string | null = null
    if (s.inventory_item_id) {
      let bookingQuery = supabase
        .from('bookings')
        .select('id')
        .eq('inventory_item_id', s.inventory_item_id)
        .eq('status', 'converted_to_sale')
        .order('updated_at', { ascending: false })
        .limit(1)

      if (s.booking_group_id) bookingQuery = bookingQuery.eq('booking_group_id', s.booking_group_id)

      const { data: bookings } = await bookingQuery
      originatingBookingId = bookings?.[0]?.id ?? null
    }

    const { error: deleteError } = await supabase.from('sales').delete().eq('id', s.id)
    if (deleteError) {
      alert(deleteError.message)
      return
    }

    if (originatingBookingId) {
      await supabase
        .from('bookings')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', originatingBookingId)
      if (s.inventory_item_id) {
        await supabase
          .from('inventory_items')
          .update({ status: 'booked', updated_at: new Date().toISOString() })
          .eq('id', s.inventory_item_id)
      }
    } else if (s.inventory_item_id) {
      await supabase
        .from('inventory_items')
        .update({ status: 'ready', updated_at: new Date().toISOString() })
        .eq('id', s.inventory_item_id)
        .eq('status', 'sold')
    }

    void logActivity({
      action: 'Undo Sale',
      entity: 'sales',
      entityId: s.id,
      userId: user?.id,
      details: {
        buyer_name: s.buyer_name,
        inventory_item_id: s.inventory_item_id,
        restored_booking_id: originatingBookingId,
      },
    })

    loadSales()
  }

  function handleExport() {
    exportToCSV(
      'sales.csv',
      sales.map((s) => ({
        item_name: s.inventory_items?.item_name ?? '',
        booking_group: bookingGroupDisplayId(s.booking_group_id, knownGroupIds),
        buyer_name: s.buyer_name,
        sale_price: s.sale_price,
        modal_price: s.modal_price,
        marketplace_fee: s.marketplace_fee,
        packing_cost: s.packing_cost,
        gross_profit: s.gross_profit,
        net_profit: s.net_profit,
        sale_date: s.sale_date,
      }))
    )
  }

  function renderSaleActions(sale: SaleRow) {
    return (
      <div className="flex gap-2">
        <button onClick={() => openEditModal(sale)} className="text-blue-600 hover:underline">
          Edit
        </button>
        <button onClick={() => handleUndoSale(sale)} className="text-amber-700 hover:underline">
          Undo Sale
        </button>
        <button onClick={() => handleDelete(sale)} className="text-red-600 hover:underline">
          Delete
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Sales</h1>
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
            + Add sale
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search buyer, item, or notes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <select
          value={fulfillmentFilter}
          onChange={(e) => setFulfillmentFilter(e.target.value as 'all' | FulfillmentStatus)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        >
          <option value="all">All</option>
          {FULFILLMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {FULFILLMENT_LABELS[status]}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk action toolbar — appears when rows are selected */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
        <label className="flex items-center gap-2 text-gray-700">
          <input
            type="checkbox"
            checked={allVisibleSaleIds.length > 0 && allVisibleSaleIds.every((id) => selectedSaleIds.includes(id))}
            onChange={toggleSelectAll}
            disabled={allVisibleSaleIds.length === 0}
            className="h-4 w-4 rounded border-gray-300"
          />
          Select all visible
        </label>
        {selectedSaleIds.length > 0 && (
          <>
            <span className="text-gray-500">{selectedSaleIds.length} selected</span>
            <button
              onClick={() => { setBulkShippingStatus('parking'); setBulkActionError(null); setShowBulkShippingModal(true) }}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Change Shipping Status
            </button>
            <button
              onClick={() => { setBulkActionError(null); setShowBulkUndoConfirm(true) }}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
            >
              Undo Sale
            </button>
            <button
              onClick={() => { setBulkActionError(null); setShowBulkDeleteConfirm(true) }}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
            >
              Delete
            </button>
            <button
              onClick={() => setSelectedSaleIds([])}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading sales...</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Select</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Date</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Items</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Batch</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Shipping status</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Buyer</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Revenue</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Modal</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Gross profit</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Net profit</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {dailySalesGroups.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-3 py-6 text-center text-gray-400">
                    No data found.
                    </td>
                  </tr>
              ) : (
                dailySalesGroups.map((dayGroup) => {
                  const isDateExpanded = expandedDateKeys.includes(dayGroup.key)
                  return (
                    <Fragment key={dayGroup.key}>
                      <tr className="bg-gray-50">
                    <td colSpan={11} className="px-3 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => toggleDateExpanded(dayGroup.key)}
                              className="flex items-center gap-2 text-left font-semibold text-gray-900"
                            >
                              <span>{isDateExpanded ? '▼' : '▶'}</span>
                              <span>{formatDate(dayGroup.saleDate)}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void copySummary(dayGroup)}
                              className="text-sm font-medium text-blue-700 hover:underline"
                            >
                              Copy Summary
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isDateExpanded && (
                        <>
                          <tr className="bg-white">
                            <td colSpan={10} className="px-3 py-3">
                              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Revenue</p>
                                  <p className="mt-1 text-lg font-semibold text-gray-900">{formatIDR(dayGroup.revenue)}</p>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Profit</p>
                                  <p className="mt-1 text-lg font-semibold text-gray-900">{formatIDR(dayGroup.profit)}</p>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Transactions</p>
                                  <p className="mt-1 text-lg font-semibold text-gray-900">{dayGroup.transactions}</p>
                                </div>
                                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Items Sold</p>
                                  <p className="mt-1 text-lg font-semibold text-gray-900">{dayGroup.itemsSold}</p>
                                </div>
                              </div>
                            </td>
                          </tr>
                          {dayGroup.transactionGroups.map((group) => {
                            const firstSale = group.sales[0]
                            const isExpanded = expandedGroupKeys.includes(group.key)
                            return (
                              <Fragment key={group.key}>
                                <tr className="hover:bg-gray-50">
                                  <td className="whitespace-nowrap px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={group.sales.every((s) => selectedSaleIds.includes(s.id))}
                                      onChange={() => {
                                        const allSel = group.sales.every((s) => selectedSaleIds.includes(s.id))
                                        if (allSel) {
                                          setSelectedSaleIds((cur) => cur.filter((id) => !group.sales.map((s) => s.id).includes(id)))
                                        } else {
                                          setSelectedSaleIds((cur) => Array.from(new Set([...cur, ...group.sales.map((s) => s.id)])))
                                        }
                                      }}
                                      className="h-4 w-4 rounded border-gray-300"
                                    />
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2">{formatDate(group.saleDate)}</td>
                                  <td className="whitespace-nowrap px-3 py-2">
                                    {group.isGrouped ? (
                                      <div className="space-y-1">
                                        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                                          🧾 Bulk Transaction
                                        </span>
                                        <button
                                          onClick={() => toggleGroupExpanded(group.key)}
                                          className="block font-medium text-blue-700 hover:underline"
                                        >
                                          {bookingGroupFriendlyLabel(group.bookingGroupId, sales, knownGroupIds)} ·{' '}
                                          {isExpanded ? 'Hide' : 'Show'} {group.itemCount} items
                                        </button>
                                      </div>
                                    ) : (
                                      firstSale.inventory_items?.item_name ?? '-'
                                    )}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2">{getBatchSummary(group.sales)}</td>
                                  <td className="whitespace-nowrap px-3 py-2">
                                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FULFILLMENT_BADGE_CLASSES[group.sales[0].fulfillment_status ?? 'parking']}`}>
                                      {FULFILLMENT_LABELS[group.sales[0].fulfillment_status ?? 'parking']}
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2">{group.buyerName}</td>
                                  <td className="whitespace-nowrap px-3 py-2">{formatIDR(group.totalRevenue)}</td>
                                  <td className="whitespace-nowrap px-3 py-2">{formatIDR(group.totalModal)}</td>
                                  <td className="whitespace-nowrap px-3 py-2">{formatIDR(group.grossProfit)}</td>
                                  <td className="whitespace-nowrap px-3 py-2">
                                    <span className={group.netProfit < 0 ? 'text-red-600' : 'text-green-700'}>
                                      {formatIDR(group.netProfit)}
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2">
                                    {group.isGrouped ? (
                                      <button
                                        onClick={() => openGroupEditModal(group)}
                                        className="text-blue-600 hover:underline"
                                      >
                                        Edit Group
                                      </button>
                                    ) : (
                                      renderSaleActions(firstSale)
                                    )}
                                  </td>
                                </tr>
                                {group.isGrouped &&
                                  isExpanded &&
                                  group.sales.map((sale) => (
                                    <tr key={sale.id} className="bg-gray-50 text-xs">
                                      <td className="whitespace-nowrap px-3 py-2">
                                        <input
                                          type="checkbox"
                                          checked={selectedSaleIds.includes(sale.id)}
                                          onChange={() => toggleSaleSelection(sale.id)}
                                          className="h-4 w-4 rounded border-gray-300"
                                        />
                                      </td>
                                      <td className="whitespace-nowrap px-3 py-2"></td>
                                      <td className="whitespace-nowrap px-3 py-2 pl-8">
                                        {sale.inventory_items?.item_name ?? '-'}
                                      </td>
                                      <td className="whitespace-nowrap px-3 py-2">{getBatchLabel(sale)}</td>
                                      <td className="whitespace-nowrap px-3 py-2">
                                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FULFILLMENT_BADGE_CLASSES[sale.fulfillment_status ?? 'parking']}`}>
                                          {FULFILLMENT_LABELS[sale.fulfillment_status ?? 'parking']}
                                        </span>
                                      </td>
                                      <td className="whitespace-nowrap px-3 py-2">{sale.buyer_name}</td>
                                      <td className="whitespace-nowrap px-3 py-2">{formatIDR(sale.sale_price)}</td>
                                      <td className="whitespace-nowrap px-3 py-2">{formatIDR(sale.modal_price)}</td>
                                      <td className="whitespace-nowrap px-3 py-2">{formatIDR(sale.gross_profit)}</td>
                                      <td className="whitespace-nowrap px-3 py-2">
                                        <span className={sale.net_profit < 0 ? 'text-red-600' : 'text-green-700'}>
                                          {formatIDR(sale.net_profit)}
                                        </span>
                                      </td>
                                      <td className="whitespace-nowrap px-3 py-2">{renderSaleActions(sale)}</td>
                                    </tr>
                                  ))}
                              </Fragment>
                            )
                          })}
                        </>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Bulk Shipping Status Modal */}
      {showBulkShippingModal && (
        <Modal title={`Change shipping status — ${selectedSaleIds.length} sale${selectedSaleIds.length === 1 ? '' : 's'}`} onClose={() => setShowBulkShippingModal(false)}>
          <form onSubmit={handleBulkShippingStatus} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">New shipping status</label>
              <select
                value={bulkShippingStatus}
                onChange={(e) => setBulkShippingStatus(e.target.value as FulfillmentStatus)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {FULFILLMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>{FULFILLMENT_LABELS[status]}</option>
                ))}
              </select>
            </div>
            {bulkActionError && <p className="text-sm text-red-600">{bulkActionError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowBulkShippingModal(false)} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700">Cancel</button>
              <button type="submit" disabled={bulkActionSaving} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {bulkActionSaving ? 'Saving...' : 'Apply to all selected'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Bulk Undo Sale Confirm */}
      {showBulkUndoConfirm && (
        <Modal title={`Undo ${selectedSaleIds.length} sale${selectedSaleIds.length === 1 ? '' : 's'}?`} onClose={() => setShowBulkUndoConfirm(false)}>
          <div className="space-y-3">
            <p className="text-sm text-gray-700">This will revert the following sales back to Booking status and restore inventory:</p>
            <div className="max-h-40 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 p-2 text-xs space-y-1">
              {selectedSales.map((s) => (
                <div key={s.id} className="flex justify-between">
                  <span>{s.inventory_items?.item_name ?? s.id}</span>
                  <span className="text-gray-500">{s.buyer_name}</span>
                </div>
              ))}
            </div>
            {bulkActionError && <p className="text-sm text-red-600">{bulkActionError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowBulkUndoConfirm(false)} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700">Cancel</button>
              <button onClick={() => void handleBulkUndo()} disabled={bulkActionSaving} className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                {bulkActionSaving ? 'Processing...' : 'Undo all selected'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Bulk Delete Confirm */}
      {showBulkDeleteConfirm && (
        <Modal title={`Delete ${selectedSaleIds.length} sale${selectedSaleIds.length === 1 ? '' : 's'}?`} onClose={() => setShowBulkDeleteConfirm(false)}>
          <div className="space-y-3">
            <p className="text-sm text-gray-700">The following sale records will be permanently deleted and inventory will be restored to Ready:</p>
            <div className="max-h-40 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 p-2 text-xs space-y-1">
              {selectedSales.map((s) => (
                <div key={s.id} className="flex justify-between">
                  <span>{s.inventory_items?.item_name ?? s.id}</span>
                  <span className="text-gray-500">{s.buyer_name}</span>
                </div>
              ))}
            </div>
            {bulkActionError && <p className="text-sm text-red-600">{bulkActionError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowBulkDeleteConfirm(false)} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700">Cancel</button>
              <button onClick={() => void handleBulkDelete()} disabled={bulkActionSaving} className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                {bulkActionSaving ? 'Deleting...' : 'Delete all selected'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {showGroupEditModal && groupEditTarget && (
        <Modal title="Edit group sale" onClose={() => setShowGroupEditModal(false)} wide>
          <form onSubmit={handleGroupEditSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Sale date</label>
              <input
                type="date"
                value={groupEditForm.sale_date}
                onChange={(e) => setGroupEditForm({ ...groupEditForm, sale_date: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Buyer</label>
              <input
                type="text"
                value={groupEditForm.buyer_name}
                onChange={(e) => setGroupEditForm({ ...groupEditForm, buyer_name: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Shipping status</label>
              <select
                value={groupEditForm.fulfillment_status}
                onChange={(e) => setGroupEditForm({ ...groupEditForm, fulfillment_status: e.target.value as FulfillmentStatus })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {FULFILLMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {FULFILLMENT_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={groupEditForm.notes}
                onChange={(e) => setGroupEditForm({ ...groupEditForm, notes: e.target.value })}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            {groupEditError && <p className="text-sm text-red-600 sm:col-span-2">{groupEditError}</p>}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <button
                type="button"
                onClick={() => setShowGroupEditModal(false)}
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

      {showModal && (
        <Modal title={editingId ? 'Edit sale' : 'Add sale'} onClose={() => setShowModal(false)} wide>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
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
                  allowedStatuses={SELLABLE_ITEM_STATUSES}
                  onChange={(item) =>
                    setForm((current) => ({
                      ...current,
                      inventory_item_id: item?.id ?? '',
                      modal_price: item ? String(Math.round(item.modal_price)) : current.modal_price,
                    }))
                  }
                  placeholder="Search ready or booked items..."
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
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Shipping status</label>
              <select
                value={form.fulfillment_status}
                onChange={(e) => setForm({ ...form, fulfillment_status: e.target.value as FulfillmentStatus })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {FULFILLMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {FULFILLMENT_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Sale price (Rp)</label>
              <input
                type="text"
                inputMode="numeric"
                value={form.sale_price}
                onChange={(e) => setForm({ ...form, sale_price: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Modal price (Rp) <span className="text-gray-400">(auto-filled, editable)</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={form.modal_price}
                onChange={(e) => setForm({ ...form, modal_price: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Marketplace fee (Rp)</label>
              <input
                type="text"
                inputMode="numeric"
                value={form.marketplace_fee}
                onChange={(e) => setForm({ ...form, marketplace_fee: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Packing cost (Rp)</label>
              <input
                type="text"
                inputMode="numeric"
                value={form.packing_cost}
                onChange={(e) => setForm({ ...form, packing_cost: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Sale date</label>
              <input
                type="date"
                value={form.sale_date}
                onChange={(e) => setForm({ ...form, sale_date: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600 sm:col-span-2">
              <p>
                Gross profit: <span className="font-medium">{formatIDR(grossProfitPreview)}</span>
              </p>
              <p>
                Net profit:{' '}
                <span className={`font-medium ${netProfitPreview < 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {formatIDR(netProfitPreview)}
                </span>
              </p>
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
    </div>
  )
}
