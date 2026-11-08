import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useDataInvalidation } from '../lib/dataSync'
import { fetchAllRows } from '../lib/supabasePagination'
import { formatDate, formatIDR, splitAmount } from '../lib/format'
import Modal from '../components/Modal'
import FormattedPriceInput from '../components/FormattedPriceInput'
import type { Booking, InventoryItem, Sale } from '../types/database'
import {
  isConvertedBookingStatus,
  resolveItemTransactionDetails,
  type InventoryItemWithRelations,
} from '../lib/itemTransactionSync'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { logActivity } from '../lib/activityLog'

const PAGE_SIZE = 200
const SEARCH_DEBOUNCE_MS = 300
const BATCH_ITEMS_SELECT =
  'id, item_name, batch_name, batch_modal_total, modal_price, status, created_at'
const BATCH_SALES_SELECT =
  'id, inventory_item_id, buyer_name, sale_price, sale_date, created_at, inventory_items(batch_name, item_name)'
const BATCH_BOOKINGS_SELECT =
  'id, inventory_item_id, booking_group_id, group_total_deal_price, buyer_name, deal_price, status, created_at, inventory_items(batch_name, item_name)'

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

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

type BatchSortOption =
  | 'newest'
  | 'oldest'
  | 'highest_revenue'
  | 'lowest_revenue'
  | 'highest_profit'
  | 'lowest_profit'

const SORT_OPTIONS: { label: string; value: BatchSortOption }[] = [
  { label: 'Newest Added', value: 'newest' },
  { label: 'Oldest Added', value: 'oldest' },
  { label: 'Highest Revenue', value: 'highest_revenue' },
  { label: 'Lowest Revenue', value: 'lowest_revenue' },
  { label: 'Highest Profit', value: 'highest_profit' },
  { label: 'Lowest Profit', value: 'lowest_profit' },
]

function getBatchTimestamp(batch: BatchSummary, mode: 'newest' | 'oldest'): number {
  if (!batch.items || batch.items.length === 0) {
    return mode === 'newest' ? 0 : Number.MAX_SAFE_INTEGER
  }
  let result: number | null = null
  for (const item of batch.items) {
    if (!item.created_at) continue
    const time = new Date(item.created_at).getTime()
    if (Number.isNaN(time) || time <= 0) continue
    if (result === null) {
      result = time
    } else if (mode === 'newest') {
      if (time > result) result = time
    } else {
      if (time < result) result = time
    }
  }
  if (result === null) {
    return mode === 'newest' ? 0 : Number.MAX_SAFE_INTEGER
  }
  return result
}

function compareBatches(a: BatchSummary, b: BatchSummary, sortBy: BatchSortOption): number {
  switch (sortBy) {
    case 'newest': {
      const timeA = getBatchTimestamp(a, 'newest')
      const timeB = getBatchTimestamp(b, 'newest')
      return timeB - timeA || a.batchName.localeCompare(b.batchName)
    }
    case 'oldest': {
      const timeA = getBatchTimestamp(a, 'oldest')
      const timeB = getBatchTimestamp(b, 'oldest')
      return timeA - timeB || a.batchName.localeCompare(b.batchName)
    }
    case 'highest_revenue':
      return b.totalRevenue - a.totalRevenue || a.batchName.localeCompare(b.batchName)
    case 'lowest_revenue':
      return a.totalRevenue - b.totalRevenue || a.batchName.localeCompare(b.batchName)
    case 'highest_profit':
      return b.profit - a.profit || a.batchName.localeCompare(b.batchName)
    case 'lowest_profit':
      return a.profit - b.profit || a.batchName.localeCompare(b.batchName)
    default:
      return a.batchName.localeCompare(b.batchName)
  }
}

export default function Batches() {
  const { user, canWrite } = useAuth()
  const { showToast } = useToast()

  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [page, setPage] = useState<number>(1)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FilterValue>('All')
  const [sortBy, setSortBy] = useState<BatchSortOption>('newest')
  const [selectedBatch, setSelectedBatch] = useState<BatchSummary | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  // ── Edit batch state ──────────────────────────────────────────────────────
  const [editingBatch, setEditingBatch] = useState<BatchSummary | null>(null)
  const [editName, setEditName] = useState('')
  const [editModalTotal, setEditModalTotal] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  // Monotonic request id: only the most recently *started* load may commit its result,
  // so a slow, older response can never overwrite fresher numbers ("ghost" revenue).
  const loadSeqRef = useRef(0)
  const hasLoadedRef = useRef(false)

  const loadBatches = useCallback(async () => {
    const seq = ++loadSeqRef.current
    const isLatest = () => seq === loadSeqRef.current
    // First load shows the full loader; later refreshes keep current data on screen.
    if (hasLoadedRef.current) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const from = (page - 1) * PAGE_SIZE
      const to = from + PAGE_SIZE - 1
      const trimmedSearch = debouncedSearch.trim()

      let paginatedBatchNames: string[] = []
      let totalBatchesCount = 0

      // Step 1: Check if physical `batches` table exists
      let hasPhysicalTable = false
      try {
        let physicalQuery = supabase
          .from('batches')
          .select('batch_name', { count: 'exact' })

        if (trimmedSearch) {
          physicalQuery = physicalQuery.ilike('batch_name', `%${trimmedSearch}%`)
        }

        const physicalRes = await physicalQuery
          .order('batch_name', { ascending: true })
          .range(from, to)

        if (!physicalRes.error && physicalRes.data && physicalRes.data.length > 0) {
          hasPhysicalTable = true
          totalBatchesCount = physicalRes.count ?? physicalRes.data.length
          paginatedBatchNames = physicalRes.data
            .map((b: { batch_name: string | null }) => b.batch_name?.trim())
            .filter((n): n is string => Boolean(n))
        }
      } catch {
        // Fall back to derived batches
      }

      // If no physical table, derive distinct batches from inventory_items
      if (!hasPhysicalTable) {
        let allBatchItems: {
          batch_name: string | null
          batch_modal_total: number | null
          created_at: string | null
        }[] = []

        if (trimmedSearch) {
          const words = trimmedSearch.split(/\s+/).filter(Boolean)
          allBatchItems = await fetchAllRows(async (f, t) => {
            let q = supabase
              .from('inventory_items')
              .select('batch_name, batch_modal_total, created_at')
            for (const word of words) {
              const safeWord = word.replace(/[,()]/g, '')
              if (!safeWord) continue
              q = q.or(`batch_name.ilike.%${safeWord}%,item_name.ilike.%${safeWord}%`)
            }
            return q
              .order('created_at', { ascending: false })
              .range(f, t)
          }, 1000)
        } else {
          allBatchItems = await fetchAllRows(async (f, t) => {
            return supabase
              .from('inventory_items')
              .select('batch_name, batch_modal_total, created_at')
              .order('created_at', { ascending: false })
              .range(f, t)
          }, 1000)
        }

        if (!isLatest()) return

        const distinctBatchMap = new Map<
          string,
          {
            batchName: string
            newestTime: number
            oldestTime: number
          }
        >()

        for (const row of allBatchItems) {
          const name = row.batch_name?.trim() || 'Unassigned'
          const time = row.created_at ? new Date(row.created_at).getTime() : 0
          const existing = distinctBatchMap.get(name)
          if (!existing) {
            distinctBatchMap.set(name, {
              batchName: name,
              newestTime: time,
              oldestTime: time,
            })
          } else {
            if (time > existing.newestTime) existing.newestTime = time
            if (time < existing.oldestTime && time > 0) existing.oldestTime = time
          }
        }

        const sortedBatchesList = Array.from(distinctBatchMap.values())

        if (sortBy === 'oldest') {
          sortedBatchesList.sort((a, b) => a.oldestTime - b.oldestTime || a.batchName.localeCompare(b.batchName))
        } else if (sortBy === 'newest') {
          sortedBatchesList.sort((a, b) => b.newestTime - a.newestTime || a.batchName.localeCompare(b.batchName))
        } else {
          sortedBatchesList.sort((a, b) => a.batchName.localeCompare(b.batchName))
        }

        totalBatchesCount = sortedBatchesList.length
        const pagedBatches = sortedBatchesList.slice(from, to + 1)
        paginatedBatchNames = pagedBatches.map((b) => b.batchName)
      }

      if (!isLatest()) return

      if (paginatedBatchNames.length === 0) {
        setBatches([])
        setTotalCount(0)
        setSelectedBatch(null)
        hasLoadedRef.current = true
        return
      }

      // Step 2: Fetch ALL inventory_items (and their nested sales/bookings) that belong to ONLY those batches
      const namedBatches = paginatedBatchNames.filter((n) => n !== 'Unassigned')
      const hasUnassigned = paginatedBatchNames.includes('Unassigned')

      const inventoryItems: InventoryItemWithRelations[] = []

      if (namedBatches.length > 0) {
        const batchChunks = chunkArray(namedBatches, 50)
        const chunkResults = await Promise.all(
          batchChunks.map((chunk) =>
            fetchAllRows<InventoryItemWithRelations>(
              (f, t) =>
                supabase
                  .from('inventory_items')
                  .select(BATCH_ITEMS_SELECT)
                  .in('batch_name', chunk)
                  .order('created_at', { ascending: true })
                  .range(f, t) as unknown as PromiseLike<{
                  data: InventoryItemWithRelations[] | null
                  error: { message: string } | null
                }>,
              1000
            )
          )
        )
        for (const items of chunkResults) {
          inventoryItems.push(...items)
        }
      }

      if (hasUnassigned) {
        const unassignedItems = await fetchAllRows<InventoryItemWithRelations>(
          (f, t) =>
            supabase
              .from('inventory_items')
              .select(BATCH_ITEMS_SELECT)
              .or('batch_name.is.null,batch_name.eq.,batch_name.eq.Unassigned')
              .order('created_at', { ascending: true })
              .range(f, t) as unknown as PromiseLike<{
              data: InventoryItemWithRelations[] | null
              error: { message: string } | null
            }>,
          1000
        )
        inventoryItems.push(...unassignedItems)
      }

      if (!isLatest()) return

      const itemIds = inventoryItems.map((i) => i.id)
      const sales: SaleRow[] = []
      const bookings: BookingRow[] = []

      if (itemIds.length > 0) {
        const idChunks = chunkArray(itemIds, 150)
        const [salesChunks, bookingsChunks] = await Promise.all([
          Promise.all(
            idChunks.map((chunk) =>
              fetchAllRows<SaleRow>(
                (f, t) =>
                  supabase
                    .from('sales')
                    .select(BATCH_SALES_SELECT)
                    .in('inventory_item_id', chunk)
                    .order('sale_date', { ascending: false })
                    .range(f, t) as unknown as PromiseLike<{
                    data: SaleRow[] | null
                    error: { message: string } | null
                  }>,
                1000
              )
            )
          ),
          Promise.all(
            idChunks.map((chunk) =>
              fetchAllRows<BookingRow>(
                (f, t) =>
                  supabase
                    .from('bookings')
                    .select(BATCH_BOOKINGS_SELECT)
                    .in('inventory_item_id', chunk)
                    .order('created_at', { ascending: false })
                    .range(f, t) as unknown as PromiseLike<{
                    data: BookingRow[] | null
                    error: { message: string } | null
                  }>,
                1000
              )
            )
          ),
        ])
        if (!isLatest()) return
        for (const chunk of salesChunks) sales.push(...chunk)
        for (const chunk of bookingsChunks) bookings.push(...chunk)
      }

      // Step 3: Group and calculate revenue, modal, and profit using the complete set of items
      const bookingsByGroup = new Map<string, BookingRow[]>()
      for (const b of bookings) {
        if (b.booking_group_id) {
          const list = bookingsByGroup.get(b.booking_group_id) ?? []
          list.push(b)
          bookingsByGroup.set(b.booking_group_id, list)
        }
      }
      for (const groupBookings of bookingsByGroup.values()) {
        const groupTotal =
          groupBookings.find((b) => (b.group_total_deal_price ?? 0) > 0)?.group_total_deal_price ?? 0
        const allZero = groupBookings.every((b) => !b.deal_price || b.deal_price <= 0)
        if (groupTotal > 0 && allZero) {
          const splitPrices = splitAmount(groupTotal, groupBookings.length)
          groupBookings.forEach((b, idx) => {
            b.deal_price = splitPrices[idx] ?? 0
          })
        }
      }

      const salesByItemId = new Map<string, SaleRow[]>()
      for (const sale of sales) {
        if (sale.inventory_item_id) {
          const existing = salesByItemId.get(sale.inventory_item_id) ?? []
          existing.push(sale)
          salesByItemId.set(sale.inventory_item_id, existing)
        }
      }

      const bookingsByItemId = new Map<string, BookingRow[]>()
      for (const booking of bookings) {
        if (booking.inventory_item_id) {
          const existing = bookingsByItemId.get(booking.inventory_item_id) ?? []
          existing.push(booking)
          bookingsByItemId.set(booking.inventory_item_id, existing)
        }
      }

      const itemById = new Map<string, InventoryItemWithRelations>()
      for (const item of inventoryItems) {
        itemById.set(item.id, item)
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

      for (const batchName of paginatedBatchNames) {
        ensureBatch(batchName)
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

        const resolved = resolveItemTransactionDetails(
          item,
          salesByItemId.get(item.id) ?? [],
          bookingsByItemId.get(item.id) ?? []
        )

        const itemWithSale: InventoryItemWithSale = {
          ...item,
          salePrice: resolved.salePrice,
          buyerName: resolved.buyerName,
        }

        if (resolved.hasSaleOrConvertedBooking && resolved.salePrice !== null) {
          batch.salesRevenue += resolved.salePrice
        }

        if (item.status === 'ready') batch.readyCount += 1
        else if (item.status === 'booked') batch.bookedCount += 1
        else if (item.status === 'sold') batch.soldCount += 1

        batch.items.push(itemWithSale)
      }

      for (const booking of bookings) {
        if (booking.status === 'cancelled' || isConvertedBookingStatus(booking.status)) continue
        const linkedItem = booking.inventory_item_id ? itemById.get(booking.inventory_item_id) : undefined
        if ((linkedItem?.status ?? '').toLowerCase() === 'sold') continue
        const batchName =
          booking.inventory_items?.batch_name?.trim() || linkedItem?.batch_name?.trim() || 'Unassigned'
        const batch = batchMap.get(batchName)
        if (!batch) continue
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

      const sortedBatches = Array.from(batchMap.values()).sort((a, b) => a.batchName.localeCompare(b.batchName))
      setBatches(sortedBatches)
      setTotalCount(totalBatchesCount)
      setSelectedBatch((current) =>
        current ? sortedBatches.find((b) => b.batchName === current.batchName) ?? null : null
      )
      hasLoadedRef.current = true
    } catch (loadError) {
      if (!isLatest()) return
      setError(loadError instanceof Error ? loadError.message : 'Unable to load batches.')
    } finally {
      if (isLatest()) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [page, debouncedSearch, sortBy])

  // Fresh fetch on mount and when page / search / sort changes
  useEffect(() => {
    void loadBatches()
  }, [loadBatches])

  // … and whenever inventory / sales / bookings change anywhere (this tab or another),
  // or the window regains focus.
  useDataInvalidation(
    ['inventory_items', 'sales', 'bookings', 'batches'],
    () => {
      void loadBatches()
    },
    { remoteOnly: true }
  )

  function openEditBatch(batch: BatchSummary) {
    setEditingBatch(batch)
    setEditName(batch.batchName)
    setEditModalTotal(String(batch.batchModal))
  }

  async function handleEditBatchSubmit(e: FormEvent) {
    e.preventDefault()
    if (!editingBatch) return

    const newName = editName.trim()
    if (!newName) {
      showToast('Batch name cannot be empty.', 'error')
      return
    }

    const newModalTotal = Number(editModalTotal) || 0
    setEditSaving(true)

    try {
      const oldName = editingBatch.batchName
      const updatePayload = {
        batch_name: newName,
        batch_modal_total: newModalTotal,
      }

      const updateQuery =
        oldName === 'Unassigned'
          ? supabase
              .from('inventory_items')
              .update(updatePayload)
              .or('batch_name.is.null,batch_name.eq.Unassigned')
          : supabase
              .from('inventory_items')
              .update(updatePayload)
              .eq('batch_name', oldName)

      const { error: updateError } = await updateQuery

      if (updateError) {
        showToast(updateError.message, 'error')
        return
      }

      void logActivity({
        action: 'Edit Batch',
        description: `Updated batch "${oldName}" (new modal: ${formatIDR(newModalTotal)})`,
        userId: user?.id,
        details: { old_name: oldName, new_name: newName, modal_total: newModalTotal },
      })

      showToast('Batch updated successfully.')
      setEditingBatch(null)
      if (selectedBatch && selectedBatch.batchName === oldName) {
        setSelectedBatch(null)
      }
      await loadBatches()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update batch.', 'error')
    } finally {
      setEditSaving(false)
    }
  }

  // Delete batch with strict validation
  async function handleDeleteBatch(batch: BatchSummary) {
    // Validate that there are no booked or sold items
    if (batch.bookedCount > 0 || batch.soldCount > 0) {
      showToast('Cannot delete batch: It already has booked or sold items.', 'error');
      return;
    }

    const confirmed = window.confirm(
      'Are you sure you want to delete this batch? All unsold/ready items inside this batch will also be deleted.'
    );
    if (!confirmed) return;

    try {
      // Delete inventory items belonging to the batch
      const { error: itemsError } = await supabase
        .from('inventory_items')
        .delete()
        .eq('batch_name', batch.batchName);
      if (itemsError) {
        showToast(itemsError.message, 'error');
        return;
      }

      // Delete the batch itself if physical batches table exists
      try {
        await supabase
          .from('batches')
          .delete()
          .eq('batch_name', batch.batchName);
      } catch {
        // Physical batches table may not exist
      }

      void logActivity({
        action: 'Delete Batch',
        description: `Deleted batch "${batch.batchName}"`,
        userId: user?.id,
        details: { batch_name: batch.batchName },
      })

      showToast('Batch deleted successfully.');
      await loadBatches();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete batch.', 'error');
    }
  }

  const filteredBatches = useMemo(() => {
    return batches
      .filter((batch) => statusFilter === 'All' || batch.status === statusFilter)
      .sort((a, b) => compareBatches(a, b, sortBy))
  }, [batches, statusFilter, sortBy])

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const hasPrevPage = page > 1
  const hasNextPage = page < totalPages
  const pageFrom = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const pageTo = totalCount === 0 ? 0 : Math.min(totalCount, page * PAGE_SIZE)

  const batchStatusClasses: Record<BatchStatus, string> = {
    'No Sales': 'bg-gray-100 text-gray-700',
    'In Progress': 'bg-yellow-100 text-yellow-800',
    'Break Even': 'bg-green-100 text-green-800',
    Profit: 'bg-green-100 text-green-800',
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">Batches</h1>
          {refreshing && (
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-pink-500" />
              Syncing...
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(1)
          }}
          placeholder="Search batch, item, or batch modal..."
          className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value as FilterValue)
            setPage(1)
          }}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        >
          {FILTERS.map((filter) => (
            <option key={filter} value={filter}>
              {filter}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(event) => {
            setSortBy(event.target.value as BatchSortOption)
            setPage(1)
          }}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
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
                      <div className="flex items-center gap-2">
                        {canWrite && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              openEditBatch(batch)
                            }}
                            className="text-xs font-medium text-blue-600 hover:underline"
                          >
                            Edit
                          </button>
                        )}
                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${batchStatusClasses[batch.status]}`}>
                          {batch.status}
                        </span>
                      </div>
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
          <div className="hidden md:block w-full overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full min-w-full divide-y divide-gray-200 text-left text-sm">
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
                  <th className="sticky right-0 z-20 whitespace-nowrap bg-gray-50/95 px-3 py-2 text-left font-medium text-gray-600 backdrop-blur-md shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.05)] dark:bg-zinc-800/95">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredBatches.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="px-3 py-6 text-center text-gray-400">
                      No batches found.
                    </td>
                  </tr>
                ) : (
                  filteredBatches.map((batch) => {
                    const barWidth = `${Math.min(100, Math.round(batch.recoveryPercent))}%`
                    return (
                      <tr key={batch.batchName} className="group hover:bg-gray-50">
                        <td className="max-w-[200px] truncate px-3 py-3 sm:max-w-[280px] lg:max-w-[360px]">
                          <button
                            type="button"
                            onClick={() => setSelectedBatch(batch)}
                            className="block truncate font-medium text-blue-700 hover:underline"
                            title={batch.batchName}
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
                        <td className="sticky right-0 z-10 whitespace-nowrap bg-white/95 px-3 py-3 backdrop-blur-md shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.05)] group-hover:bg-gray-50/95 dark:bg-zinc-900/95 dark:group-hover:bg-zinc-800/95">
                          {canWrite && (
                            <div className="flex items-center gap-2 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openEditBatch(batch)
                                }}
                                className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteBatch(batch)
                                }}
                                className="font-medium text-red-600 hover:text-red-800 hover:underline"
                              >
                                Delete
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

          {/* Server-Side Pagination Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
            <div className="text-gray-600">
              Showing <span className="font-medium text-gray-900">{pageFrom}</span> to{' '}
              <span className="font-medium text-gray-900">{pageTo}</span> of{' '}
              <span className="font-medium text-gray-900">{totalCount}</span> batches (Page{' '}
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
              <div className="w-full overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full min-w-full divide-y divide-gray-200 text-left text-sm">
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
                        <td className="max-w-[200px] truncate px-3 py-2 sm:max-w-[300px]" title={item.item_name}>
                          <span className="block truncate">{item.item_name}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{item.status}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {selectedBatch.totalItems > 0
                            ? formatIDR(Math.floor(selectedBatch.batchModal / selectedBatch.totalItems))
                            : '-'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{formatIDR(item.salePrice ?? 0)}</td>
                        <td className="max-w-[150px] truncate px-3 py-2 sm:max-w-[200px]" title={item.buyerName ?? '-'}>
                          <span className="block truncate">{item.buyerName ?? '-'}</span>
                        </td>
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

      {editingBatch && (
        <Modal title={`Edit Batch — ${editingBatch.batchName}`} onClose={() => setEditingBatch(null)}>
          <form onSubmit={handleEditBatchSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Batch Name *</label>
              <input
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g. Borongan 3.350 Anuva"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Batch Modal (Modal Total) *</label>
              <FormattedPriceInput
                value={editModalTotal}
                onChange={(val) => setEditModalTotal(val)}
                placeholder="0"
                required
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingBatch(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={editSaving}
                className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
              >
                {editSaving ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
