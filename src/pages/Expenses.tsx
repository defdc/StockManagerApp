import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { formatIDR, formatDate, todayISO } from '../lib/format'
import { EXPENSE_TYPES } from '../lib/constants'
import type { Expense, ExpenseType } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import Modal from '../components/Modal'
import FormattedPriceInput from '../components/FormattedPriceInput'

const emptyForm = {
  expense_date: todayISO(),
  type: 'other' as ExpenseType,
  amount: '0',
  notes: '',
}

export default function Expenses() {
  const { user, canWrite } = useAuth()
  const { showToast } = useToast()
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [deletingExpense, setDeletingExpense] = useState<Expense | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function loadExpenses() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .order('expense_date', { ascending: false })
    if (error) setError(error.message)
    else setExpenses(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadExpenses()
  }, [])

  function openAddModal() {
    setEditingId(null)
    setForm(emptyForm)
    setFormError(null)
    setShowModal(true)
  }

  function openEditModal(e: Expense) {
    setEditingId(e.id)
    setForm({
      expense_date: e.expense_date,
      type: e.type,
      amount: String(e.amount),
      notes: e.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)

    const payload = {
      expense_date: form.expense_date || todayISO(),
      type: form.type,
      amount: Number(form.amount) || 0,
      notes: form.notes.trim() || null,
    }

    let error
    if (editingId) {
      ;({ error } = await supabase.from('expenses').update(payload).eq('id', editingId))
    } else {
      ;({ error } = await supabase.from('expenses').insert({ ...payload, created_by: user?.id }))
    }

    setSaving(false)
    if (error) {
      setFormError(error.message)
      return
    }
    setShowModal(false)
    loadExpenses()
  }

  function handleDelete(e: Expense) {
    setDeletingExpense(e)
  }

  async function confirmDeleteExpense() {
    if (!deletingExpense) return
    const e = deletingExpense
    const { error } = await supabase.from('expenses').delete().eq('id', e.id)
    if (error) {
      showToast(error.message, 'error')
      setDeletingExpense(null)
    } else {
      setDeletingExpense(null)
      showToast('Expense deleted.')
      loadExpenses()
    }
  }

  const baseColumns: Column<Expense>[] = [
    { header: 'Date', render: (e) => formatDate(e.expense_date) },
    { header: 'Type', render: (e) => e.type },
    { header: 'Amount', render: (e) => formatIDR(e.amount) },
    { header: 'Notes', render: (e) => e.notes ?? '-' },
  ]

  const columns: Column<Expense>[] = canWrite
    ? [
        ...baseColumns,
        {
          header: 'Actions',
          render: (e) => (
            <div className="flex gap-2">
              <button onClick={() => openEditModal(e)} className="text-blue-600 hover:underline">
                Edit
              </button>
              <button onClick={() => handleDelete(e)} className="text-red-600 hover:underline">
                Delete
              </button>
            </div>
          ),
        },
      ]
    : baseColumns

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Expenses</h1>
        {canWrite && (
          <button
            onClick={openAddModal}
            className="rounded-md bg-pink-600 px-3 py-2 text-sm font-medium text-white hover:bg-pink-700"
          >
            + Add expense
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading expenses...</p>
      ) : (
        <DataTable columns={columns} data={expenses} keyField={(e) => e.id} />
      )}

      {showModal && (
        <Modal title={editingId ? 'Edit expense' : 'Add expense'} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Date</label>
              <input
                type="date"
                value={form.expense_date}
                onChange={(e) => setForm({ ...form, expense_date: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ExpenseType })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {EXPENSE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Amount *</label>
              <FormattedPriceInput
                required
                value={form.amount}
                onChange={(price) => setForm({ ...form, amount: price })}
              />
            </div>
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
                className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deletingExpense && (
        <Modal title="Delete expense?" onClose={() => setDeletingExpense(null)}>
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              Are you sure you want to delete this expense record ({formatIDR(deletingExpense.amount)})? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeletingExpense(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteExpense()}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
