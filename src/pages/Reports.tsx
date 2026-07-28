import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatIDR, formatDate } from '../lib/format'
import StatCard from '../components/StatCard'
import {
  calculatePeriodSummary,
  getMonthBounds,
  getWeekBounds,
  type ExpenseSummaryInput,
  type PeriodSummary,
  type SaleSummaryInput,
} from '../lib/salesSummary'
import { fetchAllRows } from '../lib/supabasePagination'
import { FULFILLMENT_BADGE_CLASSES, FULFILLMENT_LABELS } from '../lib/constants'

export default function Reports() {
  const [periodType, setPeriodType] = useState<'week' | 'month'>('week')
  const [offset, setOffset] = useState<number>(0)
  const [sales, setSales] = useState<SaleSummaryInput[]>([])
  const [expenses, setExpenses] = useState<ExpenseSummaryInput[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadData() {
      setLoading(true)
      setError(null)
      try {
        const [salesData, expensesData] = await Promise.all([
          fetchAllRows<SaleSummaryInput>((from, to) =>
            supabase
              .from('sales')
              .select('id, buyer_name, sale_price, gross_profit, net_profit, sale_date, fulfillment_status, inventory_items(item_name)')
              .order('sale_date', { ascending: false })
              .range(from, to) as unknown as PromiseLike<{ data: SaleSummaryInput[] | null; error: { message: string } | null }>
          ),
          fetchAllRows<ExpenseSummaryInput>((from, to) =>
            supabase.from('expenses').select('id, amount, expense_date').order('expense_date', { ascending: false }).range(from, to)
          ),
        ])
        setSales(salesData)
        setExpenses(expensesData)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load sales reports data.')
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  const bounds = useMemo(() => {
    if (periodType === 'week') return getWeekBounds(offset)
    return getMonthBounds(offset)
  }, [periodType, offset])

  const summary: PeriodSummary = useMemo(() => {
    return calculatePeriodSummary(sales, expenses, bounds.start, bounds.end, bounds.label, periodType)
  }, [sales, expenses, bounds, periodType])

  function handlePeriodTypeChange(newType: 'week' | 'month') {
    setPeriodType(newType)
    setOffset(0)
  }

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Sales Reports & Summaries</h1>
          <p className="text-xs text-gray-500">
            {periodType === 'week' ? 'Weekly breakdown (Monday – Sunday)' : 'Monthly breakdown (1st – End of Month)'}
          </p>
        </div>

        {/* View Toggle */}
        <div className="inline-flex rounded-md shadow-sm">
          <button
            type="button"
            onClick={() => handlePeriodTypeChange('week')}
            className={`rounded-l-md border px-4 py-2 text-sm font-medium ${
              periodType === 'week'
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Weekly View
          </button>
          <button
            type="button"
            onClick={() => handlePeriodTypeChange('month')}
            className={`rounded-r-md border border-l-0 px-4 py-2 text-sm font-medium ${
              periodType === 'month'
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Monthly View
          </button>
        </div>
      </div>

      {/* Period Navigator */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOffset((o) => o - 1)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            ◄ Previous {periodType === 'week' ? 'Week' : 'Month'}
          </button>
          <button
            type="button"
            onClick={() => setOffset(0)}
            disabled={offset === 0}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Current {periodType === 'week' ? 'Week' : 'Month'}
          </button>
          <button
            type="button"
            onClick={() => setOffset((o) => o + 1)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Next {periodType === 'week' ? 'Week' : 'Month'} ►
          </button>
        </div>

        <div className="text-right">
          <p className="text-base font-semibold text-gray-900">{bounds.label}</p>
          <p className="text-xs text-gray-400">
            {bounds.start} to {bounds.end}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-gray-500">Loading period report...</p>
      ) : (
        <>
          {/* Summary StatCards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Total Revenue" value={formatIDR(summary.revenue)} />
            <StatCard label="Gross Profit" value={formatIDR(summary.grossProfit)} />
            <StatCard label="Expenses" value={formatIDR(summary.expenses)} subtext="period general expenses" />
            <StatCard label="Net Profit" value={formatIDR(summary.netProfit)} subtext="after expenses" />
            <StatCard label="Items Sold" value={String(summary.itemsSold)} subtext="sales count" />
            <StatCard label="Top Buyer" value={summary.topBuyer} />
          </div>

          {/* Shipping Status Breakdown */}
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="mb-2 text-sm font-medium text-gray-700">Shipping Status Breakdown ({summary.itemsSold} sales)</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md bg-gray-50 p-2.5">
                <span className="text-xs font-medium text-gray-500">Parking</span>
                <p className="mt-0.5 text-base font-semibold text-gray-900">{summary.fulfillmentSummary.parking}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-2.5">
                <span className="text-xs font-medium text-gray-500">Shipping</span>
                <p className="mt-0.5 text-base font-semibold text-gray-900">{summary.fulfillmentSummary.shipping}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-2.5">
                <span className="text-xs font-medium text-gray-500">Parking + Shipping</span>
                <p className="mt-0.5 text-base font-semibold text-gray-900">{summary.fulfillmentSummary.parking_shipping}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-2.5">
                <span className="text-xs font-medium text-gray-500">Delivered</span>
                <p className="mt-0.5 text-base font-semibold text-gray-900">{summary.fulfillmentSummary.delivered}</p>
              </div>
            </div>
          </div>

          {/* Period Sales Table */}
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-sm font-semibold text-gray-900">
                Sales in {bounds.label} ({summary.sales.length})
              </h3>
            </div>
            {summary.sales.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-400">No sales recorded for this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Date</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Item</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Buyer</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Sale Price</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Gross Profit</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Net Profit</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {summary.sales.map((sale) => (
                      <tr key={sale.id} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-3 py-2 text-gray-500">{formatDate(sale.sale_date)}</td>
                        <td className="px-3 py-2 font-medium text-gray-900">{sale.inventory_items?.item_name ?? '-'}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-700">{sale.buyer_name}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-900">{formatIDR(sale.sale_price)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-900">{formatIDR(sale.gross_profit)}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-medium text-green-700">{formatIDR(sale.net_profit)}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FULFILLMENT_BADGE_CLASSES[sale.fulfillment_status ?? 'parking']}`}>
                            {FULFILLMENT_LABELS[sale.fulfillment_status ?? 'parking']}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
