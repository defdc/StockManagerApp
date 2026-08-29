import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/supabasePagination'
import { formatDate, formatIDR } from '../lib/format'
import { smartSearchRank } from '../lib/search'
import type { Booking, FulfillmentStatus, Sale } from '../types/database'
import Modal from '../components/Modal'
import { useToast } from '../lib/toast'

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

export function generateInvoiceText(buyerName: string, activeBookings: BuyerBooking[], includeItemList: boolean): string {
  const qty = activeBookings.length
  const totalItemPrice = activeBookings.reduce((sum, b) => sum + b.deal_price, 0)
  const formattedTotal = formatIDR(totalItemPrice)

  let itemListSection = ''
  if (includeItemList && activeBookings.length > 0) {
    const itemsText = activeBookings
      .map((b) => `- ${b.inventory_items?.item_name ?? 'Item'}: ${formatIDR(b.deal_price)}`)
      .join('\n')
    itemListSection = itemsText + '\n'
  }

  return `*INVOICE - BUYER ${buyerName.toUpperCase()}* 🦄
*🛒 PESANAN*
${itemListSection}- Total item (${qty} pcs): ${formattedTotal}
- Packing: Rp. 3k
- Ongkir: Rp. 
- TOTAL:

(Acuan Ongkir: Jabodetabek start 9k | Luar Jabodetabek start 15k | Luar Pulau start 20k-50k)

💳 PEMBAYARAN (a.n Benedictus Jody Setiawan)
- BCA: 6041522337
- DANA: 08161928280

*⚠️ KETENTUAN WAJIB*
1. Bayar maksimal buyer baru *1x10 menit* (Lewat dari itu = *B&R/Cancel*). Diproses setelah payment.
2. *Wajib* sertakan video unboxing utuh jika ada klaim retur.
3. *Wajib* isi format order dengan *Lengkap* (terutama No. HP/WA aktif).`
}

export default function Buyers() {
  const { showToast } = useToast()
  const [bookings, setBookings] = useState<BuyerBooking[]>([])
  const [sales, setSales] = useState<BuyerSale[]>([])
  const [search, setSearch] = useState('')
  const [selectedBuyer, setSelectedBuyer] = useState<BuyerSummary | null>(null)
  const [invoiceBuyer, setInvoiceBuyer] = useState<BuyerSummary | null>(null)
  const [includeItemList, setIncludeItemList] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadBuyers() {
      setLoading(true)
      setError(null)
      try {
        const [bookingsData, salesData] = await Promise.all([
          fetchAllRows<BuyerBooking>((from, to) =>
            supabase
              .from('bookings')
              .select('*, inventory_items(item_name, batch_name)')
              .order('created_at', { ascending: false })
              .range(from, to) as unknown as PromiseLike<{ data: BuyerBooking[] | null; error: { message: string } | null }>
          ),
          fetchAllRows<BuyerSale>((from, to) =>
            supabase
              .from('sales')
              .select('*, inventory_items(item_name)')
              .order('sale_date', { ascending: false })
              .range(from, to) as unknown as PromiseLike<{ data: BuyerSale[] | null; error: { message: string } | null }>
          ),
        ])

        setBookings(bookingsData ?? [])
        setSales(salesData ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load buyers.')
      } finally {
        setLoading(false)
      }
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

  function handleCopyInvoice(buyer: BuyerSummary) {
    const activeBookings = buyer.bookings.filter((b) => b.status === 'active')
    if (activeBookings.length === 0) return
    setInvoiceBuyer(buyer)
    setIncludeItemList(false)
  }

  async function executeCopy() {
    if (!invoiceBuyer) return
    const activeBookings = invoiceBuyer.bookings.filter((b) => b.status === 'active')
    const text = generateInvoiceText(invoiceBuyer.buyer, activeBookings, includeItemList)
    await navigator.clipboard.writeText(text)
    showToast('Invoice copied to clipboard!')
    setInvoiceBuyer(null)
  }

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
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {buyerSummaries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                    No buyers found.
                  </td>
                </tr>
              ) : (
                buyerSummaries.map((buyer) => {
                  const activeBookingsCount = buyer.bookings.filter((booking) => booking.status === 'active').length
                  return (
                    <tr key={buyer.buyer} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-3 py-2">
                        <button onClick={() => setSelectedBuyer(buyer)} className="font-medium text-blue-700 hover:underline">
                          {buyer.buyer}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{activeBookingsCount}</td>
                      <td className="whitespace-nowrap px-3 py-2">{buyer.sales.length}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.revenue)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.netProfit)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatDate(buyer.lastActivity)}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleCopyInvoice(buyer)}
                          disabled={activeBookingsCount === 0}
                          title={activeBookingsCount === 0 ? 'No active bookings to invoice' : 'Generate & copy invoice'}
                          className="rounded-md bg-purple-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-800 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Copy Invoice
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Invoice Preview Modal */}
      {invoiceBuyer && (
        <Modal title={`Invoice - ${invoiceBuyer.buyer}`} onClose={() => setInvoiceBuyer(null)}>
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={includeItemList}
                onChange={(e) => setIncludeItemList(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Include itemized list breakdown
            </label>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Invoice Preview:</label>
              <textarea
                readOnly
                rows={14}
                value={generateInvoiceText(
                  invoiceBuyer.buyer,
                  invoiceBuyer.bookings.filter((b) => b.status === 'active'),
                  includeItemList
                )}
                className="w-full rounded-md border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-800 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setInvoiceBuyer(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void executeCopy()}
                className="rounded-md bg-purple-700 px-4 py-2 text-sm font-medium text-white hover:bg-purple-800"
              >
                Copy to Clipboard
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Buyer Detail Modal */}
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

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="font-medium text-gray-900">Active bookings</h2>
                {selectedBuyer.bookings.filter((booking) => booking.status === 'active').length > 0 && (
                  <button
                    type="button"
                    onClick={() => handleCopyInvoice(selectedBuyer)}
                    className="rounded-md bg-purple-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-800"
                  >
                    Copy Invoice
                  </button>
                )}
              </div>
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
