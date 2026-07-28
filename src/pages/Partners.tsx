import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { formatIDR, formatDate, todayISO } from '../lib/format'
import type { InventoryItem, Partner, PartnerWithdrawal } from '../types/database'
import DataTable, { type Column } from '../components/DataTable'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'

interface SaleProfit {
  net_profit: number
}

interface PartnerSummary {
  partner: Partner
  modalContribution: number
  profitShare: number
  withdrawn: number
  remaining: number
}

const emptyPartnerForm = { name: '', email: '' }
const emptyWithdrawalForm = { partner_id: '', amount: '0', withdrawal_date: todayISO(), notes: '' }

export default function Partners() {
  const [partners, setPartners] = useState<Partner[]>([])
  const [items, setItems] = useState<InventoryItem[]>([])
  const [sales, setSales] = useState<SaleProfit[]>([])
  const [withdrawals, setWithdrawals] = useState<PartnerWithdrawal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showPartnerModal, setShowPartnerModal] = useState(false)
  const [partnerForm, setPartnerForm] = useState(emptyPartnerForm)
  const [savingPartner, setSavingPartner] = useState(false)
  const [partnerFormError, setPartnerFormError] = useState<string | null>(null)

  const [showWithdrawalModal, setShowWithdrawalModal] = useState(false)
  const [withdrawalForm, setWithdrawalForm] = useState(emptyWithdrawalForm)
  const [savingWithdrawal, setSavingWithdrawal] = useState(false)
  const [withdrawalFormError, setWithdrawalFormError] = useState<string | null>(null)

  async function loadAll() {
    setLoading(true)
    setError(null)
    const [partnersRes, itemsRes, salesRes, withdrawalsRes] = await Promise.all([
      supabase.from('partners').select('*').order('name'),
      supabase.from('inventory_items').select('*'),
      supabase.from('sales').select('net_profit'),
      supabase.from('partner_withdrawals').select('*').order('withdrawal_date', { ascending: false }),
    ])

    const firstError =
      partnersRes.error || itemsRes.error || salesRes.error || withdrawalsRes.error
    if (firstError) setError(firstError.message)

    setPartners(partnersRes.data ?? [])
    setItems(itemsRes.data ?? [])
    setSales((salesRes.data as unknown as SaleProfit[]) ?? [])
    setWithdrawals(withdrawalsRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  const summaries: PartnerSummary[] = useMemo(() => {
    const partnerCount = partners.length || 1

    const sharedModal = items.reduce((sum, i) => sum + i.modal_price, 0)
    const sharedProfit = sales.reduce((sum, s) => sum + s.net_profit, 0)

    return partners.map((partner) => {
      const withdrawn = withdrawals
        .filter((w) => w.partner_id === partner.id)
        .reduce((sum, w) => sum + w.amount, 0)

      const modalContribution = sharedModal / partnerCount
      const profitShare = sharedProfit / partnerCount

      return {
        partner,
        modalContribution,
        profitShare,
        withdrawn,
        remaining: profitShare - withdrawn,
      }
    })
  }, [partners, items, sales, withdrawals])

  async function handlePartnerSubmit(e: FormEvent) {
    e.preventDefault()
    if (!partnerForm.name.trim()) {
      setPartnerFormError('Partner name is required.')
      return
    }
    setSavingPartner(true)
    setPartnerFormError(null)
    const { error } = await supabase.from('partners').insert({
      name: partnerForm.name.trim(),
      email: partnerForm.email.trim() || null,
    })
    setSavingPartner(false)
    if (error) {
      setPartnerFormError(error.message)
      return
    }
    setShowPartnerModal(false)
    setPartnerForm(emptyPartnerForm)
    loadAll()
  }

  async function handleDeletePartner(p: Partner) {
    if (!confirm(`Delete partner "${p.name}"? This cannot be undone.`)) return
    const { error } = await supabase.from('partners').delete().eq('id', p.id)
    if (error) alert(error.message)
    else loadAll()
  }

  async function handleWithdrawalSubmit(e: FormEvent) {
    e.preventDefault()
    if (!withdrawalForm.partner_id) {
      setWithdrawalFormError('Please select a partner.')
      return
    }
    setSavingWithdrawal(true)
    setWithdrawalFormError(null)
    const { error } = await supabase.from('partner_withdrawals').insert({
      partner_id: withdrawalForm.partner_id,
      amount: Number(withdrawalForm.amount) || 0,
      withdrawal_date: withdrawalForm.withdrawal_date || todayISO(),
      notes: withdrawalForm.notes.trim() || null,
    })
    setSavingWithdrawal(false)
    if (error) {
      setWithdrawalFormError(error.message)
      return
    }
    setShowWithdrawalModal(false)
    setWithdrawalForm(emptyWithdrawalForm)
    loadAll()
  }

  async function handleDeleteWithdrawal(w: PartnerWithdrawal) {
    if (!confirm('Delete this withdrawal record?')) return
    const { error } = await supabase.from('partner_withdrawals').delete().eq('id', w.id)
    if (error) alert(error.message)
    else loadAll()
  }

  const partnerName = (id: string | null) => partners.find((p) => p.id === id)?.name ?? '-'

  const summaryColumns: Column<PartnerSummary>[] = [
    { header: 'Partner', render: (s) => s.partner.name },
    { header: 'Modal contribution', render: (s) => formatIDR(s.modalContribution) },
    { header: 'Profit share', render: (s) => formatIDR(s.profitShare) },
    { header: 'Withdrawn', render: (s) => formatIDR(s.withdrawn) },
    {
      header: 'Remaining balance',
      render: (s) => (
        <span className={s.remaining < 0 ? 'text-red-600 font-medium' : 'text-green-700 font-medium'}>
          {formatIDR(s.remaining)}
        </span>
      ),
    },
    {
      header: 'Actions',
      render: (s) => (
        <button onClick={() => handleDeletePartner(s.partner)} className="text-red-600 hover:underline">
          Delete
        </button>
      ),
    },
  ]

  const withdrawalColumns: Column<PartnerWithdrawal>[] = [
    { header: 'Date', render: (w) => formatDate(w.withdrawal_date) },
    { header: 'Partner', render: (w) => partnerName(w.partner_id) },
    { header: 'Amount', render: (w) => formatIDR(w.amount) },
    { header: 'Notes', render: (w) => w.notes ?? '-' },
    {
      header: 'Actions',
      render: (w) => (
        <button onClick={() => handleDeleteWithdrawal(w)} className="text-red-600 hover:underline">
          Delete
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Partners & Settlement</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowWithdrawalModal(true)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            + Record withdrawal
          </button>
          <button
            onClick={() => setShowPartnerModal(true)}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            + Add partner
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500">
        Inventory modal and profit share are split equally among all partners. Remaining balance = profit share − withdrawn.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-gray-500">Loading partner data...</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {summaries.map((s) => (
              <StatCard key={s.partner.id} label={s.partner.name} value={formatIDR(s.remaining)} subtext="Remaining balance" />
            ))}
          </div>

          <div>
            <h2 className="mb-2 text-lg font-medium text-gray-900">Summary</h2>
            <DataTable columns={summaryColumns} data={summaries} keyField={(s) => s.partner.id} />
          </div>

          <div>
            <h2 className="mb-2 text-lg font-medium text-gray-900">Withdrawal history</h2>
            <DataTable columns={withdrawalColumns} data={withdrawals} keyField={(w) => w.id} />
          </div>
        </>
      )}

      {showPartnerModal && (
        <Modal title="Add partner" onClose={() => setShowPartnerModal(false)}>
          <form onSubmit={handlePartnerSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Name *</label>
              <input
                required
                value={partnerForm.name}
                onChange={(e) => setPartnerForm({ ...partnerForm, name: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
              <input
                type="email"
                value={partnerForm.email}
                onChange={(e) => setPartnerForm({ ...partnerForm, email: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            {partnerFormError && <p className="text-sm text-red-600">{partnerFormError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowPartnerModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingPartner}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {savingPartner ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showWithdrawalModal && (
        <Modal title="Record withdrawal" onClose={() => setShowWithdrawalModal(false)}>
          <form onSubmit={handleWithdrawalSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Partner *</label>
              <select
                required
                value={withdrawalForm.partner_id}
                onChange={(e) => setWithdrawalForm({ ...withdrawalForm, partner_id: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Select partner...</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Amount (Rp)</label>
              <input
                type="number"
                min="0"
                value={withdrawalForm.amount}
                onChange={(e) => setWithdrawalForm({ ...withdrawalForm, amount: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Date</label>
              <input
                type="date"
                value={withdrawalForm.withdrawal_date}
                onChange={(e) => setWithdrawalForm({ ...withdrawalForm, withdrawal_date: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={withdrawalForm.notes}
                onChange={(e) => setWithdrawalForm({ ...withdrawalForm, notes: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            {withdrawalFormError && <p className="text-sm text-red-600">{withdrawalFormError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowWithdrawalModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingWithdrawal}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {savingWithdrawal ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
