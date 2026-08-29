import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/supabasePagination'
import { formatDate, formatIDR, todayISO } from '../lib/format'
import { smartSearchRank } from '../lib/search'
import type { Sale } from '../types/database'
import Modal from '../components/Modal'
import StatCard from '../components/StatCard'

// ─── Types ────────────────────────────────────────────────────────────────────

type TopSpenderSale = Pick<
  Sale,
  'id' | 'buyer_name' | 'sale_price' | 'net_profit' | 'modal_price' | 'sale_date' | 'booking_group_id'
> & {
  inventory_items: { item_name: string; batch_name: string | null } | null
}

interface BuyerTransaction {
  /** null means ungrouped (single-item) transaction */
  groupId: string | null
  buyerName: string
  saleDate: string
  /** All sale rows belonging to this transaction */
  rows: TopSpenderSale[]
  totalRevenue: number
  totalModal: number
  totalProfit: number
  itemCount: number
}

interface BuyerSpenderSummary {
  buyer: string
  transactions: BuyerTransaction[]
  /** SUM(sale_price) across all completed sales */
  total_spending: number
  /** Number of logical transactions (grouped = 1, each ungrouped row = 1) */
  transaction_count: number
  /** Total items purchased (one per sale row) */
  items_purchased: number
  /** total_spending / transaction_count */
  average_purchase: number
  /** Latest sale_date across all transactions */
  last_purchase_date: string | null
}

type SortKey =
  | 'total_spending'
  | 'transaction_count'
  | 'items_purchased'
  | 'average_purchase'
  | 'last_purchase_date'
type SortDir = 'asc' | 'desc'

// ─── Date helpers ─────────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function aggregateSales(sales: TopSpenderSale[]): BuyerSpenderSummary[] {
  // Step 1: Group rows into transactions.
  // Grouped: rows sharing the same buyer_name + booking_group_id → 1 transaction.
  // Ungrouped: each row with booking_group_id = null → 1 transaction per row.
  const txMap = new Map<string, BuyerTransaction>()

  for (const sale of sales) {
    const txKey = sale.booking_group_id
      ? `${sale.buyer_name}||group||${sale.booking_group_id}`
      : `${sale.buyer_name}||solo||${sale.id}`

    const existing = txMap.get(txKey)
    if (existing) {
      existing.rows.push(sale)
      existing.totalRevenue += sale.sale_price
      existing.totalModal += sale.modal_price
      existing.totalProfit += sale.net_profit
      existing.itemCount += 1
      // Use the earliest sale_date as the representative date for the group
      if (sale.sale_date < existing.saleDate) existing.saleDate = sale.sale_date
    } else {
      txMap.set(txKey, {
        groupId: sale.booking_group_id,
        buyerName: sale.buyer_name,
        saleDate: sale.sale_date,
        rows: [sale],
        totalRevenue: sale.sale_price,
        totalModal: sale.modal_price,
        totalProfit: sale.net_profit,
        itemCount: 1,
      })
    }
  }

  // Step 2: Group transactions by buyer
  const buyerMap = new Map<string, BuyerSpenderSummary>()
  for (const tx of txMap.values()) {
    const existing = buyerMap.get(tx.buyerName)
    if (existing) {
      existing.transactions.push(tx)
      existing.total_spending += tx.totalRevenue
      existing.transaction_count += 1
      existing.items_purchased += tx.itemCount
      if (
        !existing.last_purchase_date ||
        tx.saleDate > existing.last_purchase_date
      ) {
        existing.last_purchase_date = tx.saleDate
      }
    } else {
      buyerMap.set(tx.buyerName, {
        buyer: tx.buyerName,
        transactions: [tx],
        total_spending: tx.totalRevenue,
        transaction_count: 1,
        items_purchased: tx.itemCount,
        average_purchase: 0,
        last_purchase_date: tx.saleDate,
      })
    }
  }

  // Step 3: Compute averages; sort transactions within buyer chronologically desc
  return [...buyerMap.values()].map((s) => {
    s.average_purchase =
      s.transaction_count > 0
        ? Math.round(s.total_spending / s.transaction_count)
        : 0
    s.transactions.sort((a, b) => b.saleDate.localeCompare(a.saleDate))
    return s
  })
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TopSpender() {
  // Date range state (editing vs applied)
  const [fromDate, setFromDate] = useState(() => daysAgo(30))
  const [toDate, setToDate] = useState(todayISO)
  const [appliedFrom, setAppliedFrom] = useState(() => daysAgo(30))
  const [appliedTo, setAppliedTo] = useState(todayISO)
  const [dateError, setDateError] = useState<string | null>(null)

  // Data
  const [sales, setSales] = useState<TopSpenderSale[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // UI
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('total_spending')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [selectedBuyer, setSelectedBuyer] = useState<BuyerSpenderSummary | null>(null)
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set())

  // ── Fetch sales filtered by applied date range ─────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function loadSales() {
      setLoading(true)
      setFetchError(null)
      try {
        const data = await fetchAllRows<TopSpenderSale>(
          (from, to) =>
            supabase
              .from('sales')
              .select(
                'id, buyer_name, sale_price, net_profit, modal_price, sale_date, booking_group_id, inventory_items(item_name, batch_name)'
              )
              .gte('sale_date', appliedFrom)
              .lte('sale_date', appliedTo)
              .order('sale_date', { ascending: false })
              .range(from, to) as unknown as PromiseLike<{
              data: TopSpenderSale[] | null
              error: { message: string } | null
            }>
        )
        if (!cancelled) setSales(data ?? [])
      } catch (err) {
        if (!cancelled)
          setFetchError(
            err instanceof Error ? err.message : 'Failed to load sales data.'
          )
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadSales()
    return () => {
      cancelled = true
    }
  }, [appliedFrom, appliedTo])

  // ── Apply date range ───────────────────────────────────────────────────────

  function handleApply() {
    if (fromDate > toDate) {
      setDateError('Start date must be before or equal to end date.')
      return
    }
    setDateError(null)
    setAppliedFrom(fromDate)
    setAppliedTo(toDate)
  }

  // ── Aggregate sales data ───────────────────────────────────────────────────

  const allSummaries = useMemo(() => aggregateSales(sales), [sales])

  // ── Search + Sort ─────────────────────────────────────────────────────────

  const rankedSummaries = useMemo(() => {
    const filtered = allSummaries
      .map((s) => ({ s, rank: smartSearchRank(search, [{ value: s.buyer }]) }))
      .filter((entry) => entry.rank !== null)
      .map((entry) => entry.s)

    return [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'total_spending':
          cmp = a.total_spending - b.total_spending
          break
        case 'transaction_count':
          cmp = a.transaction_count - b.transaction_count
          break
        case 'items_purchased':
          cmp = a.items_purchased - b.items_purchased
          break
        case 'average_purchase':
          cmp = a.average_purchase - b.average_purchase
          break
        case 'last_purchase_date':
          cmp = (a.last_purchase_date ?? '').localeCompare(
            b.last_purchase_date ?? ''
          )
          break
      }
      return sortDir === 'desc' ? -cmp : cmp
    })
  }, [allSummaries, search, sortKey, sortDir])

  // ── Summary stats ─────────────────────────────────────────────────────────

  const totalRevenue = allSummaries.reduce((sum, s) => sum + s.total_spending, 0)
  const topSpender = allSummaries.reduce<BuyerSpenderSummary | null>(
    (top, s) => (!top || s.total_spending > top.total_spending ? s : top),
    null
  )

  // ── Sorting helpers ────────────────────────────────────────────────────────

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col)
      return <span className="ml-0.5 select-none text-gray-300">↕</span>
    return (
      <span className="ml-0.5 select-none">{sortDir === 'desc' ? '↓' : '↑'}</span>
    )
  }

  // ── Group expand toggle ────────────────────────────────────────────────────

  function toggleGroupExpand(key: string) {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Page title */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Top Spender</h1>
      </div>

      {/* Date range picker */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value)
              setDateError(null)
            }}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-pink-400 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value)
              setDateError(null)
            }}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-pink-400 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={handleApply}
          className="rounded-md bg-pink-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-pink-700"
        >
          Apply
        </button>
        {dateError && (
          <p className="w-full text-sm text-red-600">{dateError}</p>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Total Buyers"
          value={loading ? '\u2014' : String(allSummaries.length)}
        />
        <StatCard
          label="Total Revenue"
          value={loading ? '\u2014' : formatIDR(totalRevenue)}
        />
        <StatCard
          label="Top Spender"
          value={loading ? '\u2014' : (topSpender?.buyer ?? '\u2014')}
          subtext={!loading && topSpender ? formatIDR(topSpender.total_spending) : undefined}
        />
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search buyer..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />

      {/* Fetch error */}
      {fetchError && <p className="text-sm text-red-600">{fetchError}</p>}

      {/* Main content */}
      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : rankedSummaries.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-12 text-center">
          <p className="text-gray-400">
            {allSummaries.length === 0
              ? 'No sales found for this period.'
              : 'No buyers match your search.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                  Rank
                </th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                  Buyer
                </th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                  <button
                    type="button"
                    onClick={() => handleSort('transaction_count')}
                    className="flex items-center font-medium text-gray-600 hover:text-gray-900"
                  >
                    Transactions
                    <SortIcon col="transaction_count" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                  <button
                    type="button"
                    onClick={() => handleSort('items_purchased')}
                    className="flex items-center font-medium text-gray-600 hover:text-gray-900"
                  >
                    Items
                    <SortIcon col="items_purchased" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                  <button
                    type="button"
                    onClick={() => handleSort('total_spending')}
                    className="flex items-center font-medium text-gray-600 hover:text-gray-900"
                  >
                    Total Spending
                    <SortIcon col="total_spending" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                  <button
                    type="button"
                    onClick={() => handleSort('average_purchase')}
                    className="flex items-center font-medium text-gray-600 hover:text-gray-900"
                  >
                    Avg Purchase
                    <SortIcon col="average_purchase" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                  <button
                    type="button"
                    onClick={() => handleSort('last_purchase_date')}
                    className="flex items-center font-medium text-gray-600 hover:text-gray-900"
                  >
                    Last Purchase
                    <SortIcon col="last_purchase_date" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rankedSummaries.map((buyer, index) => (
                <tr key={buyer.buyer} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-2">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                        index === 0
                          ? 'bg-yellow-100 text-yellow-800'
                          : index === 1
                          ? 'bg-gray-200 text-gray-700'
                          : index === 2
                          ? 'bg-orange-100 text-orange-800'
                          : 'bg-gray-50 text-gray-500'
                      }`}
                    >
                      {index + 1}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedBuyer(buyer)
                        setExpandedGroupIds(new Set())
                      }}
                      className="font-medium text-pink-700 hover:underline"
                    >
                      {buyer.buyer}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {buyer.transaction_count}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {buyer.items_purchased}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium">
                    {formatIDR(buyer.total_spending)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatIDR(buyer.average_purchase)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatDate(buyer.last_purchase_date)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Buyer Detail Modal ──────────────────────────────────────────────── */}
      {selectedBuyer && (
        <Modal
          title={selectedBuyer.buyer}
          onClose={() => setSelectedBuyer(null)}
          wide
        >
          <div className="space-y-5">
            {/* Buyer stats grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Total Spending</p>
                <p className="font-semibold text-gray-900">
                  {formatIDR(selectedBuyer.total_spending)}
                </p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Transactions</p>
                <p className="font-semibold text-gray-900">
                  {selectedBuyer.transaction_count}
                </p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Items Purchased</p>
                <p className="font-semibold text-gray-900">
                  {selectedBuyer.items_purchased}
                </p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Average Purchase</p>
                <p className="font-semibold text-gray-900">
                  {formatIDR(selectedBuyer.average_purchase)}
                </p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Last Purchase</p>
                <p className="font-semibold text-gray-900">
                  {formatDate(selectedBuyer.last_purchase_date)}
                </p>
              </div>
            </div>

            {/* Purchase history */}
            <section>
              <h2 className="mb-1 font-medium text-gray-900">Purchase History</h2>
              <p className="mb-2 text-xs text-gray-400">
                {formatDate(appliedFrom)} \u2013 {formatDate(appliedTo)}
              </p>

              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                        Date
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                        Items
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                        Batch
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                        Revenue
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">
                        Profit
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {selectedBuyer.transactions.map((tx) => {
                      const txKey = tx.groupId ?? tx.rows[0].id
                      const isGrouped = tx.rows.length > 1
                      const isExpanded = expandedGroupIds.has(txKey)

                      return (
                        <>
                          {/* Transaction summary row */}
                          <tr
                            key={`tx-${txKey}`}
                            className={
                              isGrouped
                                ? 'cursor-pointer hover:bg-pink-50'
                                : 'hover:bg-gray-50'
                            }
                            onClick={
                              isGrouped
                                ? () => toggleGroupExpand(txKey)
                                : undefined
                            }
                          >
                            <td className="whitespace-nowrap px-3 py-2">
                              {formatDate(tx.saleDate)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              {isGrouped ? (
                                <span className="flex items-center gap-1.5">
                                  <span className="rounded-full bg-pink-100 px-1.5 py-0.5 text-xs font-medium text-pink-800">
                                    {tx.itemCount} items
                                  </span>
                                  <span className="text-xs text-gray-400">
                                    {isExpanded ? '\u25b2' : '\u25bc'}
                                  </span>
                                </span>
                              ) : (
                                tx.rows[0].inventory_items?.item_name ?? '\u2014'
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                              {isGrouped
                                ? '\u2014'
                                : (tx.rows[0].inventory_items?.batch_name ?? '\u2014')}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium">
                              {formatIDR(tx.totalRevenue)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              {formatIDR(tx.totalProfit)}
                            </td>
                          </tr>

                          {/* Expanded child rows for grouped transactions */}
                          {isGrouped &&
                            isExpanded &&
                            tx.rows.map((row) => (
                              <tr key={`row-${row.id}`} className="bg-pink-50/40">
                                <td className="whitespace-nowrap py-1.5 pl-8 pr-3 text-xs text-gray-400">
                                  {formatDate(row.sale_date)}
                                </td>
                                <td className="whitespace-nowrap py-1.5 pl-8 pr-3 text-xs text-gray-700">
                                  {row.inventory_items?.item_name ?? '\u2014'}
                                </td>
                                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-gray-400">
                                  {row.inventory_items?.batch_name ?? '\u2014'}
                                </td>
                                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-gray-700">
                                  {formatIDR(row.sale_price)}
                                </td>
                                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-gray-700">
                                  {formatIDR(row.net_profit)}
                                </td>
                              </tr>
                            ))}
                        </>
                      )
                    })}
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
