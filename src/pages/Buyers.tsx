import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useDataInvalidation } from '../lib/dataSync'
import { formatDate, formatIDR } from '../lib/format'
import type { Booking, FulfillmentStatus, Sale } from '../types/database'
import Modal from '../components/Modal'
import { useToast } from '../lib/toast'

const PAGE_SIZE = 200
const SEARCH_DEBOUNCE_MS = 600
const BUYER_BOOKINGS_SELECT =
  'id, inventory_item_id, booking_group_id, group_total_deal_price, buyer_name, deal_price, status, created_at, inventory_items(item_name, batch_name)'
const BUYER_SALES_SELECT =
  'id, inventory_item_id, buyer_name, sale_price, net_profit, sale_date, fulfillment_status, inventory_items(item_name)'

type BuyerBooking = Booking & { inventory_items: { item_name: string; batch_name: string | null } | null }
type BuyerSale = Sale & { inventory_items: { item_name: string } | null }

interface BuyerSummaryRow {
  buyer_name: string
  booked: number
  purchased: number
  revenue: number
  profit: number
  last_activity: string | null
}

interface BuyerDetailData {
  buyer: string
  booked: number
  bookings: BuyerBooking[]
  sales: BuyerSale[]
  bookedRevenue: number
  salesRevenue: number
  revenue: number
  netProfit: number
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

  return `*INVOICE - LOYAL BUYER ${buyerName.toUpperCase()} PINKIEPIE.GARAGE* 🦄
*🛒 PESANAN*
${itemListSection}- Total item (${qty} pcs): ${formattedTotal} 
- Packing: Rp. 3.000
- Ongkir: (tergantung lokasi, estimasi di bawah)

(Acuan Ongkir: Jabodetabek start 9k | Luar Jabodetabek start 15k | Luar Pulau start 20k-50k)

💳 PEMBAYARAN (a.n Benedictus Jody Setiawan)
•⁠  ⁠BCA: 6041522337
•⁠  ⁠DANA: 08161928280

⚠️ KETENTUAN WAJIB
1  ⁠Bayar maksimal 1x24 jam (Lewat dari itu = B&R/Cancel). Diproses setelah payment.
2. Pastikan Nama, Alamat, dan No. HP sudah BENAR.
3.⁠ ⁠❌ TIDAK TERIMA KOMPLAIN untuk minus yang sudah dijelaskan saat live (crack, kerut, dll).
4. 🚚 Tidak TERIMA KOMPLAIN barang rusak akibat pihak ekspedisi(dus rusak/terbuka)saat diterima. JANGAN DIBUKA dan segera hubungi dahulu pihak ekspedisi.
5. 📦 Syarat Komplain: Wajib video unboxing utuh tanpa jeda/edit. Rekam dari sebelum paket dibuka(segel utuh, resi & semua sisi terlihat). Barang tidak boleh out of frame sampai selesai.(Tanpa video sesuai syarat = komplain tidak sah).
6.⁠   ⁠Wajib kirim bukti transfer.

Terima kasih Sudah Berbelanja di PinkiePie.Garage! ✨

Link Group: https://chat.whatsapp.com/K5NLbkHcrDt2KdBs1lJ3zq?mode=gi_t 
`
}

export default function Buyers() {
  const { showToast } = useToast()
  const [buyerSummaries, setBuyerSummaries] = useState<BuyerSummaryRow[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [page, setPage] = useState<number>(1)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showOnlyActiveBookings, setShowOnlyActiveBookings] = useState(false)
  const [invoicedBuyers, setInvoicedBuyers] = useState<Set<string>>(new Set())

  const [copyingBuyer, setCopyingBuyer] = useState<string | null>(null)
  const [invoiceBuyerName, setInvoiceBuyerName] = useState<string | null>(null)
  const [invoiceBookings, setInvoiceBookings] = useState<BuyerBooking[]>([])
  const [invoiceLoading, setInvoiceLoading] = useState(false)
  const [includeItemList, setIncludeItemList] = useState(false)
  const [invoiceText, setInvoiceText] = useState('')

  const [selectedBuyer, setSelectedBuyer] = useState<BuyerDetailData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadSeqRef = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = search.trim()
      setDebouncedSearch(trimmed.length >= 2 ? trimmed : '')
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [showOnlyActiveBookings])

  const loadBuyers = useCallback(async () => {
    const seq = ++loadSeqRef.current
    const isLatest = () => seq === loadSeqRef.current
    setLoading(true)
    setError(null)
    try {
      const from = (page - 1) * PAGE_SIZE
      const to = from + PAGE_SIZE - 1

      let query = supabase
        .from('buyer_summaries')
        .select('*', { count: 'exact' })

      if (showOnlyActiveBookings) {
        query = query.gt('booked', 0)
      }

      const trimmedSearch = debouncedSearch.trim()
      if (trimmedSearch) {
        query = query.ilike('buyer_name', `%${trimmedSearch}%`)
      }

      const { data, count, error: queryErr } = await query
        .order('booked', { ascending: false })
        .order('revenue', { ascending: false })
        .range(from, to)

      if (!isLatest()) return
      if (queryErr) throw new Error(queryErr.message)

      const rows: BuyerSummaryRow[] = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        buyer_name: String(row.buyer_name ?? ''),
        booked: Number(row.booked ?? 0),
        purchased: Number(row.purchased ?? 0),
        revenue: Number(row.revenue ?? 0),
        profit: Number(row.profit ?? 0),
        last_activity: typeof row.last_activity === 'string' ? row.last_activity : null,
      }))

      setBuyerSummaries(rows)
      setTotalCount(count ?? rows.length)
    } catch (err) {
      if (!isLatest()) return
      setError(err instanceof Error ? err.message : 'Failed to load buyers.')
    } finally {
      if (isLatest()) setLoading(false)
    }
  }, [page, debouncedSearch, showOnlyActiveBookings])

  useEffect(() => {
    void loadBuyers()
  }, [loadBuyers])

  useDataInvalidation(
    ['bookings', 'sales', 'inventory_items'],
    () => {
      void loadBuyers()
    },
    { remoteOnly: true }
  )

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const hasPrevPage = page > 1
  const hasNextPage = page < totalPages
  const pageFrom = buyerSummaries.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const pageTo = buyerSummaries.length === 0 ? 0 : Math.min(totalCount, (page - 1) * PAGE_SIZE + buyerSummaries.length)

  function toggleInvoiced(buyerId: string) {
    setInvoicedBuyers((prev) => {
      const next = new Set(prev)
      if (next.has(buyerId)) {
        next.delete(buyerId)
      } else {
        next.add(buyerId)
      }
      return next
    })
  }

  async function fetchActiveBookingsForBuyer(buyerName: string): Promise<BuyerBooking[]> {
    const { data, error: fetchErr } = await supabase
      .from('bookings')
      .select(BUYER_BOOKINGS_SELECT)
      .eq('buyer_name', buyerName)
      .eq('status', 'active')
      .order('created_at', { ascending: false })

    if (fetchErr) throw new Error(fetchErr.message)
    return (data as unknown as BuyerBooking[]) ?? []
  }

  async function handleDirectCopyInvoice(buyerName: string) {
    if (copyingBuyer) return
    setCopyingBuyer(buyerName)
    try {
      const activeBookings = await fetchActiveBookingsForBuyer(buyerName)
      if (activeBookings.length === 0) {
        showToast('No active bookings found for this buyer.', 'error')
        return
      }
      const invoiceTextToCopy = generateInvoiceText(buyerName, activeBookings, false)
      await navigator.clipboard.writeText(invoiceTextToCopy)
      showToast('Invoice copied to clipboard!')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to copy invoice.', 'error')
    } finally {
      setCopyingBuyer(null)
    }
  }

  async function handleOpenEditInvoice(buyerName: string) {
    setInvoiceBuyerName(buyerName)
    setIncludeItemList(false)
    setInvoiceBookings([])
    setInvoiceText('')
    setInvoiceLoading(true)
    try {
      const activeBookings = await fetchActiveBookingsForBuyer(buyerName)
      setInvoiceBookings(activeBookings)
      setInvoiceText(generateInvoiceText(buyerName, activeBookings, false))
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load invoice details.', 'error')
      setInvoiceBuyerName(null)
    } finally {
      setInvoiceLoading(false)
    }
  }

  function handleToggleIncludeItemList(checked: boolean) {
    setIncludeItemList(checked)
    if (invoiceBuyerName) {
      setInvoiceText(generateInvoiceText(invoiceBuyerName, invoiceBookings, checked))
    }
  }

  async function executeCopy() {
    if (!invoiceBuyerName) return
    await navigator.clipboard.writeText(invoiceText)
    showToast('Invoice copied to clipboard!')
    setInvoiceBuyerName(null)
  }

  async function handleSelectBuyer(summary: BuyerSummaryRow) {
    setDetailLoading(true)
    setSelectedBuyer({
      buyer: summary.buyer_name,
      booked: summary.booked,
      bookings: [],
      sales: [],
      bookedRevenue: 0,
      salesRevenue: summary.revenue,
      revenue: summary.revenue,
      netProfit: summary.profit,
      fulfillmentSummary: { parking: 0, shipping: 0, parking_shipping: 0, shipping_cod: 0, delivered: 0 },
    })

    try {
      const [bookingsRes, salesRes] = await Promise.all([
        supabase
          .from('bookings')
          .select(BUYER_BOOKINGS_SELECT)
          .eq('buyer_name', summary.buyer_name)
          .order('created_at', { ascending: false }),
        supabase
          .from('sales')
          .select(BUYER_SALES_SELECT)
          .eq('buyer_name', summary.buyer_name)
          .order('sale_date', { ascending: false }),
      ])

      const loadedBookings = (bookingsRes.data as unknown as BuyerBooking[]) ?? []
      const loadedSales = (salesRes.data as unknown as BuyerSale[]) ?? []

      const activeBookings = loadedBookings.filter((b) => b.status === 'active')
      const bookedRevenue = activeBookings.reduce((sum, b) => sum + b.deal_price, 0)
      const fulfillmentSummary: Record<FulfillmentStatus, number> = {
        parking: 0,
        shipping: 0,
        parking_shipping: 0,
        shipping_cod: 0,
        delivered: 0,
      }
      for (const sale of loadedSales) {
        const rawStatus = (sale.fulfillment_status ?? 'parking') as FulfillmentStatus
        fulfillmentSummary[rawStatus] = (fulfillmentSummary[rawStatus] ?? 0) + 1
      }

      setSelectedBuyer({
        buyer: summary.buyer_name,
        booked: activeBookings.length || summary.booked,
        bookings: loadedBookings,
        sales: loadedSales,
        bookedRevenue,
        salesRevenue: summary.revenue,
        revenue: summary.revenue,
        netProfit: summary.profit,
        fulfillmentSummary,
      })
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="space-y-4">

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Buyers</h1>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <input
          type="text"
          placeholder="Search buyer..."
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(1)
          }}
          className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showOnlyActiveBookings}
            onChange={(e) => {
              setShowOnlyActiveBookings(e.target.checked)
              setPage(1)
            }}
            className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500 cursor-pointer"
          />
          Show only with active bookings
        </label>
      </div>

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
                <th className="whitespace-nowrap px-3 py-2 text-center font-medium text-gray-600">Invoiced</th>
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {buyerSummaries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-400">
                    No buyers found.
                  </td>
                </tr>
              ) : (
                buyerSummaries.map((buyer) => {
                  const isChecked = invoicedBuyers.has(buyer.buyer_name) && buyer.booked > 0
                  const isDisabled = buyer.booked === 0
                  const isCopyingThis = copyingBuyer === buyer.buyer_name

                  return (
                    <tr key={buyer.buyer_name} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-3 py-2">
                        <button
                          type="button"
                          onClick={() => void handleSelectBuyer(buyer)}
                          className="font-medium text-blue-700 hover:underline"
                        >
                          {buyer.buyer_name}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{buyer.booked}</td>
                      <td className="whitespace-nowrap px-3 py-2">{buyer.purchased}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.revenue)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatIDR(buyer.profit)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatDate(buyer.last_activity)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isDisabled}
                          onChange={() => toggleInvoiced(buyer.buyer_name)}
                          title={
                            isDisabled
                              ? 'No active bookings'
                              : isChecked
                                ? 'Mark as not invoiced'
                                : 'Mark as invoiced'
                          }
                          aria-label={`Mark ${buyer.buyer_name} as invoiced`}
                          className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {buyer.booked > 0 && (
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <button
                              type="button"
                              disabled={isCopyingThis}
                              onClick={() => void handleDirectCopyInvoice(buyer.buyer_name)}
                              title="Directly copy standard invoice to clipboard"
                              className="rounded-md bg-purple-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isCopyingThis ? 'Copying...' : 'Copy Invoice'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleOpenEditInvoice(buyer.buyer_name)}
                              title="Preview & edit invoice before copying"
                              className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              Edit Invoice
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Server-Side Pagination Controls */}
      {!loading && buyerSummaries.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
          <div className="text-gray-600">
            Showing <span className="font-medium text-gray-900">{pageFrom}</span> to{' '}
            <span className="font-medium text-gray-900">{pageTo}</span> of{' '}
            <span className="font-medium text-gray-900">{totalCount}</span> records (Page{' '}
            <span className="font-medium text-gray-900">{page}</span> of{' '}
            <span className="font-medium text-gray-900">{totalPages}</span>)
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={!hasPrevPage || loading}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous Page
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNextPage || loading}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next Page
            </button>
          </div>
        </div>
      )}

      {/* Invoice Preview / Edit Modal */}
      {invoiceBuyerName && (
        <Modal title={`Invoice - ${invoiceBuyerName}`} onClose={() => setInvoiceBuyerName(null)}>
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={includeItemList}
                disabled={invoiceLoading}
                onChange={(e) => handleToggleIncludeItemList(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Include itemized list breakdown
            </label>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Invoice Preview:</label>
              {invoiceLoading ? (
                <div className="flex h-64 items-center justify-center rounded-md border border-gray-300 bg-gray-50 text-sm text-gray-500">
                  Loading invoice details...
                </div>
              ) : (
                <textarea
                  rows={14}
                  value={invoiceText}
                  onChange={(e) => setInvoiceText(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-800 focus:border-gray-500 focus:bg-white focus:outline-none"
                />
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setInvoiceBuyerName(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={invoiceLoading}
                onClick={() => void executeCopy()}
                className="rounded-md bg-purple-700 px-4 py-2 text-sm font-medium text-white hover:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-50"
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
                  <p className="text-gray-500">Shipping COD</p>
                  <p className="font-medium text-gray-900">{selectedBuyer.fulfillmentSummary.parking_shipping + selectedBuyer.fulfillmentSummary.shipping_cod} items</p>
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
                {selectedBuyer.booked > 0 && (
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <button
                      type="button"
                      disabled={copyingBuyer === selectedBuyer.buyer}
                      onClick={() => void handleDirectCopyInvoice(selectedBuyer.buyer)}
                      className="rounded-md bg-purple-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {copyingBuyer === selectedBuyer.buyer ? 'Copying...' : 'Copy Invoice'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleOpenEditInvoice(selectedBuyer.buyer)}
                      className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Edit Invoice
                    </button>
                  </div>
                )}
              </div>
              {detailLoading ? (
                <p className="text-sm text-gray-400">Loading bookings...</p>
              ) : selectedBuyer.bookings.filter((booking) => booking.status === 'active').length === 0 ? (
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
              {detailLoading ? (
                <p className="text-sm text-gray-400">Loading purchase history...</p>
              ) : selectedBuyer.sales.length === 0 ? (
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
