import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatDate, formatIDR } from '../lib/format'
import { smartSearchRank } from '../lib/search'
import type { Booking, FulfillmentStatus, Sale } from '../types/database'
import Modal from '../components/Modal'

type BuyerBooking = Booking & { inventory_items: { item_name: string; batch_name: string | null } | null }
type BuyerSale = Sale & { inventory_items: { item_name: string } | null }

interface BuyerSummary {
  buyer: string
  bookings: BuyerBooking[]
  sales: BuyerSale[]
  bookedRevenue: number
  salesRevenue: number
  revenue: number
  netProfit: number
  lastActivity: string | null
  fulfillmentSummary: Record<FulfillmentStatus, number>
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
        supabase
          .from('bookings')
          .select('*, inventory_items(item_name, batch_name)')
          .order('created_at', { ascending: false }),
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
        bookedRevenue: 0,
        salesRevenue: 0,
        revenue: 0,
        netProfit: 0,
        lastActivity: null,
        fulfillmentSummary: { parking: 0, shipping: 0, parking_shipping: 0, delivered: 0 },
      }
      summaries.set(name, summary)
      return summary
    }

    for (const booking of bookings) {
      const summary = ensureBuyer(booking.buyer_name)
      summary.bookings.push(booking)
      if (booking.status === 'active') {
        summary.bookedRevenue += booking.deal_price
      }
      if (!summary.lastActivity || booking.created_at > summary.lastActivity) summary.lastActivity = booking.created_at
    }

    for (const sale of sales) {
      const summary = ensureBuyer(sale.buyer_name)
      summary.sales.push(sale)
      summary.salesRevenue += sale.sale_price
      summary.revenue += sale.sale_price
      summary.netProfit += sale.net_profit
      const fulfillmentStatus = (sale.fulfillment_status ?? 'parking') as FulfillmentStatus
      summary.fulfillmentSummary[fulfillmentStatus] += 1
      if (!summary.lastActivity || sale.sale_date > summary.lastActivity) summary.lastActivity = sale.sale_date
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
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Booked</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Purchased</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Revenue</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Profit</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Last Activity</th>
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
                    <td className="whitespace-nowrap px-3 py-2">{buyer.bookings.filter((booking) => booking.status === 'active').length}</td>
                    <td className="whitespace-nowrap px-3 py-2">{buyer.sales.length}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.revenue)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.netProfit)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatDate(buyer.lastActivity)}</td>
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
                <p className="text-gray-500">Booked revenue</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBuyer.bookedRevenue)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Sales revenue</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBuyer.salesRevenue)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Total revenue</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBuyer.revenue)}</p>
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="text-gray-500">Profit</p>
                <p className="font-medium text-gray-900">{formatIDR(selectedBuyer.netProfit)}</p>
              </div>
            </div>

            <section>
              <h2 className="mb-2 font-medium text-gray-900">Shipping status overview</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <div className="rounded-md bg-gray-50 p-3 text-sm">
                  <p className="text-gray-500">Parking</p>
                  <p className="font-medium text-gray-900">{selectedBuyer.fulfillmentSummary.parking} items</p>
                </div>
                <div className="rounded-md bg-gray-50 p-3 text-sm">
                  <p className="text-gray-500">Shipping</p>
                  <p className="font-medium text-gray-900">{selectedBuyer.fulfillmentSummary.shipping} items</p>
                </div>
                <div className="rounded-md bg-gray-50 p-3 text-sm">
                  <p className="text-gray-500">Parking + Shipping</p>
                  <p className="font-medium text-gray-900">{selectedBuyer.fulfillmentSummary.parking_shipping} items</p>
                </div>
                <div className="rounded-md bg-gray-50 p-3 text-sm">
                  <p className="text-gray-500">Delivered</p>
                  <p className="font-medium text-gray-900">{selectedBuyer.fulfillmentSummary.delivered} items</p>
                </div>
              </div>
            </section>

            <section>
              <h2 className="mb-2 font-medium text-gray-900">Active bookings</h2>
              {selectedBuyer.bookings.filter((booking) => booking.status === 'active').length === 0 ? (
                <p className="text-sm text-gray-400">No active bookings.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Item Name</th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Booking Date</th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Deal Price</th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Batch</th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {selectedBuyer.bookings
                        .filter((booking) => booking.status === 'active')
                        .map((booking) => (
                          <tr key={booking.id} className="hover:bg-gray-50">
                            <td className="whitespace-nowrap px-3 py-2">{booking.inventory_items?.item_name ?? '-'}</td>
                            <td className="whitespace-nowrap px-3 py-2">{formatDate(booking.created_at)}</td>
                            <td className="whitespace-nowrap px-3 py-2">{formatIDR(booking.deal_price)}</td>
                            <td className="whitespace-nowrap px-3 py-2">{booking.inventory_items?.batch_name ?? '-'}</td>
                            <td className="whitespace-nowrap px-3 py-2">{booking.status}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 font-medium text-gray-900">Purchase history</h2>
              {selectedBuyer.sales.length === 0 ? (
                <p className="text-sm text-gray-400">No purchases.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Item Name</th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Sale Date</th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Sale Price</th>
                        <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Profit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {selectedBuyer.sales.map((sale) => (
                        <tr key={sale.id} className="hover:bg-gray-50">
                          <td className="whitespace-nowrap px-3 py-2">{sale.inventory_items?.item_name ?? '-'}</td>
                          <td className="whitespace-nowrap px-3 py-2">{formatDate(sale.sale_date)}</td>
                          <td className="whitespace-nowrap px-3 py-2">{formatIDR(sale.sale_price)}</td>
                          <td className="whitespace-nowrap px-3 py-2">{formatIDR(sale.net_profit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </Modal>
      )}
    </div>
  )
}
