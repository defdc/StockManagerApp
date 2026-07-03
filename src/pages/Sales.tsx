import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, todayISO } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { PLATFORMS } from '../lib/constants'
import type { InventoryItem, Platform, Sale } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import Modal from '../components/Modal'

type SaleRow = Sale & { inventory_items: { item_name: string } | null }

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

export default function Sales() {
  const { user } = useAuth()
  const [sales, setSales] = useState<SaleRow[]>([])
  const [availableItems, setAvailableItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingItemName, setEditingItemName] = useState<string>('')
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

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

  async function loadAvailableItems() {
    const { data } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('status', 'ready')
      .order('item_name')
    setAvailableItems(data ?? [])
  }

  useEffect(() => {
    loadSales()
    loadAvailableItems()
  }, [])

  const filtered = useMemo(() => {
    return sales.filter((s) => s.buyer_name.toLowerCase().includes(search.toLowerCase()))
  }, [sales, search])

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

  function handleItemChange(itemId: string) {
    const item = availableItems.find((i) => i.id === itemId)
    setForm({
      ...form,
      inventory_item_id: itemId,
      modal_price: item ? String(item.modal_price) : form.modal_price,
    })
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
    }

    setSaving(false)
    setShowModal(false)
    loadSales()
    loadAvailableItems()
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
    loadSales()
    loadAvailableItems()
  }

  function handleExport() {
    exportToCSV(
      'sales.csv',
      sales.map((s) => ({
        item_name: s.inventory_items?.item_name ?? '',
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

  const columns: Column<SaleRow>[] = [
    { header: 'Date', render: (s) => formatDate(s.sale_date) },
    { header: 'Item', render: (s) => s.inventory_items?.item_name ?? '-' },
    { header: 'Buyer', render: (s) => s.buyer_name },
    { header: 'Platform', render: (s) => s.platform },
    { header: 'Sale price', render: (s) => formatIDR(s.sale_price) },
    { header: 'Modal', render: (s) => formatIDR(s.modal_price) },
    { header: 'Gross profit', render: (s) => formatIDR(s.gross_profit) },
    {
      header: 'Net profit',
      render: (s) => (
        <span className={s.net_profit < 0 ? 'text-red-600' : 'text-green-700'}>
          {formatIDR(s.net_profit)}
        </span>
      ),
    },
    {
      header: 'Actions',
      render: (s) => (
        <div className="flex gap-2">
          <button onClick={() => openEditModal(s)} className="text-blue-600 hover:underline">
            Edit
          </button>
          <button onClick={() => handleDelete(s)} className="text-red-600 hover:underline">
            Delete
          </button>
        </div>
      ),
    },
  ]

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
        placeholder="Search buyer name..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading sales...</p>
      ) : (
        <DataTable columns={columns} data={filtered} keyField={(s) => s.id} />
      )}

      {showModal && (
        <Modal title={editingId ? 'Edit sale' : 'Add sale'} onClose={() => setShowModal(false)} wide>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
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
                    onChange={(e) => handleItemChange(e.target.value)}
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
                    <p className="mt-1 text-xs text-gray-400">No ready items available to sell.</p>
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
