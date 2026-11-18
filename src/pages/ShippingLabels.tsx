import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/supabasePagination'
import { useDataInvalidation } from '../lib/dataSync'
import { useToast } from '../lib/toast'
import Modal from '../components/Modal'
import BuyerAutocomplete from '../components/BuyerAutocomplete'
import type { BuyerAddress } from '../types/database'

interface MergedBuyer {
  /** Normalized lowercase key for case-insensitive deduplication */
  key: string
  /** Canonical display / primary key buyer_name */
  buyer_name: string
  /** Free-text shipping address */
  address_text: string
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const AUTO_SAVE_DEBOUNCE_MS = 1500
const PAGE_SIZE = 100

export default function ShippingLabels() {
  const { showToast } = useToast()

  // Merged buyer list state
  const [buyers, setBuyers] = useState<MergedBuyer[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Search & filter state
  const [searchInput, setSearchInput] = useState('')
  const [showOnlyWithAddress, setShowOnlyWithAddress] = useState(false)
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)
  const [page, setPage] = useState(1)

  // Persistent selection state (stores normalized lowercase buyer `key`)
  const [selectedBuyers, setSelectedBuyers] = useState<Set<string>>(new Set())

  // Per-buyer auto-save state & timers
  const [saveStatuses, setSaveStatuses] = useState<Record<string, SaveStatus>>({})
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const pendingPayloadsRef = useRef<Map<string, { buyer_name: string; address_text: string }>>(new Map())
  const lastSavedAddressesRef = useRef<Map<string, string>>(new Map())

  // Add New Buyer Modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [newBuyerName, setNewBuyerName] = useState('')
  const [newBuyerAddress, setNewBuyerAddress] = useState('')
  const [addingBuyer, setAddingBuyer] = useState(false)

  // Continuous 80mm thermal roll dynamic print height state & ref
  const printContainerRef = useRef<HTMLDivElement>(null)
  const [printHeightMm, setPrintHeightMm] = useState<number>(100)

  // ── Data Fetching & Merging (Egress-Safe) ──────────────────────────────────

  const loadData = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true)
    setFetchError(null)
    try {
      const addressesPromise = fetchAllRows<BuyerAddress>(
        (from, to) =>
          supabase
            .from('buyer_addresses')
            .select('buyer_name, address_text, created_at, updated_at')
            .order('buyer_name', { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: BuyerAddress[] | null
            error: { message: string } | null
          }>,
        1000
      )

      // Prefer the pre-aggregated `buyer_summaries` view (1 distinct row per buyer) to avoid
      // scanning thousands of individual sales and bookings rows; fall back if unavailable.
      let distinctBuyerRows: { buyer_name: string }[] = []
      try {
        distinctBuyerRows = await fetchAllRows<{ buyer_name: string }>(
          (from, to) =>
            supabase
              .from('buyer_summaries')
              .select('buyer_name')
              .order('buyer_name', { ascending: true })
              .range(from, to) as unknown as PromiseLike<{
              data: { buyer_name: string }[] | null
              error: { message: string } | null
            }>,
          1000
        )
      } catch {
        const [salesBuyerRows, bookingsBuyerRows] = await Promise.all([
          fetchAllRows<{ buyer_name: string }>(
            (from, to) =>
              supabase
                .from('sales')
                .select('buyer_name')
                .range(from, to) as unknown as PromiseLike<{
                data: { buyer_name: string }[] | null
                error: { message: string } | null
              }>,
            1000
          ),
          fetchAllRows<{ buyer_name: string }>(
            (from, to) =>
              supabase
                .from('bookings')
                .select('buyer_name')
                .range(from, to) as unknown as PromiseLike<{
                data: { buyer_name: string }[] | null
                error: { message: string } | null
              }>,
            1000
          ),
        ])
        distinctBuyerRows = [...bookingsBuyerRows, ...salesBuyerRows]
      }

      const addressesRows = await addressesPromise

      const map = new Map<string, MergedBuyer>()

      // 1. Seed from buyer_addresses first so existing primary keys & addresses take priority
      for (const row of addressesRows) {
        const trimmed = row.buyer_name?.trim()
        if (!trimmed) continue
        const key = trimmed.toLowerCase()
        const existing = map.get(key)
        if (!existing || (row.address_text && !existing.address_text)) {
          map.set(key, {
            key,
            buyer_name: row.buyer_name,
            address_text: row.address_text ?? '',
          })
        }
      }

      // 2. Merge distinct buyer_name from bookings & sales
      for (const row of distinctBuyerRows) {
        const trimmed = row.buyer_name?.trim()
        if (!trimmed) continue
        const key = trimmed.toLowerCase()
        if (!map.has(key)) {
          map.set(key, {
            key,
            buyer_name: trimmed,
            address_text: '',
          })
        }
      }

      // Preserve any unsaved local edits currently pending in debounce
      for (const [key, buy] of map.entries()) {
        if (!pendingPayloadsRef.current.has(key)) {
          lastSavedAddressesRef.current.set(key, buy.address_text)
        }
      }
      for (const [key, pending] of pendingPayloadsRef.current.entries()) {
        map.set(key, {
          key,
          buyer_name: pending.buyer_name,
          address_text: pending.address_text,
        })
      }

      const merged = [...map.values()].sort((a, b) =>
        a.buyer_name.localeCompare(b.buyer_name, undefined, { sensitivity: 'base' })
      )

      setBuyers(merged)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load buyer addresses.')
    } finally {
      if (isInitial) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData(true)
  }, [loadData])

  useDataInvalidation(
    ['bookings', 'sales', 'buyer_addresses'],
    () => {
      void loadData(false)
    },
    { remoteOnly: true }
  )

  // Cleanup any active debounce timers on unmount
  useEffect(() => {
    const timers = debounceTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
    }
  }, [])

  // ── Auto-Save Logic (Upsert to buyer_addresses) ────────────────────────────

  const saveAddressToSupabase = useCallback(
    async (key: string, buyer_name: string, address_text: string) => {
      pendingPayloadsRef.current.delete(key)

      // Skip upsert if text has not actually changed from the last saved value
      const lastSaved = lastSavedAddressesRef.current.get(key) ?? ''
      if (address_text === lastSaved) {
        setSaveStatuses((prev) => ({ ...prev, [key]: 'idle' }))
        return
      }

      setSaveStatuses((prev) => ({ ...prev, [key]: 'saving' }))

      const { error } = await supabase.from('buyer_addresses').upsert(
        {
          buyer_name,
          address_text,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'buyer_name' }
      )

      if (error) {
        setSaveStatuses((prev) => ({ ...prev, [key]: 'error' }))
        showToast(`Failed to save address for ${buyer_name}: ${error.message}`, 'error')
        return
      }

      lastSavedAddressesRef.current.set(key, address_text)
      setSaveStatuses((prev) => ({ ...prev, [key]: 'saved' }))
    },
    [showToast]
  )

  function handleAddressChange(buyer: MergedBuyer, newText: string) {
    // Smooth local state update
    setBuyers((prev) =>
      prev.map((b) => (b.key === buyer.key ? { ...b, address_text: newText } : b))
    )

    const existingTimer = debounceTimersRef.current.get(buyer.key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      debounceTimersRef.current.delete(buyer.key)
    }

    // If reverted back to last saved value, cancel pending save without hitting Supabase
    const lastSaved = lastSavedAddressesRef.current.get(buyer.key) ?? ''
    if (newText === lastSaved) {
      pendingPayloadsRef.current.delete(buyer.key)
      setSaveStatuses((prev) => ({ ...prev, [buyer.key]: 'idle' }))
      return
    }

    // Track pending change and schedule debounced upsert (1500ms)
    pendingPayloadsRef.current.set(buyer.key, {
      buyer_name: buyer.buyer_name,
      address_text: newText,
    })
    setSaveStatuses((prev) => ({ ...prev, [buyer.key]: 'saving' }))

    const timer = setTimeout(() => {
      debounceTimersRef.current.delete(buyer.key)
      void saveAddressToSupabase(buyer.key, buyer.buyer_name, newText)
    }, AUTO_SAVE_DEBOUNCE_MS)

    debounceTimersRef.current.set(buyer.key, timer)
  }

  function handleAddressBlur(buyer: MergedBuyer) {
    const existingTimer = debounceTimersRef.current.get(buyer.key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      debounceTimersRef.current.delete(buyer.key)
    }
    const pending = pendingPayloadsRef.current.get(buyer.key)
    if (pending) {
      void saveAddressToSupabase(buyer.key, pending.buyer_name, pending.address_text)
    }
  }

  // ── Manual Add Buyer Address ───────────────────────────────────────────────

  async function handleAddNewBuyer(e: React.FormEvent) {
    e.preventDefault()
    const trimmedName = newBuyerName.trim()
    if (!trimmedName) {
      showToast('Buyer name is required.', 'error')
      return
    }

    setAddingBuyer(true)
    const key = trimmedName.toLowerCase()
    const existing = buyers.find((b) => b.key === key)
    const canonicalName = existing ? existing.buyer_name : trimmedName

    const { error } = await supabase.from('buyer_addresses').upsert(
      {
        buyer_name: canonicalName,
        address_text: newBuyerAddress,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'buyer_name' }
    )

    setAddingBuyer(false)

    if (error) {
      showToast(`Failed to save buyer: ${error.message}`, 'error')
      return
    }

    setBuyers((prev) => {
      const exists = prev.some((b) => b.key === key)
      const next = exists
        ? prev.map((b) =>
            b.key === key ? { ...b, address_text: newBuyerAddress } : b
          )
        : [
            ...prev,
            {
              key,
              buyer_name: canonicalName,
              address_text: newBuyerAddress,
            },
          ]
      return next.sort((a, b) =>
        a.buyer_name.localeCompare(b.buyer_name, undefined, { sensitivity: 'base' })
      )
    })

    lastSavedAddressesRef.current.set(key, newBuyerAddress)
    setSaveStatuses((prev) => ({ ...prev, [key]: 'saved' }))
    showToast(`Address saved for ${canonicalName}.`, 'success')
    setNewBuyerName('')
    setNewBuyerAddress('')
    setIsAddModalOpen(false)
  }

  const existingBuyerNames = useMemo(
    () => buyers.map((b) => b.buyer_name),
    [buyers]
  )

  // ── Multi-Buyer Search & Filtering ─────────────────────────────────────────

  const searchTerms = useMemo(
    () =>
      searchInput
        .toLowerCase()
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [searchInput]
  )

  const filteredBuyers = useMemo(() => {
    return buyers.filter((buyer) => {
      if (showOnlyWithAddress && buyer.address_text.trim().length === 0) {
        return false
      }
      if (showSelectedOnly && !selectedBuyers.has(buyer.key)) {
        return false
      }
      if (searchTerms.length > 0) {
        const lowerName = buyer.buyer_name.toLowerCase()
        const matchesAny = searchTerms.some((term) => lowerName.includes(term))
        if (!matchesAny) return false
      }
      return true
    })
  }, [buyers, showOnlyWithAddress, showSelectedOnly, selectedBuyers, searchTerms])

  // Pagination for smooth rendering when hundreds of buyers exist
  const totalPages = Math.max(1, Math.ceil(filteredBuyers.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginatedBuyers = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return filteredBuyers.slice(start, start + PAGE_SIZE)
  }, [filteredBuyers, safePage])

  // ── Persistent Selection Helpers ───────────────────────────────────────────

  function toggleBuyerSelection(key: string) {
    setSelectedBuyers((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // "Select All Visible" operates across all currently filtered rows
  const allVisibleSelected =
    filteredBuyers.length > 0 &&
    filteredBuyers.every((b) => selectedBuyers.has(b.key))

  function handleToggleSelectAllVisible() {
    setSelectedBuyers((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const b of filteredBuyers) {
          next.delete(b.key)
        }
      } else {
        for (const b of filteredBuyers) {
          next.add(b.key)
        }
      }
      return next
    })
  }

  function handleClearSelection() {
    setSelectedBuyers(new Set())
  }

  // ── Selected Buyers for Print ──────────────────────────────────────────────

  const printableSelectedBuyers = useMemo(() => {
    return buyers.filter(
      (b) => selectedBuyers.has(b.key) && b.address_text.trim().length > 0
    )
  }, [buyers, selectedBuyers])

  function handlePrintSelected() {
    if (selectedBuyers.size === 0) return
    if (printableSelectedBuyers.length === 0) {
      showToast(
        'Selected buyers have empty addresses. Please enter an address before printing.',
        'error'
      )
      return
    }
    const pxHeight = printContainerRef.current?.scrollHeight || 300
    const calculatedMm = Math.max(30, Math.ceil((pxHeight * 25.4) / 96) + 4)
    setPrintHeightMm(calculatedMm)
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.print()
      }, 50)
    })
  }

  const savedCount = useMemo(
    () => buyers.filter((b) => b.address_text.trim().length > 0).length,
    [buyers]
  )

  return (
    <>
      {/* ── Main Screen View (Hidden when printing) ───────────────────────── */}
      <div className="space-y-4 print:hidden">
        {/* Header & Top Action Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Alamat</h1>
            <p className="text-xs text-gray-500">
              {buyers.length} total buyers ({savedCount} with saved address)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              className="rounded-md border border-pink-200 bg-pink-50 px-3 py-2 text-sm font-medium text-pink-800 hover:bg-pink-100 transition-colors"
            >
              + Add Buyer Address
            </button>

            {selectedBuyers.size > 0 && (
              <button
                type="button"
                onClick={handleClearSelection}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Clear Selection
              </button>
            )}

            <button
              type="button"
              disabled={selectedBuyers.size === 0}
              onClick={handlePrintSelected}
              className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-pink-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            >
              Print Selected ({selectedBuyers.size})
            </button>
          </div>
        </div>

        {/* Multi-Line / Comma Search & Filter Card */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor="multi-buyer-search"
                  className="block text-xs font-medium text-gray-700"
                >
                  Multi Search
                </label>
                {searchInput.trim().length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('')
                      setPage(1)
                    }}
                    className="text-xs font-medium text-pink-600 hover:text-pink-800"
                  >
                    Clear search ({searchTerms.length}{' '}
                    {searchTerms.length === 1 ? 'orang' : 'orangs'})
                  </button>
                )}
              </div>
              <textarea
                id="multi-buyer-search"
                rows={3}
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value)
                  setPage(1)
                }}
                placeholder={
                  'Paste name buyer buat search enter atau pake commas...\n- Contoh Enter:\nJason\nTumpal\n- Contoh Comma:\n Jason,Tumpal'
                }
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-pink-500 focus:outline-none"
              />
            </div>

            <div className="flex flex-col justify-between gap-3 rounded-md bg-gray-50 p-3 border border-gray-100">
              <div className="space-y-2.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Filters
                </p>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showOnlyWithAddress}
                    onChange={(e) => {
                      setShowOnlyWithAddress(e.target.checked)
                      setPage(1)
                    }}
                    className="h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500 cursor-pointer"
                  />
                  Show only with saved address
                </label>

                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showSelectedOnly}
                    onChange={(e) => {
                      setShowSelectedOnly(e.target.checked)
                      setPage(1)
                    }}
                    className="h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500 cursor-pointer"
                  />
                  Show selected only ({selectedBuyers.size})
                </label>
              </div>

              <div className="border-t border-gray-200 pt-2 text-xs text-gray-500 flex items-center justify-between">
                <span>
                  Matching rows: <strong className="text-gray-800">{filteredBuyers.length}</strong>
                </span>
                <span>
                  Printable selected:{' '}
                  <strong className="text-pink-700">{printableSelectedBuyers.length}</strong>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Error & Loading States */}
        {fetchError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {fetchError}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500 shadow-sm">
            Loading buyers & shipping addresses...
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="w-12 px-4 py-3 text-left">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        disabled={filteredBuyers.length === 0}
                        onChange={handleToggleSelectAllVisible}
                        title="Select or unselect all visible buyers"
                        aria-label="Select all visible buyers"
                        className="h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500 disabled:opacity-40 cursor-pointer"
                      />
                    </div>
                  </th>
                  <th className="w-64 whitespace-nowrap px-4 py-3 text-left font-medium text-gray-600">
                    Buyer Name
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    Shipping Address (Lgsg copas alamat di kotak ini)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {paginatedBuyers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-10 text-center text-gray-400">
                      No buyers match your current search or filters.
                    </td>
                  </tr>
                ) : (
                  paginatedBuyers.map((buyer) => {
                    const isSelected = selectedBuyers.has(buyer.key)
                    const hasAddress = buyer.address_text.trim().length > 0
                    const saveStatus = saveStatuses[buyer.key] ?? 'idle'

                    return (
                      <tr
                        key={buyer.key}
                        className={`align-top transition-colors ${
                          isSelected ? 'bg-pink-50/40' : 'hover:bg-gray-50/70'
                        }`}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleBuyerSelection(buyer.key)}
                            aria-label={`Select ${buyer.buyer_name}`}
                            className="mt-1 h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500 cursor-pointer"
                          />
                        </td>

                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1.5">
                            <span className="font-medium text-gray-900 break-words">
                              {buyer.buyer_name}
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {hasAddress ? (
                                <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">
                                  Saved
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                                  Empty
                                </span>
                              )}

                              {saveStatus === 'saving' && (
                                <span className="text-[11px] text-amber-600 font-medium">
                                  Saving...
                                </span>
                              )}
                              {saveStatus === 'saved' && (
                                <span className="text-[11px] text-green-600 font-medium">
                                  Saved ✓
                                </span>
                              )}
                              {saveStatus === 'error' && (
                                <span className="text-[11px] text-red-600 font-medium">
                                  Save error
                                </span>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="px-4 py-3">
                          <textarea
                            rows={3}
                            value={buyer.address_text}
                            onChange={(e) => handleAddressChange(buyer, e.target.value)}
                            onBlur={() => handleAddressBlur(buyer)}
                            placeholder={`Paste full shipping label text for ${buyer.buyer_name} (name, phone, full address)...`}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-pink-500 focus:outline-none"
                          />
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Controls */}
        {!loading && filteredBuyers.length > PAGE_SIZE && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm">
            <div className="text-gray-600">
              Showing{' '}
              <span className="font-medium text-gray-900">
                {(safePage - 1) * PAGE_SIZE + 1}
              </span>{' '}
              to{' '}
              <span className="font-medium text-gray-900">
                {Math.min(filteredBuyers.length, safePage * PAGE_SIZE)}
              </span>{' '}
              of <span className="font-medium text-gray-900">{filteredBuyers.length}</span>{' '}
              buyers (Page <span className="font-medium text-gray-900">{safePage}</span> of{' '}
              <span className="font-medium text-gray-900">{totalPages}</span>)
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous Page
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next Page
              </button>
            </div>
          </div>
        )}

        {/* Add Buyer Address Modal */}
        {isAddModalOpen && (
          <Modal
            title="Add Buyer Shipping Address"
            onClose={() => !addingBuyer && setIsAddModalOpen(false)}
          >
            <form onSubmit={(e) => void handleAddNewBuyer(e)} className="space-y-4">
              <BuyerAutocomplete
                label="Buyer Name *"
                required
                value={newBuyerName}
                onChange={setNewBuyerName}
                placeholder="e.g. Budi Santoso"
                existingBuyers={existingBuyerNames}
              />

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Shipping Address (Free-Text)
                </label>
                <textarea
                  rows={4}
                  value={newBuyerAddress}
                  onChange={(e) => setNewBuyerAddress(e.target.value)}
                  placeholder="Paste full WhatsApp shipping address..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-pink-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={addingBuyer}
                  onClick={() => setIsAddModalOpen(false)}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addingBuyer}
                  className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
                >
                  {addingBuyer ? 'Saving...' : 'Save Buyer Address'}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </div>

      {/* ── Print-Only View (STRICTLY ADDRESS TEXT ONLY — 80mm Continuous Roll) ──── */}
      <style type="text/css">
        {`
          @media print {
            @page {
              size: 80mm ${printHeightMm}mm;
              margin: 0mm;
            }
            html, body {
              width: 80mm !important;
              margin: 0 !important;
              padding: 0 !important;
              background: #ffffff !important;
            }
          }
        `}
      </style>
      <div
        ref={printContainerRef}
        className="fixed -left-[9999px] top-0 w-[80mm] opacity-0 pointer-events-none print:static print:left-auto print:top-auto print:opacity-100 print:pointer-events-auto print:block bg-white"
      >
        <div className="px-[3mm] py-[1.5mm]">
          {printableSelectedBuyers.map((buyer) => (
            <div
              key={buyer.key}
              className="w-full text-center text-[9pt] font-medium text-black leading-[1.15] whitespace-pre-wrap break-words mb-[2.5mm] last:mb-0"
            >
              {buyer.address_text}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
