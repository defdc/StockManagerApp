import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatDate, formatIDR } from '../lib/format'
import { smartSearchRank } from '../lib/search'
import Modal from '../components/Modal'
import type { Booking, InventoryItem, Sale } from '../types/database'

type BatchStatus = 'No Sales' | 'In Progress' | 'Break Even' | 'Profit'

type InventoryItemWithSale = InventoryItem & {
  salePrice: number | null
  buyerName: string | null
}

type BatchSummary = {
  batchName: string
  batchModal: number
  totalItems: number
  readyCount: number
  bookedCount: number
  soldCount: number
  bookedRevenue: number
  salesRevenue: number
  totalRevenue: number
  profit: number
  recoveryPercent: number
  status: BatchStatus
  items: InventoryItemWithSale[]
}

type SaleRow = Sale & {
  inventory_items: { batch_name: string | null; item_name: string | null } | null
}

type BookingRow = Booking & {
  inventory_items: { batch_name: string | null; item_name: string | null } | null
}

const FILTERS = ['All', 'No Sales', 'In Progress', 'Break Even', 'Profit'] as const

type FilterValue = (typeof FILTERS)[number]

export default function Batches() {
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FilterValue>('All')
  const [selectedBatch, setSelectedBatch] = useState<BatchSummary | null>(null)

  useEffect(() => {
    async function loadBatches() {
      setLoading(true)
      setError(null)

      try {
        const [inventoryRes, salesRes, bookingsRes] = await Promise.all([
          supabase.from('inventory_items').select('*').order('created_at', { ascending: true }),
          supabase
            .from('sales')
            .select('*, inventory_items(batch_name, item_name)')
            .order('sale_date', { ascending: false }),
          supabase
            .from('bookings')
            .select('*, inventory_items(batch_name, item_name)')
            .order('created_at', { ascending: false }),
        ])

        if (inventoryRes.error) throw new Error(inventoryRes.error.message)
        if (salesRes.error) throw new Error(salesRes.error.message)
        if (bookingsRes.error) throw new Error(bookingsRes.error.message)

        const inventoryItems = (inventoryRes.data as InventoryItem[]) ?? []
        const sales = (salesRes.data as SaleRow[]) ?? []
        const bookings = (bookingsRes.data as BookingRow[]) ?? []

        const salesByItemId = new Map<string, SaleRow>()
        for (const sale of sales) {
          if (sale.inventory_item_id) salesByItemId.set(sale.inventory_item_id, sale)
        }

        const batchMap = new Map<string, BatchSummary>()

        function ensureBatch(batchName: string): BatchSummary {
          const existing = batchMap.get(batchName)
          if (existing) return existing

          const summary: BatchSummary = {
            batchName,
            batchModal: 0,
            totalItems: 0,
            readyCount: 0,
            bookedCount: 0,
            soldCount: 0,
            bookedRevenue: 0,
            salesRevenue: 0,
            totalRevenue: 0,
            profit: 0,
            recoveryPercent: 0,
            status: 'No Sales',
            items: [],
          }

          batchMap.set(batchName, summary)
          return summary
        }

        for (const item of inventoryItems) {
          const batchName = item.batch_name?.trim() || 'Unassigned'
          const batch = ensureBatch(batchName)

          if (batch.totalItems === 0) {
            batch.batchModal = item.batch_modal_total ?? 0
          } else if ((item.batch_modal_total ?? 0) > 0 && batch.batchModal === 0) {
            batch.batchModal = item.batch_modal_total ?? 0
          }

          batch.totalItems += 1

          const itemWithSale: InventoryItemWithSale = {
            ...item,
            salePrice: null,
            buyerName: null,
          }

          const matchingSale = salesByItemId.get(item.id)
          if (matchingSale) {
            itemWithSale.salePrice = matchingSale.sale_price
            itemWithSale.buyerName = matchingSale.buyer_name
            batch.salesRevenue += matchingSale.sale_price
          }

          if (item.status === 'ready') batch.readyCount += 1
          else if (item.status === 'booked') batch.bookedCount += 1
          else if (item.status === 'sold') batch.soldCount += 1

          batch.items.push(itemWithSale)
        }

        for (const booking of bookings) {
          if (booking.status === 'cancelled' || booking.status === 'converted_to_sale') continue
          const batchName = booking.inventory_items?.batch_name?.trim() || 'Unassigned'
          const batch = ensureBatch(batchName)
          batch.bookedRevenue += booking.deal_price
        }

        for (const batch of batchMap.values()) {
          batch.totalRevenue = batch.bookedRevenue + batch.salesRevenue
          batch.profit = batch.totalRevenue - batch.batchModal
          batch.recoveryPercent = batch.batchModal > 0 ? (batch.totalRevenue / batch.batchModal) * 100 : 0

          if (batch.totalRevenue === 0) batch.status = 'No Sales'
          else if (batch.totalRevenue > 0 && batch.batchModal > 0 && batch.totalRevenue < batch.batchModal) batch.status = 'In Progress'
          else if (batch.batchModal > 0 && batch.totalRevenue === batch.batchModal) batch.status = 'Break Even'
          else batch.status = 'Profit'
        }

        setBatches(Array.from(batchMap.values()).sort((a, b) => a.batchName.localeCompare(b.batchName)))
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load batches.')
      } finally {
        setLoading(false)
      }
    }

    loadBatches()
  }, [])

  const filteredBatches = useMemo(() => {
    return batches
      .map((batch) => ({
        batch,
        rank: smartSearchRank(search, [
          { value: batch.batchName },
          { value: batch.items.map((item) => item.item_name).join(' ') },
          { value: String(batch.batchModal) },
        ]),
      }))
      .filter(({ batch, rank }) => {
        const matchesStatus = statusFilter === 'All' || batch.status === statusFilter
        const matchesSearch = rank !== null
        return matchesStatus && matchesSearch
      })
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.batch.batchName.localeCompare(b.batch.batchName))
      .map(({ batch }) => batch)
  }, [batches, search, statusFilter])

  const batchStatusClasses: Record<BatchStatus, string> = {
    'No Sales': 'bg-gray-100 text-gray-700',
    'In Progress': 'bg-yellow-100 text-yellow-800',
    'Break Even': 'bg-green-100 text-green-800',
    Profit: 'bg-green-100 text-green-800',
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Batches</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search batch, item, or batch modal..."
          className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as FilterValue)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          {FILTERS.map((filter) => (
            <option key={filter} value={filter}>
              {filter}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-gray-500">Loading batches...</p>
      ) : (
        <>
          {/* Mobile / Tablet List View (< 768px) */}
          <div className="space-y-2.5 md:hidden">
            {filteredBatches.length === 0 ? (
              <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
                No batches found.
              </div>
            ) : (
              filteredBatches.map((batch) => {
                const barWidth = `${Math.min(100, Math.round(batch.recoveryPercent))}%`
                return (
                  <button
                    key={batch.batchName}
                    type="button"
                    onClick={() => setSelectedBatch(batch)}
                    className="block w-full min-h-[52px] rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm hover:border-gray-300 hover:bg-gray-50 focus:outline-none transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-semibold text-gray-900 text-sm truncate">{batch.batchName}</span>
                      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${batchStatusClasses[batch.status]}`}>
                        {batch.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-gray-500">Recovery: <strong className="font-medium text-gray-800">{Math.round(batch.recoveryPercent)}%</strong></span>
                      <div className="w-28 sm:w-36 h-2 rounded-full bg-gray-200">
                        <div className="h-2 rounded-full bg-gray-700" style={{ width: barWidth }} />
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>

          {/* Desktop Table View (≥ 768px) */}
          <div className="hidden md:block overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Batch Name</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Batch Modal</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Booked Revenue</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Sales Revenue</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Total Revenue</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Recovery Profit</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Recovery / Item</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Recovery %</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Total Items</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Ready</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Booked</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Sold</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredBatches.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="px-3 py-6 text-center text-gray-400">
                      No batches found.
                    </td>
                  </tr>
                ) : (
                  filteredBatches.map((batch) => {
                    const barWidth = `${Math.min(100, Math.round(batch.recoveryPercent))}%`
                    return (
                      <tr key={batch.batchName} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-3 py-3">
                          <button
                            type="button"
                            onClick={() => setSelectedBatch(batch)}
                            className="font-medium text-blue-700 hover:underline"
                          >
                            {batch.batchName}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">{formatIDR(batch.batchModal)}</td>
                        <td className="whitespace-nowrap px-3 py-3">{formatIDR(batch.bookedRevenue)}</td>
                        <td className="whitespace-nowrap px-3 py-3">{formatIDR(batch.salesRevenue)}</td>
                        <td className="whitespace-nowrap px-3 py-3">{formatIDR(batch.totalRevenue)}</td>
                        <td className="whitespace-nowrap px-3 py-3">{formatIDR(batch.profit)}</td>
                        <td className="whitespace-nowrap px-3 py-3 font-medium">
                          {batch.readyCount > 0 ? formatIDR(Math.round(batch.profit / batch.readyCount)) : 'N/A'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">
                          <div className="min-w-[140px] space-y-1">
                            <div className="text-xs text-gray-500">{Math.round(batch.recoveryPercent)}%</div>
                            <div className="h-2 rounded-full bg-gray-200">
                              <div className="h-2 rounded-full bg-gray-700" style={{ width: barWidth }} />
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">{batch.totalItems}</td>
                        <td className="whitespace-nowrap px-3 py-3">{batch.readyCount}</td>
                        <td className="whitespace-nowrap px-3 py-3">{batch.bookedCount}</td>
                        <td className="whitespace-nowrap px-3 py-3">{batch.soldCount}</td>
                        <td className="whitespace-nowrap px-3 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${batchStatusClasses[batch.status]}`}>
                            {batch.status}
                          </span>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selectedBatch && (
        <Modal title={selectedBatch.batchName} onClose={() => setSelectedBatch(null)} wide>
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Batch Modal</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBatch.batchModal)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Booked Revenue</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBatch.bookedRevenue)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Sales Revenue</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBatch.salesRevenue)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Total Revenue</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBatch.totalRevenue)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Recovery Profit</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBatch.profit)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Recovery / Item</p>
                <p className="font-medium text-gray-900">
                  {selectedBatch.readyCount > 0
                    ? formatIDR(Math.round(selectedBatch.profit / selectedBatch.readyCount))
                    : 'N/A'}
                </p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Recovery %</p>
                <p className="font-medium text-gray-900">{Math.round(selectedBatch.recoveryPercent)}%</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Total Items</p>
                <p className="font-medium text-gray-900">{selectedBatch.totalItems}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Ready</p>
                <p className="font-medium text-gray-900">{selectedBatch.readyCount}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Booked</p>
                <p className="font-medium text-gray-900">{selectedBatch.bookedCount}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Sold</p>
                <p className="font-medium text-gray-900">{selectedBatch.soldCount}</p>
              </div>
            </div>

            <section>
              <h2 className="mb-2 font-medium text-gray-900">Items in batch</h2>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Item Name</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Status</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Modal/item</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Sold Price</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Buyer</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Created Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {selectedBatch.items.map((item) => (
                      <tr key={item.id} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-3 py-2">{item.item_name}</td>
                        <td className="whitespace-nowrap px-3 py-2">{item.status}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {selectedBatch.totalItems > 0
                            ? formatIDR(Math.floor(selectedBatch.batchModal / selectedBatch.totalItems))
                            : '-'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{formatIDR(item.salePrice ?? 0)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{item.buyerName ?? '-'}</td>
                        <td className="whitespace-nowrap px-3 py-2">{formatDate(item.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </Modal>
      )}
    </div>
  )
}
