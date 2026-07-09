import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatDate, formatIDR } from '../lib/format'
import { smartSearchRank } from '../lib/search'
import type { Booking, Sale } from '../types/database'
import Modal from '../components/Modal'

type BuyerBooking = Booking & { inventory_items: { item_name: string } | null }
type BuyerSale = Sale & { inventory_items: { item_name: string } | null }

interface BuyerSummary {
  buyer: string
  bookings: BuyerBooking[]
  sales: BuyerSale[]
  revenue: number
  grossProfit: number
  netProfit: number
  lastPurchase: string | null
}

export default function Buyers() {
  const [bookings, setBookings] = useState<BuyerBooking[]>([])
  const [sales, setSales] = useState<BuyerSale[]>([])
  const [search, setSearch] = useState('')
  const [selectedBuyer, setSelectedBuyer] = useState<BuyerSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadBuyers() {
      setLoading(true)
      setError(null)
      const [bookingsRes, salesRes] = await Promise.all([
        supabase.from('bookings').select('*, inventory_items(item_name)').order('created_at', { ascending: false }),
        supabase.from('sales').select('*, inventory_items(item_name)').order('sale_date', { ascending: false }),
      ])

      const firstError = bookingsRes.error || salesRes.error
      if (firstError) setError(firstError.message)
      else {
        setBookings((bookingsRes.data as unknown as BuyerBooking[]) ?? [])
        setSales((salesRes.data as unknown as BuyerSale[]) ?? [])
      }
      setLoading(false)
    }

    loadBuyers()
  }, [])

  const buyerSummaries = useMemo(() => {
    const summaries = new Map<string, BuyerSummary>()

    function ensureBuyer(name: string): BuyerSummary {
      const existing = summaries.get(name)
      if (existing) return existing
      const summary: BuyerSummary = {
        buyer: name,
        bookings: [],
        sales: [],
        revenue: 0,
        grossProfit: 0,
        netProfit: 0,
        lastPurchase: null,
      }
      summaries.set(name, summary)
      return summary
    }

    for (const booking of bookings) {
      ensureBuyer(booking.buyer_name).bookings.push(booking)
    }

    for (const sale of sales) {
      const summary = ensureBuyer(sale.buyer_name)
      summary.sales.push(sale)
      summary.revenue += sale.sale_price
      summary.grossProfit += sale.gross_profit
      summary.netProfit += sale.net_profit
      if (!summary.lastPurchase || sale.sale_date > summary.lastPurchase) summary.lastPurchase = sale.sale_date
    }

    return [...summaries.values()]
      .map((summary) => ({
        summary,
        rank: smartSearchRank(search, [{ value: summary.buyer }]),
      }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.summary.revenue - a.summary.revenue)
      .map((entry) => entry.summary)
  }, [bookings, sales, search])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Buyers</h1>
      </div>

      <input
        type="text"
        placeholder="Search buyer..."
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading buyers...</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Buyer</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Bookings</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Purchases</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Revenue</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Profit</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Last Purchase</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {buyerSummaries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                    No buyers found.
                  </td>
                </tr>
              ) : (
                buyerSummaries.map((buyer) => (
                  <tr key={buyer.buyer} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-3 py-2">
                      <button onClick={() => setSelectedBuyer(buyer)} className="font-medium text-blue-700 hover:underline">
                        {buyer.buyer}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{buyer.bookings.length}</td>
                    <td className="whitespace-nowrap px-3 py-2">{buyer.sales.length}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.revenue)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.netProfit)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatDate(buyer.lastPurchase)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectedBuyer && (
        <Modal title={selectedBuyer.buyer} onClose={() => setSelectedBuyer(null)} wide>
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Total revenue</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBuyer.revenue)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Total gross profit</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBuyer.grossProfit)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Total net profit</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBuyer.netProfit)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Average purchase</p>
                <p className="font-medium text-gray-900">
                  {formatIDR(selectedBuyer.sales.length ? selectedBuyer.revenue / selectedBuyer.sales.length : 0)}
                </p>
              </div>
            </div>

            <section>
              <h2 className="mb-2 font-medium text-gray-900">Booking history</h2>
              {selectedBuyer.bookings.length === 0 ? (
                <p className="text-sm text-gray-400">No bookings.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {selectedBuyer.bookings.map((booking) => (
                    <li key={booking.id} className="rounded-md border border-gray-200 p-3">
                      <p className="font-medium text-gray-800">{booking.inventory_items?.item_name ?? '-'}</p>
                      <p className="text-gray-500">
                        {formatDate(booking.created_at)} · {formatIDR(booking.deal_price)} · {booking.status}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h2 className="mb-2 font-medium text-gray-900">Sales history</h2>
              {selectedBuyer.sales.length === 0 ? (
                <p className="text-sm text-gray-400">No purchases.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {selectedBuyer.sales.map((sale) => (
                    <li key={sale.id} className="rounded-md border border-gray-200 p-3">
                      <p className="font-medium text-gray-800">{sale.inventory_items?.item_name ?? '-'}</p>
                      <p className="text-gray-500">
                        {formatDate(sale.sale_date)} · {formatIDR(sale.sale_price)} · Net {formatIDR(sale.net_profit)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </Modal>
      )}
    </div>
  )
}
