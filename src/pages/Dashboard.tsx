import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatIDR, formatDate } from '../lib/format'
import StatCard from '../components/StatCard'
import type { InventoryItem, Sale } from '../types/database'

type SaleWithItem = Sale & { inventory_items: { item_name: string } | null }

interface DashboardData {
  totalItems: number
  readyQty: number
  bookedQty: number
  soldQty: number
  modalValue: number
  revenue: number
  grossProfit: number
  netProfit: number
  recentSales: SaleWithItem[]
  lowStockItems: InventoryItem[]
  topProfitSales: SaleWithItem[]
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)

      const [itemsRes, salesRes, expensesRes, recentSalesRes, lowStockRes, topProfitRes] =
        await Promise.all([
          supabase.from('inventory_items').select('*'),
          supabase.from('sales').select('sale_price, gross_profit, net_profit'),
          supabase.from('expenses').select('amount'),
          supabase
            .from('sales')
            .select('*, inventory_items(item_name)')
            .order('created_at', { ascending: false })
            .limit(5),
          supabase
            .from('inventory_items')
            .select('*')
            .eq('status', 'ready')
            .order('created_at', { ascending: true })
            .limit(8),
          supabase
            .from('sales')
            .select('*, inventory_items(item_name)')
            .order('net_profit', { ascending: false })
            .limit(5),
        ])

      const firstError =
        itemsRes.error ||
        salesRes.error ||
        expensesRes.error ||
        recentSalesRes.error ||
        lowStockRes.error ||
        topProfitRes.error
      if (firstError) {
        setError(firstError.message)
        setLoading(false)
        return
      }

      const items = itemsRes.data ?? []
      const sales = salesRes.data ?? []
      const expenses = expensesRes.data ?? []

      const readyQty = items.filter((i) => i.status === 'ready').reduce((s, i) => s + i.quantity, 0)
      const bookedQty = items.filter((i) => i.status === 'booked').reduce((s, i) => s + i.quantity, 0)
      const soldQty = items.filter((i) => i.status === 'sold').reduce((s, i) => s + i.quantity, 0)
      const modalValue = items
        .filter((i) => i.status === 'ready' || i.status === 'booked')
        .reduce((s, i) => s + i.modal_price * i.quantity, 0)

      const revenue = sales.reduce((s, sale) => s + sale.sale_price, 0)
      const grossProfit = sales.reduce((s, sale) => s + sale.gross_profit, 0)
      const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0)
      const netProfit = sales.reduce((s, sale) => s + sale.net_profit, 0) - totalExpenses

      setData({
        totalItems: items.length,
        readyQty,
        bookedQty,
        soldQty,
        modalValue,
        revenue,
        grossProfit,
        netProfit,
        recentSales: (recentSalesRes.data as unknown as SaleWithItem[]) ?? [],
        lowStockItems: lowStockRes.data ?? [],
        topProfitSales: (topProfitRes.data as unknown as SaleWithItem[]) ?? [],
      })
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <p className="text-gray-500">Loading dashboard...</p>
  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return null

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total inventory items" value={String(data.totalItems)} />
        <StatCard label="Total ready stock" value={String(data.readyQty)} subtext="pcs" />
        <StatCard label="Total booked stock" value={String(data.bookedQty)} subtext="pcs" />
        <StatCard label="Total sold stock" value={String(data.soldQty)} subtext="pcs" />
        <StatCard label="Total modal value" value={formatIDR(data.modalValue)} subtext="ready + booked stock" />
        <StatCard label="Total revenue" value={formatIDR(data.revenue)} />
        <StatCard label="Total gross profit" value={formatIDR(data.grossProfit)} />
        <StatCard label="Total net profit" value={formatIDR(data.netProfit)} subtext="after general expenses" />
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
            <p className="text-sm text-gray-400">No ready stock.</p>
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
