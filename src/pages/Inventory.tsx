import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatIDR, formatDate, formatStatus } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { CATEGORIES, ITEM_CONDITIONS, ITEM_STATUSES, STATUS_BADGE_CLASSES } from '../lib/constants'
import type { InventoryItem, ItemCondition, ItemStatus, Partner } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import Modal from '../components/Modal'

const emptyForm = {
  item_code: '',
  item_name: '',
  brand: '',
  category: CATEGORIES[0],
  condition: 'unknown' as ItemCondition,
  quantity: '1',
  modal_price: '0',
  target_price: '0',
  status: 'ready' as ItemStatus,
  owner: 'shared',
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
    return items.filter((item) => {
      const matchesSearch = item.item_name.toLowerCase().includes(search.toLowerCase())
      const matchesStatus = statusFilter ? item.status === statusFilter : true
      return matchesSearch && matchesStatus
    })
  }, [items, search, statusFilter])

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

  async function handleDelete(item: InventoryItem) {
    if (!confirm(`Delete "${item.item_name}"? This cannot be undone.`)) return
    const { error } = await supabase.from('inventory_items').delete().eq('id', item.id)
    if (error) alert(error.message)
    else loadItems()
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
        status: item.status,
        owner: item.owner,
        notes: item.notes,
        created_at: item.created_at,
      }))
    )
  }

  const columns: Column<InventoryItem>[] = [
    { header: 'Code', render: (i) => i.item_code ?? '-' },
    { header: 'Item name', render: (i) => i.item_name },
    { header: 'Brand', render: (i) => i.brand ?? '-' },
    { header: 'Category', render: (i) => i.category ?? '-' },
    { header: 'Condition', render: (i) => i.condition },
    { header: 'Qty', render: (i) => i.quantity },
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
          placeholder="Search item name..."
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
    </div>
  )
}
