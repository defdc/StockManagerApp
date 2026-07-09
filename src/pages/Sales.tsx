import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, todayISO } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { logActivity } from '../lib/activityLog'
import { bookingGroupDisplayId } from '../lib/bookingGroups'
import { smartSearchRank } from '../lib/search'
import { PLATFORMS } from '../lib/constants'
import type { Platform, Sale } from '../types/database'
import ItemCombobox from '../components/ItemCombobox'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'

type SaleRow = Sale & { inventory_items: { item_name: string } | null }

interface SaleGroup {
  key: string
  bookingGroupId: string | null
  sales: SaleRow[]
  isGrouped: boolean
  itemCount: number
  buyerName: string
  platform: Platform
  saleDate: string
  totalRevenue: number
  totalModal: number
  grossProfit: number
  netProfit: number
}

const emptyForm = {
  inventory_item_id: '',
  buyer_name: '',
  platform: 'Other' as Platform,
  sale_price: '0',
  modal_price: '0',
  marketplace_fee: '0',
  packing_cost: '0',
  shipping_subsidy: '0',
  sale_date: todayISO(),
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

  async function loadSales() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('sales')
      .select('*, inventory_items(item_name)')
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
      .filter(({ rank }) => rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.sale.sale_date.localeCompare(a.sale.sale_date))
      .map(({ sale }) => sale)
  }, [sales, search])

  const knownGroupIds = useMemo(
    () => sales.map((sale) => sale.booking_group_id).filter((id): id is string => Boolean(id)),
    [sales]
  )

  const groupedSales = useMemo(() => {
    const groups = new Map<string, SaleRow[]>()
    filtered.forEach((sale) => {
      const key = sale.booking_group_id ? `group:${sale.booking_group_id}` : `sale:${sale.id}`
      groups.set(key, [...(groups.get(key) ?? []), sale])
    })

    return Array.from(groups.entries()).map(([key, groupSales]) => {
      const firstSale = groupSales[0]
      return {
        key,
        bookingGroupId: firstSale.booking_group_id,
        sales: groupSales,
        isGrouped: Boolean(firstSale.booking_group_id) && groupSales.length > 1,
        itemCount: groupSales.length,
        buyerName: firstSale.buyer_name,
        platform: firstSale.platform,
        saleDate: firstSale.sale_date,
        totalRevenue: groupSales.reduce((sum, sale) => sum + sale.sale_price, 0),
        totalModal: groupSales.reduce((sum, sale) => sum + sale.modal_price, 0),
        grossProfit: groupSales.reduce((sum, sale) => sum + sale.gross_profit, 0),
        netProfit: groupSales.reduce((sum, sale) => sum + sale.net_profit, 0),
      } satisfies SaleGroup
    })
  }, [filtered])

  function toggleGroupExpanded(groupKey: string) {
    setExpandedGroupKeys((current) =>
      current.includes(groupKey) ? current.filter((key) => key !== groupKey) : [...current, groupKey]
    )
  }

  function openAddModal() {
    setEditingId(null)
    setForm(emptyForm)
    setFormError(null)
    setShowModal(true)
  }

  function openEditModal(s: SaleRow) {
    setEditingId(s.id)
    setEditingItemName(s.inventory_items?.item_name ?? '-')
    setForm({
      inventory_item_id: s.inventory_item_id ?? '',
      buyer_name: s.buyer_name,
      platform: s.platform,
      sale_price: String(s.sale_price),
      modal_price: String(s.modal_price),
      marketplace_fee: String(s.marketplace_fee),
      packing_cost: String(s.packing_cost),
      shipping_subsidy: String(s.shipping_subsidy),
      sale_date: s.sale_date,
      notes: s.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  const salePrice = Number(form.sale_price) || 0
  const modalPrice = Number(form.modal_price) || 0
  const marketplaceFee = Number(form.marketplace_fee) || 0
  const packingCost = Number(form.packing_cost) || 0
  const shippingSubsidy = Number(form.shipping_subsidy) || 0
  const grossProfitPreview = salePrice - modalPrice
  const netProfitPreview = grossProfitPreview - marketplaceFee - packingCost - shippingSubsidy

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
      platform: form.platform,
      sale_price: salePrice,
      modal_price: modalPrice,
      marketplace_fee: marketplaceFee,
      packing_cost: packingCost,
      shipping_subsidy: shippingSubsidy,
      gross_profit: grossProfitPreview,
      net_profit: netProfitPreview,
      sale_date: form.sale_date || todayISO(),
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
      await logActivity({
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
    await logActivity({
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

    await logActivity({
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
        platform: s.platform,
        sale_price: s.sale_price,
        modal_price: s.modal_price,
        marketplace_fee: s.marketplace_fee,
        packing_cost: s.packing_cost,
        shipping_subsidy: s.shipping_subsidy,
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

      <input
        type="text"
        placeholder="Search buyer, item, or notes..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading sales...</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Date</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Items</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Buyer</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Platform</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Revenue</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Modal</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Gross profit</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Net profit</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {groupedSales.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-gray-400">
                    No data found.
                  </td>
                </tr>
              ) : (
                groupedSales.map((group) => {
                  const firstSale = group.sales[0]
                  const isExpanded = expandedGroupKeys.includes(group.key)
                  return (
                    <Fragment key={group.key}>
                      <tr className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-3 py-2">{formatDate(group.saleDate)}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {group.isGrouped ? (
                            <button
                              onClick={() => toggleGroupExpanded(group.key)}
                              className="font-medium text-blue-700 hover:underline"
                            >
                              {bookingGroupDisplayId(group.bookingGroupId, knownGroupIds)} ·{' '}
                              {isExpanded ? 'Hide' : 'Show'} {group.itemCount} items
                            </button>
                          ) : (
                            firstSale.inventory_items?.item_name ?? '-'
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{group.buyerName}</td>
                        <td className="whitespace-nowrap px-3 py-2">{group.platform}</td>
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
                            <span className="text-gray-400">Expand to edit items</span>
                          ) : (
                            renderSaleActions(firstSale)
                          )}
                        </td>
                      </tr>
                      {group.isGrouped &&
                        isExpanded &&
                        group.sales.map((sale) => (
                          <tr key={sale.id} className="bg-gray-50 text-xs">
                            <td className="whitespace-nowrap px-3 py-2"></td>
                            <td className="whitespace-nowrap px-3 py-2 pl-8">
                              {sale.inventory_items?.item_name ?? '-'}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">{sale.buyer_name}</td>
                            <td className="whitespace-nowrap px-3 py-2">{sale.platform}</td>
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
                })
              )}
            </tbody>
          </table>
        </div>
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
                      modal_price: item ? String(item.modal_price) : current.modal_price,
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
              <label className="mb-1 block text-sm font-medium text-gray-700">Platform</label>
              <select
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}
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
              <label className="mb-1 block text-sm font-medium text-gray-700">Sale price (Rp)</label>
              <input
                type="number"
                min="0"
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
                type="number"
                min="0"
                value={form.modal_price}
                onChange={(e) => setForm({ ...form, modal_price: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Marketplace fee (Rp)</label>
              <input
                type="number"
                min="0"
                value={form.marketplace_fee}
                onChange={(e) => setForm({ ...form, marketplace_fee: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Packing cost (Rp)</label>
              <input
                type="number"
                min="0"
                value={form.packing_cost}
                onChange={(e) => setForm({ ...form, packing_cost: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Shipping subsidy (Rp)</label>
              <input
                type="number"
                min="0"
                value={form.shipping_subsidy}
                onChange={(e) => setForm({ ...form, shipping_subsidy: e.target.value })}
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
