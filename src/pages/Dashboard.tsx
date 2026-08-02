import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatIDR, formatDate } from '../lib/format'
import StatCard from '../components/StatCard'
import type { FulfillmentStatus, InventoryItem, Sale } from '../types/database'
import { fetchAllRows } from '../lib/supabasePagination'
import { getLiveModalPrice } from '../lib/inventoryModal'
import {
  calculatePeriodSummary,
  getMonthBounds,
  getWeekBounds,
  type ExpenseSummaryInput,
  type PeriodSummary,
  type SaleSummaryInput,
} from '../lib/salesSummary'

type InventoryAggregate = Pick<InventoryItem, 'id' | 'status' | 'quantity' | 'modal_price' | 'batch_name' | 'batch_modal_total'>
type SaleWithItem = Sale & { inventory_items: { item_name: string } | null }

function getBatchName(inventoryItems: unknown): string {
  if (!inventoryItems) return 'Unassigned'
  if (Array.isArray(inventoryItems)) {
    return (inventoryItems[0] as { batch_name?: string | null } | undefined)?.batch_name?.trim() || 'Unassigned'
  }
  return (inventoryItems as { batch_name?: string | null }).batch_name?.trim() || 'Unassigned'
}

interface DashboardData {
  totalItems: number
  readyQty: number
  bookedQty: number
  soldQty: number
  modalValue: number
  readyInventoryValue: number
  bookedInventoryValue: number
  soldThisMonth: number
  topBuyer: string
  highestProfitBatch: string
  revenue: number
  grossProfit: number
  netProfit: number
  totalRecoveryProfit: number
  weekRecoveryProfit: number
  monthRecoveryProfit: number
  recentSales: SaleWithItem[]
  lowStockItems: InventoryItem[]
  topProfitSales: SaleWithItem[]
  batchSummary: {
    totalBatches: number
    profitableBatches: number
    inProgressBatches: number
    noSalesBatches: number
  }
  fulfillmentSummary: Record<FulfillmentStatus, number>
  weekSummary: PeriodSummary
  monthSummary: PeriodSummary
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lowStockThreshold, setLowStockThreshold] = useState(2)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)

      try {
        const [itemCountRes, items, sales, expenses, recentSalesRes, lowStockRes, topProfitRes, activeBookings] =
          await Promise.all([
            supabase.from('inventory_items').select('id', { count: 'exact', head: true }),
            fetchAllRows<InventoryAggregate>((from, to) =>
              supabase
                .from('inventory_items')
                .select('id, status, quantity, modal_price, batch_name, batch_modal_total')
                .order('id')
                .range(from, to)
            ),
            fetchAllRows<SaleSummaryInput>((from, to) =>
              supabase
                .from('sales')
                .select('id, buyer_name, sale_price, gross_profit, net_profit, sale_date, fulfillment_status, inventory_items(batch_name)')
                .order('id')
                .range(from, to) as unknown as PromiseLike<{ data: SaleSummaryInput[] | null; error: { message: string } | null }>
            ),
            fetchAllRows<ExpenseSummaryInput>((from, to) =>
              supabase.from('expenses').select('id, amount, expense_date').order('id').range(from, to)
            ),
            supabase
              .from('sales')
              .select('*, inventory_items(item_name)')
              .order('created_at', { ascending: false })
              .limit(5),
            supabase
              .from('inventory_items')
              .select('*')
              .eq('status', 'ready')
              .lte('quantity', lowStockThreshold)
              .order('created_at', { ascending: true })
              .limit(8),
            supabase
              .from('sales')
              .select('*, inventory_items(item_name)')
              .order('net_profit', { ascending: false })
              .limit(5),
            fetchAllRows<{ deal_price: number; inventory_items: { batch_name: string | null } | null }>((from, to) =>
              supabase
                .from('bookings')
                .select('deal_price, inventory_items(batch_name)')
                .eq('status', 'active')
                .range(from, to) as unknown as PromiseLike<{ data: { deal_price: number; inventory_items: { batch_name: string | null } | null }[] | null; error: { message: string } | null }>
            ),
          ])

        const firstError = itemCountRes.error || recentSalesRes.error || lowStockRes.error || topProfitRes.error
        if (firstError) throw new Error(firstError.message)

        const readyQty = items.filter((i) => i.status === 'ready').length
        const bookedQty = items.filter((i) => i.status === 'booked').length
        const soldQty = items.filter((i) => i.status === 'sold').length
        const modalValue = items
          .filter((i) => i.status === 'ready' || i.status === 'booked')
          .reduce((s, i) => s + getLiveModalPrice(i, items), 0)
        const readyInventoryValue = items
          .filter((i) => i.status === 'ready')
          .reduce((s, i) => s + getLiveModalPrice(i, items), 0)
        const bookedInventoryValue = items
          .filter((i) => i.status === 'booked')
          .reduce((s, i) => s + getLiveModalPrice(i, items), 0)

        const revenue = sales.reduce((s, sale) => s + sale.sale_price, 0)
        const grossProfit = sales.reduce((s, sale) => s + sale.gross_profit, 0)
        const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0)
        const netProfit = sales.reduce((s, sale) => s + sale.net_profit, 0) - totalExpenses
        const currentMonth = new Date().toISOString().slice(0, 7)
        const soldThisMonth = sales.filter((sale) => sale.sale_date?.startsWith(currentMonth)).length
        const buyerRevenue = new Map<string, number>()
        for (const sale of sales) {
          buyerRevenue.set(sale.buyer_name, (buyerRevenue.get(sale.buyer_name) ?? 0) + sale.sale_price)
        }
        const topBuyerEntry = [...buyerRevenue.entries()].sort((a, b) => b[1] - a[1])[0]

        // Calculate Batch Recovery % (including sales and active booked revenue)
        const batchRecoveryMap = new Map<string, { batchModal: number; salesRevenue: number; bookedRevenue: number; netProfit: number }>()

        for (const item of items) {
          const batchName = item.batch_name?.trim() || 'Unassigned'
          const current = batchRecoveryMap.get(batchName) ?? { batchModal: item.batch_modal_total ?? 0, salesRevenue: 0, bookedRevenue: 0, netProfit: 0 }
          if ((item.batch_modal_total ?? 0) > 0 && current.batchModal === 0) {
            current.batchModal = item.batch_modal_total ?? 0
          }
          batchRecoveryMap.set(batchName, current)
        }

        for (const sale of sales) {
          const batchName = getBatchName(sale.inventory_items)
          const current = batchRecoveryMap.get(batchName) ?? { batchModal: 0, salesRevenue: 0, bookedRevenue: 0, netProfit: 0 }
          current.salesRevenue += sale.sale_price
          current.netProfit += sale.net_profit
          batchRecoveryMap.set(batchName, current)
        }

        for (const booking of activeBookings) {
          const batchName = getBatchName(booking.inventory_items)
          const current = batchRecoveryMap.get(batchName) ?? { batchModal: 0, salesRevenue: 0, bookedRevenue: 0, netProfit: 0 }
          current.bookedRevenue += booking.deal_price
          batchRecoveryMap.set(batchName, current)
        }

        const highestProfitBatchEntry = [...batchRecoveryMap.entries()].sort((a, b) => b[1].netProfit - a[1].netProfit)[0]

        const recoveredBatchNames = new Set<string>()
        for (const [batchName, bData] of batchRecoveryMap.entries()) {
          const totalRev = bData.salesRevenue + bData.bookedRevenue
          if (bData.batchModal > 0 && totalRev >= bData.batchModal) {
            recoveredBatchNames.add(batchName)
          }
        }

        function calculateRecoveryProfitForSales(salesList: SaleSummaryInput[]) {
          return salesList.reduce((sum, sale) => {
            const batchName = getBatchName(sale.inventory_items)
            if (recoveredBatchNames.has(batchName)) {
              return sum + sale.gross_profit
            }
            return sum
          }, 0)
        }

        const totalRecoveryProfit = calculateRecoveryProfitForSales(sales)

        const batchSummary = Array.from(batchRecoveryMap.values()).reduce(
          (summary, batch) => {
            const totalRev = batch.salesRevenue + batch.bookedRevenue
            if (totalRev === 0) summary.noSalesBatches += 1
            else if (batch.batchModal > 0 && totalRev < batch.batchModal) summary.inProgressBatches += 1
            else summary.profitableBatches += 1
            return summary
          },
          { totalBatches: batchRecoveryMap.size, profitableBatches: 0, inProgressBatches: 0, noSalesBatches: 0 }
        )
        const fulfillmentSummary = sales.reduce(
          (summary, sale) => {
            const fulfillmentStatus = (sale.fulfillment_status ?? 'parking') as FulfillmentStatus
            summary[fulfillmentStatus] += 1
            return summary
          },
          { parking: 0, shipping: 0, parking_shipping: 0, delivered: 0 }
        )

        // Calculate Period Summaries
        const weekBounds = getWeekBounds(0)
        const monthBounds = getMonthBounds(0)

        const weekSummary = calculatePeriodSummary(sales, expenses, weekBounds.start, weekBounds.end, weekBounds.label, 'week')
        const monthSummary = calculatePeriodSummary(sales, expenses, monthBounds.start, monthBounds.end, monthBounds.label, 'month')

        const weekRecoveryProfit = calculateRecoveryProfitForSales(weekSummary.sales)
        const monthRecoveryProfit = calculateRecoveryProfitForSales(monthSummary.sales)

        setData({
          totalItems: itemCountRes.count ?? 0,
          readyQty,
          bookedQty,
          soldQty,
          modalValue,
          readyInventoryValue,
          bookedInventoryValue,
          soldThisMonth,
          topBuyer: topBuyerEntry ? `${topBuyerEntry[0]} (${formatIDR(topBuyerEntry[1])})` : '-',
          highestProfitBatch: highestProfitBatchEntry
            ? `${highestProfitBatchEntry[0]} (${formatIDR(highestProfitBatchEntry[1].netProfit)})`
            : '-',
          revenue,
          grossProfit,
          netProfit,
          totalRecoveryProfit,
          weekRecoveryProfit,
          monthRecoveryProfit,
          recentSales: (recentSalesRes.data as unknown as SaleWithItem[]) ?? [],
          lowStockItems: lowStockRes.data ?? [],
          topProfitSales: (topProfitRes.data as unknown as SaleWithItem[]) ?? [],
          batchSummary,
          fulfillmentSummary,
          weekSummary,
          monthSummary,
        })
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load dashboard.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [lowStockThreshold])

  if (loading) return <p className="text-gray-500">Loading dashboard...</p>
  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/reports')}
            className="rounded-md bg-pink-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-pink-700"
          >
            Sales Reports & Reports Page →
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Low stock threshold
            <input
              type="number"
              min="0"
              value={lowStockThreshold}
              onChange={(event) => setLowStockThreshold(Number(event.target.value) || 0)}
              className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
          </label>
        </div>
      </div>

      {/* Current Week & Current Month Performance Widgets */}
      <div className="rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50/50 to-indigo-50/50 p-4 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Current Sales Summary Widgets</h2>
          <button
            type="button"
            onClick={() => navigate('/reports')}
            className="text-xs font-semibold text-blue-700 hover:underline"
          >
            View Historical Reports & Period Navigator →
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Current Week Widget */}
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-gray-100 pb-2">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                  Current Week
                </span>
                <p className="mt-1 text-sm font-semibold text-gray-900">{data.weekSummary.label}</p>
              </div>
              <span className="text-xs text-gray-500">{data.weekSummary.itemsSold} items sold</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">Revenue</p>
                <p className="font-semibold text-gray-900">{formatIDR(data.weekSummary.revenue)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Gross Profit</p>
                <p className="font-semibold text-gray-900">{formatIDR(data.weekSummary.grossProfit)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Expenses</p>
                <p className="font-semibold text-gray-900">{formatIDR(data.weekSummary.expenses)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Recovery Profit</p>
                <p className="font-semibold text-green-700">{formatIDR(data.weekRecoveryProfit)}</p>
                <p className="text-[10px] text-gray-400 mt-0.5 leading-tight" title="Profit from sales in batches that have fully recovered their modal">
                  Profit from sales in batches that have fully recovered their modal
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-500">Top Buyer: <span className="font-medium text-gray-800">{data.weekSummary.topBuyer}</span></p>
          </div>

          {/* Current Month Widget */}
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-gray-100 pb-2">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-purple-700 bg-purple-50 px-2 py-0.5 rounded">
                  Current Month
                </span>
                <p className="mt-1 text-sm font-semibold text-gray-900">{data.monthSummary.label}</p>
              </div>
              <span className="text-xs text-gray-500">{data.monthSummary.itemsSold} items sold</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">Revenue</p>
                <p className="font-semibold text-gray-900">{formatIDR(data.monthSummary.revenue)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Gross Profit</p>
                <p className="font-semibold text-gray-900">{formatIDR(data.monthSummary.grossProfit)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Expenses</p>
                <p className="font-semibold text-gray-900">{formatIDR(data.monthSummary.expenses)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Recovery Profit</p>
                <p className="font-semibold text-green-700">{formatIDR(data.monthRecoveryProfit)}</p>
                <p className="text-[10px] text-gray-400 mt-0.5 leading-tight" title="Profit from sales in batches that have fully recovered their modal">
                  Profit from sales in batches that have fully recovered their modal
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-500">Top Buyer: <span className="font-medium text-gray-800">{data.monthSummary.topBuyer}</span></p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total inventory items" value={String(data.totalItems)} />
        <StatCard label="Total ready stock" value={String(data.readyQty)} subtext="pcs" />
        <StatCard label="Total booked stock" value={String(data.bookedQty)} subtext="pcs" />
        <StatCard label="Total sold stock" value={String(data.soldQty)} subtext="pcs" />
        <StatCard label="Total modal value" value={formatIDR(data.modalValue)} subtext="ready + booked stock" />
        <StatCard label="Total revenue" value={formatIDR(data.revenue)} />
        <StatCard label="Total gross profit" value={formatIDR(data.grossProfit)} />
        <StatCard
          label="Total Recovery Profit"
          value={formatIDR(data.totalRecoveryProfit)}
          subtext="Profit from sales in batches that have fully recovered their modal"
        />
        <StatCard label="Ready Inventory Value" value={formatIDR(data.readyInventoryValue)} />
        <StatCard label="Booked Inventory Value" value={formatIDR(data.bookedInventoryValue)} />
        <StatCard label="Sold This Month" value={String(data.soldThisMonth)} subtext="sales" />
        <StatCard label="Top Buyer" value={data.topBuyer} />
        <button type="button" onClick={() => navigate('/batches')} className="text-left">
          <StatCard
            label="Batch Summary"
            value={`${data.batchSummary.totalBatches} batches`}
            subtext={`${data.batchSummary.profitableBatches} profitable · ${data.batchSummary.inProgressBatches} in progress · ${data.batchSummary.noSalesBatches} no sales`}
          />
        </button>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Shipping status</p>
          <p className="mt-2 text-sm text-gray-900">
            Parking: {data.fulfillmentSummary.parking} · Shipping: {data.fulfillmentSummary.shipping} · Delivered: {data.fulfillmentSummary.delivered}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Parking + Shipping: {data.fulfillmentSummary.parking_shipping}
          </p>
        </div>
        <StatCard label="Highest Profit Batch" value={data.highestProfitBatch} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 font-medium text-gray-900">Recent sales</h2>
          {data.recentSales.length === 0 ? (
            <p className="text-sm text-gray-400">No sales yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.recentSales.map((s) => (
                <li key={s.id} className="flex justify-between border-b border-gray-100 pb-2 last:border-0">
                  <div>
                    <p className="font-medium text-gray-800">{s.inventory_items?.item_name ?? '-'}</p>
                    <p className="text-xs text-gray-400">
                      {s.buyer_name} · {formatDate(s.sale_date)}
                    </p>
                  </div>
                  <p className="font-medium text-gray-800">{formatIDR(s.sale_price)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 font-medium text-gray-900">Low stock / unsold items</h2>
          {data.lowStockItems.length === 0 ? (
            <p className="text-sm text-gray-400">No ready stock at or below {lowStockThreshold} pcs.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.lowStockItems.map((i) => (
                <li key={i.id} className="flex justify-between border-b border-gray-100 pb-2 last:border-0">
                  <div>
                    <p className="font-medium text-gray-800">{i.item_name}</p>
                    <p className="text-xs text-gray-400">Since {formatDate(i.created_at)}</p>
                  </div>
                  <p className="text-gray-600">{i.quantity} pcs</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 font-medium text-gray-900">Top profit items</h2>
          {data.topProfitSales.length === 0 ? (
            <p className="text-sm text-gray-400">No sales yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.topProfitSales.map((s) => (
                <li key={s.id} className="flex justify-between border-b border-gray-100 pb-2 last:border-0">
                  <p className="font-medium text-gray-800">{s.inventory_items?.item_name ?? '-'}</p>
                  <p className="font-medium text-green-700">{formatIDR(s.net_profit)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
