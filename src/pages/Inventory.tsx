import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useDataInvalidation } from '../lib/dataSync'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { formatIDR, formatDate, formatStatus } from '../lib/format'
import { exportToCSV } from '../lib/csv'
import { logActivity } from '../lib/activityLog'
import { ITEM_STATUSES, STATUS_BADGE_CLASSES } from '../lib/constants'
import type { Booking, InventoryItem, Sale } from '../types/database'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'
import BatchAutocomplete from '../components/BatchAutocomplete'
import CategoryAutocomplete from '../components/CategoryAutocomplete'
import ItemNameAutocomplete, { type ItemSuggestionRecord } from '../components/ItemNameAutocomplete'
import FormattedPriceInput from '../components/FormattedPriceInput'
import { getLiveModalPrice } from '../lib/inventoryModal'
import { resolveItemTransactionDetails } from '../lib/itemTransactionSync'

// ─── Types ────────────────────────────────────────────────────────────────────

type BookingRow = Booking & { inventory_items: { item_name: string } | null }

type AddMode = 'single' | 'multiple'

interface MultiItemRow {
  id: string
  item_name: string
  category: string
  notes: string
  quantity: number | string
}

const emptyForm = {
  item_name: '',
  category: '',
  batch_name: '',
  batch_modal_total: '',
  notes: '',
}

const emptyBulkBookingForm = {
  buyer_name: '',
  total_deal_price: '0',
  deadline: '',
  notes: '',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COLLAPSED_KEY = 'inventory_collapsed_categories'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
  } catch {
    // ignore storage errors
  }
}

/**
 * Split UUIDs into batches for `.in('id', ...)` filters. PostgREST encodes the filter in the
 * URL, so selecting hundreds of rows at once can exceed URL length limits.
 */
const ID_CHUNK_SIZE = 150
function chunkIds(ids: string[], size = ID_CHUNK_SIZE): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  return chunks
}

/**
 * Explicit column selection for `inventory_items` to minimize Supabase egress payload.
 * Excludes unused metadata / legacy columns (`legacy_import_id`, `legacy_row_id`, `created_by`, `updated_at`, etc.).
 */
const INVENTORY_SELECT_COLUMNS =
  'id, item_name, category, batch_name, batch_modal_total, modal_price, status, notes, created_at'
const INVENTORY_PAGE_SIZE = 200
const SEARCH_DEBOUNCE_MS = 300

// ─── Component ────────────────────────────────────────────────────────────────

export default function Inventory() {
  const { user, canWrite } = useAuth()
  const { showToast } = useToast()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [page, setPage] = useState<number>(1)
  const [deletingItem, setDeletingItem] = useState<InventoryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  // Category collapse state — persisted in localStorage
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(loadCollapsed)
  // Visible items limit per category to avoid rendering thousands of DOM elements
  const [expandedLimits, setExpandedLimits] = useState<Record<string, number>>({})

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addMode, setAddMode] = useState<AddMode>('single')

  // Single item form state
  const [form, setForm] = useState(emptyForm)

  // Multiple items form state
  const [multiBatchName, setMultiBatchName] = useState('')
  const [multiBatchModalTotal, setMultiBatchModalTotal] = useState('')
  const [multiItems, setMultiItems] = useState<MultiItemRow[]>([
    { id: crypto.randomUUID(), item_name: '', category: '', notes: '', quantity: 1 },
  ])

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([])
  const [showBulkBookingModal, setShowBulkBookingModal] = useState(false)
  const [bulkBookingForm, setBulkBookingForm] = useState(emptyBulkBookingForm)
  const [bulkBookingSaving, setBulkBookingSaving] = useState(false)
  const [bulkDeleteSaving, setBulkDeleteSaving] = useState(false)
  const [bulkBookingError, setBulkBookingError] = useState<string | null>(null)

  // Detail drawer
  const [drawerItem, setDrawerItem] = useState<InventoryItem | null>(null)
  const [drawerBookings, setDrawerBookings] = useState<BookingRow[]>([])
  const [drawerSales, setDrawerSales] = useState<Sale[]>([])
  const [drawerLoading, setDrawerLoading] = useState(false)

  const [refreshing, setRefreshing] = useState(false)
  const hasLoadedRef = useRef(false)
  const loadSeqRef = useRef(0)

  const drawerResolvedDetails = useMemo(() => {
    if (!drawerItem) return { salePrice: null, buyerName: null, hasSaleOrConvertedBooking: false }
    return resolveItemTransactionDetails(drawerItem, drawerSales, drawerBookings)
  }, [drawerItem, drawerSales, drawerBookings])

  // ── Data loading ─────────────────────────────────────────────────────────

  const loadItems = useCallback(async () => {
    const seq = ++loadSeqRef.current
    const isLatest = () => seq === loadSeqRef.current
    if (hasLoadedRef.current) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const from = (page - 1) * INVENTORY_PAGE_SIZE
      const to = from + INVENTORY_PAGE_SIZE - 1

      let query = supabase
        .from('inventory_items')
        .select(INVENTORY_SELECT_COLUMNS, { count: 'exact' })

      const normalizedStatus = statusFilter.trim().toLowerCase()
      if (normalizedStatus && normalizedStatus !== 'all') {
        query = query.eq('status', normalizedStatus)
      }

      const trimmedSearch = debouncedSearch.trim()
      if (trimmedSearch) {
        const words = trimmedSearch.split(/\s+/).filter(Boolean)
        for (const word of words) {
          const safeWord = word.replace(/[,()]/g, '')
          if (!safeWord) continue
          query = query.or(
            `item_name.ilike.%${safeWord}%,batch_name.ilike.%${safeWord}%,category.ilike.%${safeWord}%`
          )
        }
      }

      const { data, count, error: fetchError } = await query
        .order('created_at', { ascending: false })
        // Unique tie-breaker: bulk-inserted rows share an identical created_at, so without
        // ordering by id, page boundaries are non-deterministic (duplicate / missing UUIDs).
        .order('id', { ascending: false })
        .range(from, to)

      if (fetchError) throw new Error(fetchError.message)
      if (!isLatest()) return

      // Defensive de-duplication by UUID so every row (and React key) is unique.
      const uniqueById = new Map<string, InventoryItem>()
      for (const row of (data as unknown as InventoryItem[]) ?? []) {
        if (row?.id && !uniqueById.has(row.id)) uniqueById.set(row.id, row)
      }
      const uniqueItems = [...uniqueById.values()]
      setItems(uniqueItems)
      setTotalCount(count ?? uniqueItems.length)
      hasLoadedRef.current = true
      // Drop selections that no longer exist on the current page.
      setSelectedItemIds((current) => current.filter((id) => uniqueById.has(id)))
      // Preserve detail drawer item without closing it
      setDrawerItem((current) => (current ? uniqueById.get(current.id) ?? current : null))
    } catch (err) {
      if (!isLatest()) return
      setError(err instanceof Error ? err.message : 'Failed to load inventory items.')
    } finally {
      if (isLatest()) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [page, statusFilter, debouncedSearch])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  useDataInvalidation(
    ['inventory_items', 'sales', 'bookings'],
    () => {
      void loadItems()
    },
    { remoteOnly: true }
  )

  // Load drawer history when an item is selected
  useEffect(() => {
    if (!drawerItem) return

    const itemId = drawerItem.id
    let cancelled = false
    setDrawerLoading(true)

    async function loadHistory() {
      const [bookingsRes, salesRes] = await Promise.all([
        supabase
          .from('bookings')
          .select('id, buyer_name, deal_price, group_total_deal_price, status, created_at, inventory_items(item_name)')
          .eq('inventory_item_id', itemId)
          .order('created_at', { ascending: false }),
        supabase
          .from('sales')
          .select('id, buyer_name, sale_price, gross_profit, net_profit, sale_date, created_at')
          .eq('inventory_item_id', itemId)
          .order('sale_date', { ascending: false }),
      ])
      if (cancelled) return
      setDrawerBookings((bookingsRes.data as unknown as BookingRow[]) ?? [])
      setDrawerSales((salesRes.data as unknown as Sale[]) ?? [])
      setDrawerLoading(false)
    }

    loadHistory()
    return () => {
      cancelled = true
    }
  }, [drawerItem])

  // ── Filtering & grouping (Server-side filtered; sorted & grouped for display) ──

  const filtered = useMemo(() => {
    return [...items].sort((a, b) => a.item_name.localeCompare(b.item_name))
  }, [items])

  // Group items by category for the collapsible view
  const grouped = useMemo(() => {
    const map = new Map<string, InventoryItem[]>()
    for (const item of filtered) {
      const key = item.category?.trim() || 'Uncategorised'
      const arr = map.get(key) ?? []
      arr.push(item)
      map.set(key, arr)
    }
    // Sort groups alphabetically; 'Uncategorised' goes last
    return [...map.entries()].sort(([a], [b]) => {
      if (a === 'Uncategorised') return 1
      if (b === 'Uncategorised') return -1
      return a.localeCompare(b)
    })
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(totalCount / INVENTORY_PAGE_SIZE))
  const hasPrevPage = page > 1
  const hasNextPage = page < totalPages || items.length === INVENTORY_PAGE_SIZE
  const pageFrom = totalCount === 0 ? 0 : (page - 1) * INVENTORY_PAGE_SIZE + 1
  const pageTo = totalCount === 0 ? 0 : (page - 1) * INVENTORY_PAGE_SIZE + items.length

  // ── Selection helpers (keyed exclusively by database UUID) ───────────────

  // O(1) membership checks — item names are NOT unique (e.g. 77 rows named "Loose").
  const selectedIdSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds])

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIdSet.has(item.id)),
    [items, selectedIdSet]
  )

  const filteredIds = useMemo(() => filtered.map((item) => item.id), [filtered])

  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIdSet.has(id))

  function addIdsToSelection(ids: string[]) {
    setSelectedItemIds((current) => Array.from(new Set([...current, ...ids])))
  }

  function removeIdsFromSelection(ids: string[]) {
    const toRemove = new Set(ids)
    setSelectedItemIds((current) => current.filter((id) => !toRemove.has(id)))
  }

  function toggleItemSelection(itemId: string) {
    setSelectedItemIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]
    )
  }

  function toggleSelectAll() {
    if (allFilteredSelected) {
      removeIdsFromSelection(filteredIds)
      return
    }
    addIdsToSelection(filteredIds)
  }

  // Category selection helpers — operate on the UUIDs of that group's child items
  function isCategoryFullySelected(catItems: InventoryItem[]) {
    return catItems.length > 0 && catItems.every((i) => selectedIdSet.has(i.id))
  }
  function isCategoryPartiallySelected(catItems: InventoryItem[]) {
    return catItems.some((i) => selectedIdSet.has(i.id)) && !isCategoryFullySelected(catItems)
  }
  function toggleCategorySelection(catItems: InventoryItem[]) {
    const ids = catItems.map((i) => i.id)
    if (isCategoryFullySelected(catItems)) {
      removeIdsFromSelection(ids)
    } else {
      addIdsToSelection(ids)
    }
  }

  // ── Category collapse ────────────────────────────────────────────────────

  function toggleCategory(cat: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      saveCollapsed(next)
      return next
    })
  }

  // ── Modals ───────────────────────────────────────────────────────────────

  function openBulkBookingModal() {
    if (selectedItems.length === 0) return
    const nonReadyItems = selectedItems.filter((item) => item.status !== 'ready')
    if (nonReadyItems.length > 0) {
      showToast('Only ready inventory items can be bulk booked. Please deselect booked, sold, or cancelled items.', 'error')
      return
    }
    setBulkBookingForm(emptyBulkBookingForm)
    setBulkBookingError(null)
    setShowBulkBookingModal(true)
  }

  function openAddModal() {
    setEditingId(null)
    setAddMode('single')
    setForm(emptyForm)
    setMultiBatchName('')
    setMultiBatchModalTotal('')
    setMultiItems([{ id: crypto.randomUUID(), item_name: '', category: '', notes: '', quantity: 1 }])
    setFormError(null)
    setShowModal(true)
  }

  function openEditModal(item: InventoryItem) {
    setEditingId(item.id)
    setAddMode('single')
    setForm({
      item_name: item.item_name,
      category: item.category ?? '',
      batch_name: item.batch_name ?? '',
      batch_modal_total: item.batch_modal_total ? String(item.batch_modal_total) : '',
      notes: item.notes ?? '',
    })
    setFormError(null)
    setShowModal(true)
  }

  // ── Dynamic multi-item row handlers ──────────────────────────────────────

  function addMultiRow() {
    setMultiItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), item_name: '', category: '', notes: '', quantity: 1 },
    ])
  }

  function updateMultiRow(id: string, field: keyof MultiItemRow, value: string | number) {
    setMultiItems((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    )
  }

  function removeMultiRow(id: string) {
    if (multiItems.length === 1) return
    setMultiItems((prev) => prev.filter((row) => row.id !== id))
  }

  // ── Submit handlers ──────────────────────────────────────────────────────

  async function handleMultiSubmit() {
    const batchName = multiBatchName.trim()
    const modalTotal = multiBatchModalTotal.trim() ? Number(multiBatchModalTotal) : null

    if (!batchName) {
      setFormError('Please select or create a batch before saving.')
      return
    }

    // Validate items
    const validItems = multiItems.filter((i) => i.item_name.trim() || i.category.trim())
    if (validItems.length === 0) {
      setFormError('Please add at least one item.')
      return
    }

    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i]
      if (!item.item_name.trim()) {
        setFormError(`Item #${i + 1} is missing a name.`)
        return
      }
      if (!item.category.trim()) {
        setFormError(`Item #${i + 1} ("${item.item_name}") is missing a category.`)
        return
      }
    }

    setSaving(true)
    setFormError(null)

    const itemsPayload = validItems.flatMap((item) => {
      const rawQty = typeof item.quantity === 'number' ? item.quantity : parseInt(String(item.quantity || '1'), 10)
      const qty = !rawQty || isNaN(rawQty) || rawQty < 1 ? 1 : Math.floor(rawQty)
      const itemObj = {
        item_name: item.item_name.trim(),
        category: item.category.trim() || null,
        batch_name: batchName || null,
        batch_modal_total: batchName ? modalTotal : null,
        modal_price: 0,
        quantity: 1,
        status: 'ready' as const,
        notes: item.notes.trim() || null,
        created_by: user?.id,
      }
      return Array.from({ length: qty }, () => ({ ...itemObj }))
    })

    const { error } = await supabase.from('inventory_items').insert(itemsPayload)

    // Sync batch_modal_total across all items in that batch if provided
    if (batchName && modalTotal !== null && !error) {
      await supabase
        .from('inventory_items')
        .update({ batch_modal_total: modalTotal })
        .eq('batch_name', batchName)
    }

    setSaving(false)
    if (error) {
      setFormError(error.message)
      return
    }

    void logActivity({
      action: 'Bulk Add Items',
      description: `Bulk added ${itemsPayload.length} items to batch "${batchName || 'Unassigned'}"`,
      userId: user?.id,
      details: { count: itemsPayload.length, batch_name: batchName || 'Unassigned' },
    })

    setShowModal(false)
    loadItems()
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()

    if (addMode === 'multiple' && !editingId) {
      return handleMultiSubmit()
    }

    if (!form.item_name.trim()) {
      setFormError('Item name is required.')
      return
    }

    const batchName = form.batch_name.trim()
    const modalTotal = form.batch_modal_total.trim() ? Number(form.batch_modal_total) : null

    setSaving(true)
    setFormError(null)

    const payload: Record<string, unknown> = {
      item_name: form.item_name.trim(),
      category: form.category.trim() || null,
      batch_name: batchName || null,
      batch_modal_total: batchName ? modalTotal : null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    let error
    if (editingId) {
      ;({ error } = await supabase.from('inventory_items').update(payload).eq('id', editingId))
    } else {
      ;({ error } = await supabase.from('inventory_items').insert({
        ...payload,
        modal_price: 0,
        quantity: 1,
        status: 'ready',
        created_by: user?.id,
      }))
    }

    // Sync batch_modal_total across all items in that batch if provided
    if (batchName && modalTotal !== null && !error) {
      await supabase
        .from('inventory_items')
        .update({ batch_modal_total: modalTotal })
        .eq('batch_name', batchName)
    }

    setSaving(false)
    if (error) {
      setFormError(error.message)
      return
    }

    if (editingId) {
      void logActivity({
        action: 'Edit Item',
        description: `Edited item: ${form.item_name.trim()} in batch ${batchName || 'Unassigned'}`,
        entityId: editingId,
        userId: user?.id,
        details: { item_name: form.item_name.trim(), batch_name: batchName || 'Unassigned' },
      })
    } else {
      void logActivity({
        action: 'Add Item',
        description: `Added item: ${form.item_name.trim()} to batch ${batchName || 'Unassigned'}`,
        userId: user?.id,
        details: { item_name: form.item_name.trim(), batch_name: batchName || 'Unassigned' },
      })
    }

    setShowModal(false)
    loadItems()
  }

  async function handleBulkBookingSubmit(e: FormEvent) {
    e.preventDefault()
    if (selectedItems.length === 0) {
      setBulkBookingError('Please select at least one item.')
      return
    }
    if (!bulkBookingForm.buyer_name.trim()) {
      setBulkBookingError('Buyer name is required.')
      return
    }

    const nonReadyItems = selectedItems.filter((item) => item.status !== 'ready')
    if (nonReadyItems.length > 0) {
      setBulkBookingError('Only ready inventory items can be bulk booked.')
      return
    }

    setBulkBookingSaving(true)
    setBulkBookingError(null)

    const groupId = selectedItems.length > 1 ? crypto.randomUUID() : null
    const totalDealPrice = Number(bulkBookingForm.total_deal_price) || 0
    const itemCount = selectedItems.length
    const base = Math.floor(totalDealPrice / itemCount)
    const remainder = totalDealPrice - base * itemCount

    const bookingsPayload = selectedItems.map((item, index) => ({
      inventory_item_id: item.id,
      booking_group_id: groupId,
      group_total_deal_price: totalDealPrice,
      buyer_name: bulkBookingForm.buyer_name.trim(),
      deal_price: index === itemCount - 1 ? base + remainder : base,
      // Snapshot modal_price at booking-creation time (Step 1)
      modal_price: getLiveModalPrice(item, items),
      dp_amount: 0,
      remaining_amount: 0,
      deadline: bulkBookingForm.deadline || null,
      status: 'active',
      notes: bulkBookingForm.notes.trim() || null,
      created_by: user?.id,
    }))

    const { error: bookingError } = await supabase.from('bookings').insert(bookingsPayload)
    if (bookingError) {
      setBulkBookingSaving(false)
      setBulkBookingError(bookingError.message)
      return
    }

    const selectedUuids = selectedItems.map((item) => item.id)
    const now = new Date().toISOString()
    let itemError: { message: string } | null = null
    for (const idChunk of chunkIds(selectedUuids)) {
      const { error } = await supabase
        .from('inventory_items')
        .update({ status: 'booked', updated_at: now })
        .in('id', idChunk)
      if (error) {
        itemError = error
        break
      }
    }

    setBulkBookingSaving(false)
    if (itemError) {
      setBulkBookingError(itemError.message)
      return
    }

    setShowBulkBookingModal(false)
    setSelectedItemIds([])
    void logActivity({
      action: 'Bulk Booking',
      description: `Created bulk booking for ${selectedItems.length} items for buyer ${bulkBookingForm.buyer_name.trim()}`,
      userId: user?.id,
      details: { count: selectedItems.length, buyer_name: bulkBookingForm.buyer_name.trim(), booking_group_id: groupId },
    })
    loadItems()
  }
  async function handleBulkDelete() {
    // Resolve selected UUIDs against the loaded rows (never by name).
    const targetItems = selectedItems
    if (targetItems.length === 0) return

    const hasInvalidItems = targetItems.some((item) => {
      const statusLower = item.status?.toLowerCase()
      const hasTransaction = Boolean(
        (item as unknown as Record<string, unknown>).booking_id ||
        (item as unknown as Record<string, unknown>).sale_id
      )
      return statusLower !== 'ready' || hasTransaction
    })

    if (hasInvalidItems) {
      showToast(
        'Cannot delete: One or more selected items are already booked or sold. Please unselect them first.',
        'error'
      )
      return
    }

    const targetIds = targetItems.map((item) => item.id)
    const count = targetIds.length
    const confirmed = window.confirm(
      `Are you sure you want to delete ${count} selected item${count === 1 ? '' : 's'}? This action cannot be undone.`
    )
    if (!confirmed) return

    setBulkDeleteSaving(true)
    let deleteError: { message: string } | null = null
    for (const idChunk of chunkIds(targetIds)) {
      const { error } = await supabase
        .from('inventory_items')
        .delete()
        .in('id', idChunk)
        .eq('status', 'ready')
      if (error) {
        deleteError = error
        break
      }
    }
    setBulkDeleteSaving(false)

    if (deleteError) {
      showToast(deleteError.message, 'error')
      loadItems()
    } else {
      void logActivity({
        action: 'Bulk Delete',
        description: `Bulk deleted ${count} items from Inventory`,
        userId: user?.id,
        details: { count, item_ids: targetIds },
      })
      showToast(`Successfully deleted ${count} item${count === 1 ? '' : 's'}`)
      setSelectedItemIds([])
      loadItems()
    }
  }

  function handleDelete(item: InventoryItem) {
    setDeletingItem(item)
  }

  async function confirmDeleteItem() {
    if (!deletingItem) return
    const item = deletingItem
    const { error } = await supabase.from('inventory_items').delete().eq('id', item.id)
    if (error) {
      showToast(error.message, 'error')
      setDeletingItem(null)
    } else {
      void logActivity({
        action: 'Delete',
        description: `Deleted item: ${item.item_name} from batch ${item.batch_name?.trim() || 'Unassigned'}`,
        entityId: item.id,
        userId: user?.id,
        details: { item_name: item.item_name, batch_name: item.batch_name },
      })
      setDeletingItem(null)
      showToast(`Item "${item.item_name}" deleted.`)
      loadItems()
    }
  }

  function handleExport() {
    exportToCSV(
      'inventory.csv',
      items.map((item) => ({
        item_name: item.item_name,
        category: item.category,
        batch_name: item.batch_name,
        batch_modal_total: item.batch_modal_total,
        modal_price: getLiveModalPrice(item, items),
        status: item.status,
        notes: item.notes,
        created_at: item.created_at,
      }))
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">Inventory</h1>
          {refreshing && (
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-pink-500" />
              Syncing...
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Export CSV
          </button>
          {canWrite && (
            <button
              onClick={openAddModal}
              className="rounded-md bg-pink-600 px-3 py-2 text-sm font-medium text-white hover:bg-pink-700"
            >
              + Add item(s)
            </button>
          )}
        </div>
      </div>

      {/* Search + filter bar */}
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Search item, category, or batch..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        >
          <option value="">All statuses</option>
          {ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {formatStatus(s)}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk-action bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
        <label className="flex items-center gap-2 text-gray-700">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAll}
            disabled={filtered.length === 0}
            className="h-4 w-4 rounded border-gray-300"
          />
          Select all visible
        </label>
        {selectedItemIds.length > 0 && (
          <>
            <span className="text-gray-500">{selectedItemIds.length} selected</span>
                        {canWrite && (
              <>
                <button
                  onClick={openBulkBookingModal}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
                >
                  Book Selected
                </button>
                <button
                  onClick={handleBulkDelete}
                  disabled={bulkDeleteSaving}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                >
                  Delete Selected
                </button>
              </>
            )}
            <button
              onClick={() => setSelectedItemIds([])}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Grouped inventory table */}
      {loading ? (
        <p className="text-gray-500">Loading inventory...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-400">No items found.</p>
      ) : (
        <div className="space-y-3">
          {grouped.map(([category, catItems]) => {
            const isCollapsed = collapsedCategories.has(category)
            const isSearching = Boolean(search.trim() || statusFilter)
            const limit = isSearching ? catItems.length : (expandedLimits[category] ?? 30)
            const visibleItems = catItems.slice(0, limit)
            const remainingCount = catItems.length - visibleItems.length

            return (
              <div key={category} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                {/* Category header — checkbox is a sibling of (not nested in) the collapse button */}
                <div className="flex w-full items-center gap-3 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">
                  <input
                    type="checkbox"
                    checked={isCategoryFullySelected(catItems)}
                    ref={(el) => {
                      if (el) el.indeterminate = isCategoryPartiallySelected(catItems)
                    }}
                    onChange={() => toggleCategorySelection(catItems)}
                    aria-label={`Select all ${catItems.length} items in ${category}`}
                    className="h-4 w-4 shrink-0 rounded border-gray-300"
                  />
                  <button
                    type="button"
                    onClick={() => toggleCategory(category)}
                    className="flex flex-1 items-center text-left"
                  >
                    {isCollapsed ? '▶' : '▼'} {category}
                    <span className="ml-2 font-normal text-gray-500">({catItems.length})</span>
                  </button>
                </div>

                {/* Item rows */}
                {!isCollapsed && (
                  <>
                    {/* Mobile Cards List (< 768px) */}
                    <div className="space-y-3 p-3 bg-gray-50/50 border-t border-gray-200 md:hidden">
                      {visibleItems.map((item) => (
                        <div key={item.id} className="rounded-lg border border-gray-200 bg-white p-3.5 shadow-sm space-y-2.5">
                          {/* Header: Checkbox + Item Name + Status Badge */}
                          <div className="flex items-start gap-2.5">
                            <input
                              type="checkbox"
                              checked={selectedIdSet.has(item.id)}
                              onChange={() => toggleItemSelection(item.id)}
                              aria-label={`Select ${item.item_name}`}
                              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300"
                            />
                            <div className="min-w-0 flex-1">
                              <button
                                onClick={() => setDrawerItem(item)}
                                className="font-bold text-gray-900 text-base leading-snug break-words hover:text-blue-700 text-left"
                              >
                                {item.item_name}
                              </button>
                            </div>
                            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[item.status]}`}>
                              {formatStatus(item.status)}
                            </span>
                          </div>

                          {/* Details Grid */}
                          <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 bg-gray-50/70 p-2.5 rounded-md">
                            <div>
                              <span className="text-gray-400 block text-[11px]">Batch</span>
                              <span className="font-medium text-gray-800">{item.batch_name ?? '-'}</span>
                            </div>
                            <div>
                              <span className="text-gray-400 block text-[11px]">Category</span>
                              <span className="font-medium text-gray-800">{item.category ?? 'Uncategorized'}</span>
                            </div>
                            <div>
                              <span className="text-gray-400 block text-[11px]">Created</span>
                              <span className="font-medium text-gray-800">{formatDate(item.created_at)}</span>
                            </div>
                          </div>

                          {/* Action Buttons (Min 40px touch targets) */}
                          {canWrite && (
                            <div className="pt-1 flex flex-wrap items-center justify-end gap-2 border-t border-gray-100">
                              <button
                                type="button"
                                onClick={() => openEditModal(item)}
                                className="min-h-[40px] rounded-md border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(item)}
                                className="min-h-[40px] rounded-md border border-red-200 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Desktop Table View (≥ 768px) */}
                    <div className="hidden md:block w-full overflow-x-auto">
                      <table className="w-full min-w-full divide-y divide-gray-100 text-left text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Select</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Item</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Batch</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Status</th>
                            <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600">Created</th>
                            {canWrite && <th className="sticky right-0 z-20 whitespace-nowrap bg-gray-50/95 px-3 py-2 text-left font-medium text-gray-600 backdrop-blur-md shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.05)] dark:bg-zinc-800/95">Actions</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {visibleItems.map((item) => (
                            <tr key={item.id} className="group hover:bg-gray-50">
                              <td className="whitespace-nowrap px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={selectedIdSet.has(item.id)}
                                  onChange={() => toggleItemSelection(item.id)}
                                  aria-label={`Select ${item.item_name}`}
                                  className="h-4 w-4 rounded border-gray-300"
                                />
                              </td>
                              <td className="max-w-[200px] truncate px-3 py-2 sm:max-w-[300px] lg:max-w-[400px]">
                                <button
                                  onClick={() => setDrawerItem(item)}
                                  className="block truncate font-medium text-blue-700 hover:underline"
                                  title={item.item_name}
                                >
                                  {item.item_name}
                                </button>
                              </td>
                              <td className="max-w-[180px] truncate px-3 py-2 text-gray-600 sm:max-w-[250px] lg:max-w-[350px]" title={item.batch_name ?? '-'}>
                                <span className="block truncate">{item.batch_name ?? '-'}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2">
                                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[item.status]}`}>
                                  {formatStatus(item.status)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                                {formatDate(item.created_at)}
                              </td>
                              {canWrite && (
                                <td className="sticky right-0 z-10 whitespace-nowrap bg-white/95 px-3 py-2 backdrop-blur-md shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.05)] group-hover:bg-gray-50/95 dark:bg-zinc-900/95 dark:group-hover:bg-zinc-800/95">
                                  <div className="flex items-center gap-2 whitespace-nowrap">
                                    <button onClick={() => openEditModal(item)} className="text-blue-600 hover:underline">
                                      Edit
                                    </button>
                                    <button onClick={() => handleDelete(item)} className="text-red-600 hover:underline">
                                      Delete
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Show more control when total items exceed visible limit */}
                    {remainingCount > 0 && (
                      <div className="border-t border-gray-100 bg-gray-50/50 p-2.5 text-center">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedLimits((prev) => ({
                              ...prev,
                              [category]: (prev[category] ?? 30) + 50,
                            }))
                          }
                          className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
                        >
                          Show more ({remainingCount} remaining)
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}

          {/* Server-Side Pagination Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
            <div className="text-gray-600">
              Showing <span className="font-medium text-gray-900">{pageFrom}</span> to{' '}
              <span className="font-medium text-gray-900">{pageTo}</span> of{' '}
              <span className="font-medium text-gray-900">{totalCount}</span> items (Page{' '}
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
        </div>
      )}

      {/* Add / Edit Item Modal */}
      {showModal && (
        <Modal
          title={editingId ? 'Edit item' : 'Add inventory items'}
          onClose={() => setShowModal(false)}
          wide={addMode === 'multiple'}
        >
          {/* Mode Selector Tabs (only when adding new items) */}
          {!editingId && (
            <div className="mb-4 flex border-b border-gray-200 text-sm font-medium">
              <button
                type="button"
                onClick={() => setAddMode('single')}
                className={`border-b-2 px-4 py-2 text-sm font-medium ${
                  addMode === 'single'
                    ? 'border-pink-600 text-pink-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Single Item
              </button>
              <button
                type="button"
                onClick={() => setAddMode('multiple')}
                className={`border-b-2 px-4 py-2 text-sm font-medium ${
                  addMode === 'multiple'
                    ? 'border-pink-600 text-pink-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Multiple Items (Bulk Add)
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {addMode === 'single' ? (
              /* Single Item Form */
              <>
                <ItemNameAutocomplete
                  required
                  label="Item name"
                  labelClassName="mb-1 block text-sm font-medium text-gray-700"
                  value={form.item_name}
                  onChange={(name) => setForm((prev) => ({ ...prev, item_name: name }))}
                  onSelectRecord={(rec) => {
                    setForm((prev) => ({
                      ...prev,
                      item_name: rec.item_name,
                      category: rec.category ? rec.category : prev.category,
                      notes: !prev.notes.trim() && rec.notes ? rec.notes : prev.notes,
                    }))
                  }}
                  placeholder="e.g. Hot Wheels 71 Datsun Bluebird U"
                />

                <CategoryAutocomplete
                  required
                  value={form.category}
                  onChange={(cat) => setForm({ ...form, category: cat })}
                />

                <BatchAutocomplete
                  value={form.batch_name}
                  modalTotalValue={form.batch_modal_total}
                  onChange={(batchName, modalTotal) =>
                    setForm({
                      ...form,
                      batch_name: batchName,
                      batch_modal_total: modalTotal ?? form.batch_modal_total,
                    })
                  }
                />

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
                  />
                </div>
              </>
            ) : (
              /* Multiple Items Form */
              <div className="space-y-4">
                {/* Shared Batch Header */}
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <BatchAutocomplete
                    required
                    value={multiBatchName}
                    modalTotalValue={multiBatchModalTotal}
                    onChange={(batchName, modalTotal) => {
                      setMultiBatchName(batchName)
                      if (modalTotal !== undefined) setMultiBatchModalTotal(modalTotal)
                    }}
                    label="Batch for all items below"
                    placeholder="Select or create a batch for these items..."
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    This batch and its modal total will be shared across all items added in this session.
                  </p>
                </div>

                {/* Items Table */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-900">
                      Items list ({multiItems.length})
                    </label>
                    <button
                      type="button"
                      onClick={addMultiRow}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      + Add another item
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(() => {
                      const sessionItemNames = multiItems.map((i) => i.item_name).filter(Boolean)
                      const sessionCategories = multiItems.map((i) => i.category).filter(Boolean)
                      const sessionRecords: ItemSuggestionRecord[] = multiItems
                        .filter((i) => Boolean(i.item_name.trim()))
                        .map((i) => ({
                          item_name: i.item_name.trim(),
                          category: i.category.trim() || undefined,
                          notes: i.notes.trim() || undefined,
                        }))

                      return multiItems.map((itemRow, index) => (
                        <div
                          key={itemRow.id}
                          className="relative z-10 focus-within:z-30 transition-all grid grid-cols-1 gap-2 rounded-md border border-gray-200 p-3 sm:grid-cols-12 sm:items-start"
                        >
                          <div className="sm:col-span-4">
                            <ItemNameAutocomplete
                              required
                              label="Item Name *"
                              placeholder={`Item #${index + 1} name *`}
                              value={itemRow.item_name}
                              onChange={(name) => updateMultiRow(itemRow.id, 'item_name', name)}
                              onSelectRecord={(rec) => {
                                setMultiItems((prev) =>
                                  prev.map((row) => {
                                    if (row.id !== itemRow.id) return row
                                    return {
                                      ...row,
                                      item_name: rec.item_name,
                                      category: rec.category ? rec.category : row.category,
                                      notes: !row.notes.trim() && rec.notes ? rec.notes : row.notes,
                                    }
                                  })
                                )
                              }}
                              extraSuggestions={sessionItemNames}
                              extraRecords={sessionRecords}
                            />
                          </div>

                          <div className="sm:col-span-3">
                            <label className="mb-1 block text-xs font-medium text-gray-600 sm:hidden">
                              Category *
                            </label>
                            <CategoryAutocomplete
                              required
                              label=""
                              placeholder="Category *"
                              value={itemRow.category}
                              onChange={(cat) => updateMultiRow(itemRow.id, 'category', cat)}
                              extraSuggestions={sessionCategories}
                            />
                          </div>

                          <div className="sm:col-span-3">
                            <label className="mb-1 block text-xs font-medium text-gray-600 sm:hidden">
                              Notes
                            </label>
                            <input
                              type="text"
                              value={itemRow.notes}
                              onChange={(e) => updateMultiRow(itemRow.id, 'notes', e.target.value)}
                              placeholder="Notes (optional)"
                              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-500 focus:outline-none"
                            />
                          </div>

                          <div className="sm:col-span-1">
                            <label className="mb-1 block text-xs font-medium text-gray-600 sm:hidden">
                              Qty
                            </label>
                            <input
                              type="number"
                              min={1}
                              value={itemRow.quantity ?? 1}
                              onChange={(e) => updateMultiRow(itemRow.id, 'quantity', e.target.value)}
                              placeholder="Qty"
                              className="w-full rounded-md border border-gray-300 px-1 py-1.5 text-center text-sm focus:border-gray-500 focus:outline-none"
                            />
                          </div>

                          <div className="flex justify-end sm:col-span-1 sm:pt-1">
                            <button
                              type="button"
                              onClick={() => removeMultiRow(itemRow.id)}
                              disabled={multiItems.length === 1}
                              aria-label="Remove item row"
                              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-30"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))
                    })()}
                </div>

                  <button
                    type="button"
                    onClick={addMultiRow}
                    className="w-full rounded-md border border-dashed border-gray-300 py-2 text-center text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50"
                  >
                    + Add another item row
                  </button>
                </div>
              </div>
            )}

            {formError && <p className="text-sm text-red-600">{formError}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || (addMode === 'multiple' && !multiBatchName.trim())}
                className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
              >
                {saving
                  ? 'Saving...'
                  : addMode === 'multiple' && !editingId
                  ? `Save ${
                      multiItems
                        .filter((i) => i.item_name.trim())
                        .reduce((sum, i) => sum + (Math.max(1, parseInt(String(i.quantity), 10) || 1)), 0) ||
                      multiItems.reduce((sum, i) => sum + (Math.max(1, parseInt(String(i.quantity), 10) || 1)), 0)
                    } items`
                  : 'Save item'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Bulk Booking Modal */}
      {showBulkBookingModal && (
        <Modal
          title={`Book ${selectedItems.length} selected item${selectedItems.length === 1 ? '' : 's'}`}
          onClose={() => setShowBulkBookingModal(false)}
        >
          <form onSubmit={handleBulkBookingSubmit} className="space-y-3">
            <BuyerAutocomplete
              required
              value={bulkBookingForm.buyer_name}
              onChange={(buyerName) => setBulkBookingForm({ ...bulkBookingForm, buyer_name: buyerName })}
            />
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Total deal price *</label>
              <FormattedPriceInput
                required
                value={bulkBookingForm.total_deal_price}
                onChange={(price) => setBulkBookingForm({ ...bulkBookingForm, total_deal_price: price })}
              />
            </div>
            <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
              Creates one booking group. Price is split evenly across {selectedItems.length} item{selectedItems.length === 1 ? '' : 's'}.
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Deadline</label>
              <input
                type="date"
                value={bulkBookingForm.deadline}
                onChange={(e) => setBulkBookingForm({ ...bulkBookingForm, deadline: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
              <textarea
                value={bulkBookingForm.notes}
                onChange={(e) => setBulkBookingForm({ ...bulkBookingForm, notes: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            {bulkBookingError && <p className="text-sm text-red-600">{bulkBookingError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowBulkBookingModal(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={bulkBookingSaving}
                className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
              >
                {bulkBookingSaving ? 'Booking...' : 'Create bookings'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Detail Drawer */}
      {drawerItem && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={() => setDrawerItem(null)}>
          <aside
            className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <h2 className="text-lg font-semibold text-gray-900">{drawerItem.item_name}</h2>
                <p className="text-sm text-gray-500">
                  Category: <span className="font-medium text-gray-700">{drawerItem.category ?? '-'}</span>
                </p>
                <p className="text-sm text-gray-500">
                  Batch: <span className="font-medium text-gray-700">{drawerItem.batch_name ?? '-'}</span>
                </p>
                <p className="text-sm text-gray-500">
                  Modal/item: <span className="font-medium text-gray-700">{formatIDR(getLiveModalPrice(drawerItem, items))}</span>
                </p>
                <p className="text-sm text-gray-500">
                  Status:{' '}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[drawerItem.status]}`}>
                    {formatStatus(drawerItem.status)}
                  </span>
                </p>
                {!drawerLoading && (drawerItem.status === 'sold' || drawerResolvedDetails.salePrice !== null || drawerResolvedDetails.buyerName) && (
                  <>
                    <p className="text-sm text-gray-500">
                      Sold price:{' '}
                      <span className="font-medium text-gray-700">
                        {drawerResolvedDetails.salePrice !== null ? formatIDR(drawerResolvedDetails.salePrice) : '-'}
                      </span>
                    </p>
                    <p className="text-sm text-gray-500">
                      Buyer:{' '}
                      <span className="font-medium text-gray-700">{drawerResolvedDetails.buyerName ?? '-'}</span>
                    </p>
                  </>
                )}
                <p className="text-sm text-gray-500">Added: {formatDate(drawerItem.created_at)}</p>
                {drawerItem.notes && (
                  <p className="text-sm text-gray-500">Notes: {drawerItem.notes}</p>
                )}
              </div>
              <button
                onClick={() => setDrawerItem(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>

            {drawerLoading ? (
              <p className="text-sm text-gray-500">Loading history...</p>
            ) : (
              <div className="space-y-5">
                <section>
                  <h3 className="mb-2 font-medium text-gray-900">Booking History</h3>
                  {drawerBookings.length === 0 ? (
                    <p className="text-sm text-gray-400">No bookings found.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {drawerBookings.map((booking) => (
                        <li key={booking.id} className="rounded-md border border-gray-200 p-3">
                          <p className="font-medium text-gray-800">{booking.buyer_name}</p>
                          <p className="text-gray-500">Deal: {formatIDR(booking.deal_price)}</p>
                          <p className="text-gray-500">Booking date: {formatDate(booking.created_at)}</p>
                          <p className="text-gray-500">
                            Status:{' '}
                            <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[booking.status]}`}>
                              {formatStatus(booking.status)}
                            </span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="mb-2 font-medium text-gray-900">Sales History</h3>
                  {drawerSales.length === 0 ? (
                    drawerItem.status === 'sold' && (drawerResolvedDetails.salePrice !== null || drawerResolvedDetails.buyerName) ? (
                      <div className="rounded-md border border-gray-200 p-3 text-sm">
                        <p className="font-medium text-gray-800">{drawerResolvedDetails.buyerName ?? '-'}</p>
                        <p className="text-gray-500">
                          Sale price: {drawerResolvedDetails.salePrice !== null ? formatIDR(drawerResolvedDetails.salePrice) : '-'}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-400">No sales found.</p>
                    )
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {drawerSales.map((sale) => {
                        const effectiveSalePrice =
                          sale.sale_price > 0
                            ? sale.sale_price
                            : (drawerResolvedDetails.salePrice ?? sale.sale_price)
                        const effectiveBuyerName =
                          sale.buyer_name?.trim() || drawerResolvedDetails.buyerName || '-'
                        return (
                          <li key={sale.id} className="rounded-md border border-gray-200 p-3">
                            <p className="font-medium text-gray-800">{effectiveBuyerName}</p>
                            <p className="text-gray-500">Sale date: {formatDate(sale.sale_date)}</p>
                            <p className="text-gray-500">Sale price: {formatIDR(effectiveSalePrice)}</p>
                            <p className="text-gray-500">Gross profit: {formatIDR(sale.gross_profit)}</p>
                            <p className="text-gray-500">Net profit: {formatIDR(sale.net_profit)}</p>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </aside>
        </div>
      )}

      {deletingItem && (
        <Modal title="Delete inventory item?" onClose={() => setDeletingItem(null)}>
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              Are you sure you want to delete <strong>&ldquo;{deletingItem.item_name}&rdquo;</strong>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeletingItem(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteItem()}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
