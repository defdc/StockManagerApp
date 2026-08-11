import { useEffect, useState, type ChangeEvent } from 'react'
import type * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { formatDateTime, formatIDR, formatStatus } from '../lib/format'
import { STATUS_BADGE_CLASSES } from '../lib/constants'
import { logActivity } from '../lib/activityLog'
import Modal from '../components/Modal'
import {
  detectBatchModals,
  detectStockColumns,
  evaluateStockRow,
  getSheetGrid,
  guessCategoryFromSheetName,
  readWorkbook,
  sanitizeLegacyRows,
  buildRawJson,
} from '../lib/legacyImport'
import {
  fetchExistingBuyerNames,
  matchBuyerName,
  type BuyerMatchResult,
} from '../lib/buyers'
import type { InventoryItem, LegacyImport } from '../types/database'

const CHUNK_SIZE = 300

interface ImportResult {
  totalRows: number
  cleanRows: number
  skippedRows: number
  missingModal: number
  rowsWithBookedValue: number
  bookingRecordsCreated: number
  inventoryRowsMarkedBooked: number
  rowsWithBatch: number
  rowsWithBatchModalTotal: number
  rowsWithCalculatedBatchModal: number
}

interface PricedPreviewRow {
  rowNumber: number
  itemName: string
  quantity: number
  batchName: string | null
  batchModalTotal: number | null
  modalPrice: number | null
  bookedAmount: number | null
}

export default function ImportExcel() {
  const { user, canWrite } = useAuth()
  const { showToast } = useToast()
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [fileName, setFileName] = useState('')
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [previewHeader, setPreviewHeader] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<unknown[][]>([])
  const [pricedPreviewRows, setPricedPreviewRows] = useState<PricedPreviewRow[]>([])

  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [pastImports, setPastImports] = useState<LegacyImport[]>([])

  // Buyer resolution states
  const [buyerMatches, setBuyerMatches] = useState<BuyerMatchResult[]>([])
  const [resolvedBuyers, setResolvedBuyers] = useState<Map<string, string>>(new Map())
  const [existingBuyerNames, setExistingBuyerNames] = useState<string[]>([])
  const [loadingBuyerMatches, setLoadingBuyerMatches] = useState(false)

  // View Items Modal state
  const [viewImport, setViewImport] = useState<LegacyImport | null>(null)
  const [viewItems, setViewItems] = useState<InventoryItem[]>([])
  const [viewLoading, setViewLoading] = useState(false)

  // Delete Import Modal state
  const [deleteTargetImport, setDeleteTargetImport] = useState<LegacyImport | null>(null)
  const [deletePreview, setDeletePreview] = useState<{
    readyItems: InventoryItem[]
    bookedItems: InventoryItem[]
    soldItems: InventoryItem[]
  } | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function loadPastImports() {
    const { data } = await supabase
      .from('legacy_imports')
      .select('*')
      .order('created_at', { ascending: false })
    setPastImports(data ?? [])
  }

  useEffect(() => {
    loadPastImports()
  }, [])

  async function fetchImportItems(imp: LegacyImport): Promise<InventoryItem[]> {
    // 1. Try matching by legacy_import_id
    const { data: directItems } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('legacy_import_id', imp.id)
      .order('created_at', { ascending: true })

    if (directItems && directItems.length > 0) return directItems

    // 2. Legacy Fallback: Match by timestamp range (within 10 mins of import created_at)
    const importTime = new Date(imp.created_at).getTime()
    const startTime = new Date(importTime - 2 * 60 * 1000).toISOString()
    const endTime = new Date(importTime + 10 * 60 * 1000).toISOString()

    const { data: timeItems } = await supabase
      .from('inventory_items')
      .select('*')
      .gte('created_at', startTime)
      .lte('created_at', endTime)
      .order('created_at', { ascending: true })

    return timeItems ?? []
  }

  async function openViewItemsModal(imp: LegacyImport) {
    setViewImport(imp)
    setViewLoading(true)
    const items = await fetchImportItems(imp)
    setViewItems(items)
    setViewLoading(false)
  }

  async function openDeleteModal(imp: LegacyImport) {
    setDeleteTargetImport(imp)
    setDeleteLoading(true)
    setDeletePreview(null)

    const itemList = await fetchImportItems(imp)
    const itemIds = itemList.map((i) => i.id)

    let salesItemIds = new Set<string>()
    if (itemIds.length > 0) {
      const { data: sales } = await supabase
        .from('sales')
        .select('inventory_item_id')
        .in('inventory_item_id', itemIds)
      salesItemIds = new Set((sales ?? []).map((s) => s.inventory_item_id as string))
    }

    const readyItems: InventoryItem[] = []
    const bookedItems: InventoryItem[] = []
    const soldItems: InventoryItem[] = []

    for (const item of itemList) {
      if (salesItemIds.has(item.id) || item.status === 'sold') {
        soldItems.push(item)
      } else if (item.status === 'booked') {
        bookedItems.push(item)
      } else {
        readyItems.push(item)
      }
    }

    setDeletePreview({ readyItems, bookedItems, soldItems })
    setDeleteLoading(false)
  }

  async function confirmDeleteImport() {
    if (!deleteTargetImport || !deletePreview) return
    setDeleting(true)

    const impId = deleteTargetImport.id
    const deleteItemIds = [
      ...deletePreview.readyItems.map((i) => i.id),
      ...deletePreview.bookedItems.map((i) => i.id),
    ]

    try {
      // Step 1: Delete linked bookings (both by inventory_item_id AND by legacy_import_id directly)
      if (deleteItemIds.length > 0) {
        const { error: bookingErr } = await supabase
          .from('bookings')
          .delete()
          .in('inventory_item_id', deleteItemIds)

        if (bookingErr) throw new Error(`Failed to delete bookings by item: ${bookingErr.message}`)
      }

      const { error: legacyBookingErr } = await supabase
        .from('bookings')
        .delete()
        .eq('legacy_import_id', impId)

      if (legacyBookingErr) {
        console.warn('Could not delete bookings by legacy_import_id:', legacyBookingErr.message)
      }

      // Step 2: Unlink legacy_rows.mapped_inventory_item_id FIRST to prevent FK violations when inventory_items are deleted
      const { error: rowsUnlinkErr } = await supabase
        .from('legacy_rows')
        .update({ mapped_inventory_item_id: null })
        .eq('legacy_import_id', impId)

      if (rowsUnlinkErr) {
        console.warn('Could not unlink legacy_rows by import_id:', rowsUnlinkErr.message)
      }

      if (deleteItemIds.length > 0) {
        const { error: rowsItemUnlinkErr } = await supabase
          .from('legacy_rows')
          .update({ mapped_inventory_item_id: null })
          .in('mapped_inventory_item_id', deleteItemIds)

        if (rowsItemUnlinkErr) {
          console.warn('Could not unlink legacy_rows by mapped_inventory_item_id:', rowsItemUnlinkErr.message)
        }

        // Step 3: Unlink inventory_items own FKs (legacy_row_id = null, legacy_import_id = null)
        const { error: unlinkErr } = await supabase
          .from('inventory_items')
          .update({ legacy_row_id: null, legacy_import_id: null })
          .in('id', deleteItemIds)

        if (unlinkErr) throw new Error(`Failed to unlink inventory items: ${unlinkErr.message}`)

        // Step 4: Delete inventory_items
        const { error: itemErr } = await supabase
          .from('inventory_items')
          .delete()
          .in('id', deleteItemIds)

        if (itemErr) throw new Error(`Failed to delete inventory items: ${itemErr.message}`)
      }

      // Step 5: Mark legacy_imports as status = 'reverted' (reverted_at = now())
      const { error: impUpdateErr } = await supabase
        .from('legacy_imports')
        .update({
          status: 'reverted',
          reverted_at: new Date().toISOString(),
        })
        .eq('id', impId)

      if (impUpdateErr) throw new Error(`Failed to update import history record: ${impUpdateErr.message}`)

      void logActivity({
        action: 'Revert Import',
        entity: 'legacy_imports',
        entityId: impId,
        userId: user?.id,
        details: {
          file_name: deleteTargetImport.file_name,
          deleted_items: deleteItemIds.length,
          skipped_sold: deletePreview.soldItems.length,
        },
      })

      setDeleteTargetImport(null)
      loadPastImports()
    } catch (err) {
      console.error('Revert import failed:', err)
      showToast(err instanceof Error ? err.message : 'Failed to revert import', 'error')
    } finally {
      setDeleting(false)
    }
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setResult(null)
    setFileName(file.name)
    try {
      const wb = await readWorkbook(file)
      setWorkbook(wb)
      setSheetNames(wb.SheetNames)
      const firstSheet = wb.SheetNames[0]
      setSelectedSheet(firstSheet)
      void loadPreview(wb, firstSheet)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read the Excel file.')
    }
  }

  async function loadPreview(wb: XLSX.WorkBook, sheetName: string) {
    const { header, rows, merges } = getSheetGrid(wb, sheetName)
    const stockIdx = detectStockColumns(header)
    const batchByRow = detectBatchModals(rows, merges, stockIdx)

    const uniqueBuyerNames = new Set<string>()
    const pricedRows = rows.flatMap((row, index): PricedPreviewRow[] => {
      const evaluation = evaluateStockRow(row, stockIdx, batchByRow.get(index) ?? null)
      if (evaluation.skip || (evaluation.missingModal && !evaluation.bookedAmount && !evaluation.batchName)) {
        return []
      }
      if (evaluation.buyerName && evaluation.buyerName !== 'Imported booking') {
        uniqueBuyerNames.add(evaluation.buyerName)
      }
      return [
        {
          rowNumber: index + 2,
          itemName: evaluation.itemName,
          quantity: evaluation.quantity,
          batchName: evaluation.batchName,
          batchModalTotal: evaluation.batchModalTotal,
          modalPrice: evaluation.missingModal ? null : evaluation.modalPrice,
          bookedAmount: evaluation.bookedAmount,
        },
      ]
    })
    const bookedRows = pricedRows.filter((row) => row.bookedAmount !== null)
    const otherPricedRows = pricedRows.filter((row) => row.bookedAmount === null)

    setPreviewHeader(header)
    setPreviewRows(rows.slice(0, 20))
    setPricedPreviewRows([...bookedRows, ...otherPricedRows].slice(0, 10))

    if (stockIdx.buyerName >= 0 && uniqueBuyerNames.size > 0) {
      setLoadingBuyerMatches(true)
      try {
        const existing = await fetchExistingBuyerNames()
        setExistingBuyerNames(existing)

        const matches: BuyerMatchResult[] = []
        const initialResolved = new Map<string, string>()

        for (const importedName of uniqueBuyerNames) {
          const res = matchBuyerName(importedName, existing)
          matches.push(res)
          initialResolved.set(importedName, res.selectedName)
        }

        setBuyerMatches(matches)
        setResolvedBuyers(initialResolved)
      } catch (e) {
        console.error('Failed to match buyers:', e)
      } finally {
        setLoadingBuyerMatches(false)
      }
    } else {
      setBuyerMatches([])
      setResolvedBuyers(new Map())
    }
  }

  function handleSheetSelect(name: string) {
    setSelectedSheet(name)
    setResult(null)
    if (workbook) void loadPreview(workbook, name)
  }

  async function handleImport() {
    if (!workbook || !selectedSheet || !user) return
    setImporting(true)
    setError(null)
    setResult(null)

    try {
      const { header, rows, rawHeader, rawRows, merges } = getSheetGrid(workbook, selectedSheet)
      const stockIdx = detectStockColumns(header)
      const batchByRow = detectBatchModals(rows, merges, stockIdx)
      const category = guessCategoryFromSheetName(selectedSheet)

      const { data: importRow, error: importError } = await supabase
        .from('legacy_imports')
        .insert({
          file_name: fileName,
          sheet_name: selectedSheet,
          uploaded_by: user.id,
          total_rows: rows.length,
          clean_rows_created: 0,
          skipped_rows: 0,
        })
        .select()
        .single()

      if (importError || !importRow) {
        throw new Error(importError?.message ?? 'Failed to create import record.')
      }

      setProgress({ done: 0, total: rows.length })

      let cleanRows = 0
      let skippedRows = 0
      let missingModal = 0
      let rowsWithBookedValue = 0
      let bookingRecordsCreated = 0
      let inventoryRowsMarkedBooked = 0
      let rowsWithBatch = 0
      let rowsWithBatchModalTotal = 0
      let rowsWithCalculatedBatchModal = 0

      for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
        const chunk = rows.slice(start, start + CHUNK_SIZE)
        const rawChunk = rawRows.slice(start, start + CHUNK_SIZE)

        const legacyRowsPayload = rawChunk.map((row, i) => ({
          legacy_import_id: importRow.id,
          sheet_name: selectedSheet,
          row_number: start + i + 2, // +1 for header row, +1 for 1-based numbering
          raw_json: buildRawJson(rawHeader, row),
        }))

        const missingRawJsonBefore = legacyRowsPayload.filter(
          (r) => !r.raw_json || typeof r.raw_json !== 'object'
        ).length

        // Never pass legacyRowsPayload straight into insert() — sanitize first so a sparse
        // array or a bad raw_json can't reach the NOT NULL column as null/undefined.
        const sanitizedLegacyRows = sanitizeLegacyRows(legacyRowsPayload)

        const missingRawJsonAfter = sanitizedLegacyRows.filter((r) => !r.raw_json).length
        console.log(
          `[import] legacy_rows chunk ${start}-${start + chunk.length}: ` +
            `original=${legacyRowsPayload.length} sanitized=${sanitizedLegacyRows.length} ` +
            `missingRawJsonBefore=${missingRawJsonBefore} missingRawJsonAfter=${missingRawJsonAfter}`
        )

        const badRows = sanitizedLegacyRows.filter((row) => !row.raw_json)
        if (badRows.length > 0) {
          throw new Error(`Invalid legacy rows before insert: ${badRows.length}`)
        }

        console.log(`[import] legacy_rows initial insert started (chunk ${start}-${start + chunk.length})`)
        const { data: insertedLegacyRows, error: legacyError } = await supabase
          .from('legacy_rows')
          .insert(sanitizedLegacyRows)
          .select('id, row_number')

        if (legacyError) throw new Error(`legacy_rows initial insert failed: ${legacyError.message}`)
        console.log(`[import] legacy_rows initial insert completed (${insertedLegacyRows?.length ?? 0} rows)`)

        const rowNumberToLegacyId = new Map<number, string>()
        for (const r of insertedLegacyRows ?? []) {
          if (r.row_number !== null) rowNumberToLegacyId.set(r.row_number, r.id)
        }

        const inventoryPayload: Record<string, unknown>[] = []
        const bookingByLegacyRowId = new Map<string, { buyerName: string; dealPrice: number }>()

        chunk.forEach((row, i) => {
          const rowNumber = start + i + 2
          const evalResult = evaluateStockRow(row, stockIdx, batchByRow.get(start + i) ?? null)
          if (evalResult.skip) {
            skippedRows++
            return
          }
          cleanRows++
          if (evalResult.missingModal) missingModal++
          if (evalResult.bookedAmount !== null) {
            rowsWithBookedValue++
            inventoryRowsMarkedBooked++
          }
          if (evalResult.batchName) rowsWithBatch++
          if (evalResult.batchModalTotal !== null) rowsWithBatchModalTotal++
          if (evalResult.modalCalculatedFromBatch) rowsWithCalculatedBatchModal++

          const legacyRowId = rowNumberToLegacyId.get(rowNumber) ?? null
          if (!legacyRowId && evalResult.bookedAmount !== null) {
            throw new Error(`Cannot create imported booking: legacy row ${rowNumber} was not linked.`)
          }
          if (legacyRowId && evalResult.bookedAmount !== null) {
            const confirmedBuyer = resolvedBuyers.get(evalResult.buyerName) ?? evalResult.buyerName
            bookingByLegacyRowId.set(legacyRowId, {
              buyerName: confirmedBuyer,
              dealPrice: evalResult.bookedAmount,
            })
          }

          inventoryPayload.push({
            item_name: evalResult.itemName,
            category,
            quantity: evalResult.quantity,
            modal_price: evalResult.modalPrice,
            batch_name: evalResult.batchName,
            batch_modal_total: evalResult.batchModalTotal,
            status: evalResult.bookedAmount !== null ? 'booked' : 'ready',
            notes:
              evalResult.legacyCuan !== null
                ? `Legacy Cuan (profit) from import: ${evalResult.legacyCuan}`
                : null,
            legacy_import_id: importRow.id,
            legacy_row_id: legacyRowId,
            created_by: user.id,
          })
        })

        if (inventoryPayload.length > 0) {
          const { data: insertedItems, error: itemsError } = await supabase
            .from('inventory_items')
            .insert(inventoryPayload)
            .select('id, legacy_row_id')

          if (itemsError) throw new Error(itemsError.message)

          const bookingsPayload = (insertedItems ?? []).flatMap((item) => {
            if (!item.legacy_row_id) return []
            const booking = bookingByLegacyRowId.get(item.legacy_row_id)
            if (!booking) return []
            return [
              {
                inventory_item_id: item.id,
                buyer_name: booking.buyerName,
                deal_price: booking.dealPrice,
                dp_amount: 0,
                remaining_amount: 0,
                deadline: null,
                status: 'active',
                notes: 'Created from legacy Excel Booked column during import',
                legacy_import_id: importRow.id,
                created_by: user.id,
              },
            ]
          })

          if (bookingsPayload.length > 0) {
            const { data: insertedBookings, error: bookingsError } = await supabase
              .from('bookings')
              .insert(bookingsPayload)
              .select('id')
            if (bookingsError) throw new Error(`bookings insert failed: ${bookingsError.message}`)
            bookingRecordsCreated += insertedBookings?.length ?? 0
          }

          const updates = (insertedItems ?? [])
            .filter((item) => !!item.legacy_row_id)
            .map((item) => ({ id: item.legacy_row_id as string, mapped_inventory_item_id: item.id }))

          if (updates.length > 0) {
            console.log(`[import] legacy_rows backlink update started (${updates.length} rows)`)
            // Update-by-id only — never upsert here. legacy_rows.raw_json is NOT NULL and this
            // step intentionally never sends raw_json, so an upsert that fell through to an
            // INSERT (e.g. on a conflict-matching miss) would violate that constraint. A plain
            // update touches only existing rows and only the mapped_inventory_item_id column,
            // so the real raw_json backup is never at risk of being overwritten or nulled.
            for (const { id, mapped_inventory_item_id } of updates) {
              if (!id) continue // defensive: never update without a valid legacy_rows id
              const { error: updateError } = await supabase
                .from('legacy_rows')
                .update({ mapped_inventory_item_id })
                .eq('id', id)
              if (updateError) {
                throw new Error(`legacy_rows backlink update failed (id=${id}): ${updateError.message}`)
              }
            }
            console.log(`[import] legacy_rows backlink update completed (${updates.length} rows)`)
          }
        }

        setProgress({ done: Math.min(start + CHUNK_SIZE, rows.length), total: rows.length })
      }

      await supabase
        .from('legacy_imports')
        .update({ clean_rows_created: cleanRows, skipped_rows: skippedRows })
        .eq('id', importRow.id)

      setResult({
        totalRows: rows.length,
        cleanRows,
        skippedRows,
        missingModal,
        rowsWithBookedValue,
        bookingRecordsCreated,
        inventoryRowsMarkedBooked,
        rowsWithBatch,
        rowsWithBatchModalTotal,
        rowsWithCalculatedBatchModal,
      })
      void logActivity({
        action: 'Import',
        entity: 'legacy_imports',
        entityId: importRow.id,
        userId: user.id,
        details: { file_name: fileName, sheet_name: selectedSheet, clean_rows: cleanRows },
      })
      loadPastImports()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Import Excel</h1>
      <p className="text-sm text-gray-500">
        Upload the old stock spreadsheet. Every row is saved as-is first (raw backup), then rows
        that look like real stock items are mapped into clean inventory records. Nothing is ever
        deleted or overwritten — each import creates a new history entry.
      </p>

      {!canWrite ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-800">
          Read-only mode: File upload and importing are disabled for the Viewer role.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Excel file (.xlsx)</label>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-700"
            />
          </div>

          {sheetNames.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Sheet</label>
              <select
                value={selectedSheet}
                onChange={(e) => handleSheetSelect(e.target.value)}
                className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {sheetNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {sheetNames.length > 0 && (
            <button
              onClick={handleImport}
              disabled={importing}
              className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
            >
              {importing
                ? `Importing... ${progress.done}/${progress.total}`
                : 'Save raw rows & import inventory'}
            </button>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

        {previewRows.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium text-gray-700">
              Preview (first {previewRows.length} rows)
            </p>
            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    {previewHeader.map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-2 py-1 text-left font-medium text-gray-600">
                        {h || `col_${i + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {previewRows.map((row, ri) => (
                    <tr key={ri}>
                      {previewHeader.map((_, ci) => (
                        <td key={ci} className="whitespace-nowrap px-2 py-1 text-gray-700">
                          {row[ci] === null || row[ci] === undefined ? '' : String(row[ci])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {previewRows.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium text-gray-700">Detected priced rows</p>
            {pricedPreviewRows.length === 0 ? (
              <p className="text-xs text-gray-500">No Modal or Booked values detected.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200 text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">Excel row</th>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">Item name</th>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">pcs</th>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">Batch</th>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">Batch modal total</th>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">Modal/pcs calculated</th>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">
                        Booked amount
                      </th>
                      <th className="px-2 py-1 text-left font-medium text-gray-600">Import action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {pricedPreviewRows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-500">{row.rowNumber}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-700">{row.itemName}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-700">{row.quantity}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-700">
                          {row.batchName ?? '-'}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-700">
                          {row.batchModalTotal === null ? '-' : formatIDR(row.batchModalTotal)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-700">
                          {row.modalPrice === null ? '-' : formatIDR(row.modalPrice)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-700">
                          {row.bookedAmount === null ? '-' : formatIDR(row.bookedAmount)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 text-gray-700">
                          {row.bookedAmount === null ? '-' : 'Create booking + mark item booked'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {loadingBuyerMatches && (
          <p className="text-xs text-gray-500">Matching buyers against database...</p>
        )}

        {buyerMatches.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium text-gray-900">Buyer Linking & Resolution</h3>
                <p className="text-xs text-gray-500">
                  Review fuzzy matched buyers before committing import to the database.
                </p>
              </div>
              <div className="flex gap-1.5 text-xs font-medium">
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-700">
                  {buyerMatches.filter((m) => m.status === 'exact').length} Exact
                </span>
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700">
                  {buyerMatches.filter((m) => m.status === 'single_match').length} Matched
                </span>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">
                  {buyerMatches.filter((m) => m.status === 'ambiguous').length} Ambiguous
                </span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
                  {buyerMatches.filter((m) => m.status === 'new').length} New
                </span>
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Imported Buyer Name</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Match Status</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Target Buyer (Action)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {buyerMatches.map((m) => {
                    const currentTarget = resolvedBuyers.get(m.importedName) ?? m.selectedName
                    return (
                      <tr key={m.importedName} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-900">
                          {m.importedName}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {m.status === 'exact' && (
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                              Exact Match
                            </span>
                          )}
                          {m.status === 'single_match' && (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                              Matched ({Math.round(m.confidence * 100)}%)
                            </span>
                          )}
                          {m.status === 'ambiguous' && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                              Ambiguous ({m.candidates.length} options)
                            </span>
                          )}
                          {m.status === 'new' && (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                              New Buyer
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <select
                            value={currentTarget}
                            onChange={(e) => {
                              const val = e.target.value
                              setResolvedBuyers((prev) => new Map(prev).set(m.importedName, val))
                            }}
                            className="w-full max-w-xs rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-gray-500 focus:outline-none"
                          >
                            {m.candidates.length > 0 && (
                              <optgroup label="Suggested Matches">
                                {m.candidates.map((c) => (
                                  <option key={c.name} value={c.name}>
                                    Link to &quot;{c.name}&quot; ({Math.round(c.similarity * 100)}% match)
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <option value={m.importedName}>
                              + Create as new buyer &quot;{m.importedName}&quot;
                            </option>
                            {existingBuyerNames.length > 0 && (
                              <optgroup label="All Existing Buyers">
                                {existingBuyerNames
                                  .filter((name) => !m.candidates.some((c) => c.name === name))
                                  .map((name) => (
                                    <option key={name} value={name}>
                                      Link to &quot;{name}&quot;
                                    </option>
                                  ))}
                              </optgroup>
                            )}
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <h2 className="mb-2 font-medium text-green-900">Import complete</h2>
          <ul className="space-y-1 text-sm text-green-800">
            <li>Total raw rows saved: {result.totalRows}</li>
            <li>Clean inventory rows created: {result.cleanRows}</li>
            <li>Skipped rows (empty/month/total): {result.skippedRows}</li>
            <li>Rows with missing modal price: {result.missingModal}</li>
            <li>Rows with booked value detected: {result.rowsWithBookedValue}</li>
            <li>Booking records created: {result.bookingRecordsCreated}</li>
            <li>Inventory rows marked as booked: {result.inventoryRowsMarkedBooked}</li>
            <li>Rows with batch detected: {result.rowsWithBatch}</li>
            <li>Rows with batch modal total detected: {result.rowsWithBatchModalTotal}</li>
            <li>Rows with modal price calculated from batch: {result.rowsWithCalculatedBatchModal}</li>
          </ul>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-lg font-medium text-gray-900">Import history</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-600">File</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Sheet</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Total rows</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Clean rows</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Skipped</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Imported at</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pastImports.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                    No imports yet.
                  </td>
                </tr>
              ) : (
                pastImports.map((imp) => {
                  const isReverted = imp.status === 'reverted'
                  return (
                    <tr key={imp.id} className={isReverted ? 'bg-gray-50/50 text-gray-400' : ''}>
                      <td className="px-3 py-2 font-medium text-gray-900 flex items-center gap-2">
                        {imp.file_name}
                        {isReverted && (
                          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-normal text-gray-600">
                            Reverted
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{imp.sheet_name}</td>
                      <td className="px-3 py-2 text-gray-600">{imp.total_rows}</td>
                      <td className="px-3 py-2 text-gray-600">{imp.clean_rows_created}</td>
                      <td className="px-3 py-2 text-gray-600">{imp.skipped_rows}</td>
                      <td className="px-3 py-2 text-gray-500">{formatDateTime(imp.created_at)}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <button
                            onClick={() => openViewItemsModal(imp)}
                            className="text-xs font-medium text-blue-600 hover:underline"
                          >
                            View items
                          </button>
                          {canWrite && !isReverted && (
                            <button
                              onClick={() => openDeleteModal(imp)}
                              className="text-xs font-medium text-red-600 hover:underline"
                            >
                              Delete import
                            </button>
                          )}
                          {isReverted && (
                            <span className="text-xs text-gray-400">Reverted</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* View Items Modal */}
      {viewImport && (
        <Modal title={`Items from ${viewImport.file_name}`} onClose={() => setViewImport(null)} wide>
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              Sheet: <span className="font-medium text-gray-700">{viewImport.sheet_name}</span> ·
              Imported: <span className="font-medium text-gray-700">{formatDateTime(viewImport.created_at)}</span>
            </p>
            {viewLoading ? (
              <p className="text-sm text-gray-500">Loading items...</p>
            ) : viewItems.length === 0 ? (
              <p className="text-sm text-gray-400">No items found for this import.</p>
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-md border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200 text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Item Name</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Category</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Batch</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Status</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Modal Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {viewItems.map((item) => (
                      <tr key={item.id}>
                        <td className="px-3 py-2 font-medium text-gray-900">{item.item_name}</td>
                        <td className="px-3 py-2 text-gray-600">{item.category ?? '-'}</td>
                        <td className="px-3 py-2 text-gray-600">{item.batch_name ?? '-'}</td>
                        <td className="px-3 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[item.status]}`}>
                            {formatStatus(item.status)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-700">{formatIDR(item.modal_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setViewImport(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Import Modal */}
      {deleteTargetImport && (
        <Modal title={`Delete import "${deleteTargetImport.file_name}"`} onClose={() => setDeleteTargetImport(null)}>
          <div className="space-y-4">
            {deleteLoading ? (
              <p className="text-sm text-gray-500">Analyzing items in this import...</p>
            ) : !deletePreview ? (
              <p className="text-sm text-gray-500">Failed to analyze import items.</p>
            ) : (
              <>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2 text-sm">
                  <p className="font-medium text-gray-900">Import Safety Summary</p>
                  <ul className="space-y-1 text-xs text-gray-700">
                    <li className="flex items-center justify-between">
                      <span>Ready Items (will be deleted directly):</span>
                      <span className="font-semibold text-green-700">{deletePreview.readyItems.length}</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Booked Items (item + linked booking will be deleted):</span>
                      <span className="font-semibold text-blue-700">{deletePreview.bookedItems.length}</span>
                    </li>
                    {deletePreview.soldItems.length > 0 && (
                      <li className="flex items-center justify-between font-semibold text-amber-700">
                        <span>Sold Items (FLAGGED / BLOCKED from auto-deletion):</span>
                        <span>{deletePreview.soldItems.length}</span>
                      </li>
                    )}
                  </ul>
                </div>

                {deletePreview.soldItems.length > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    <strong>Warning:</strong> {deletePreview.soldItems.length} item(s) from this import have already been converted to Sales and will <strong>NOT</strong> be deleted automatically to preserve financial transaction history.
                  </div>
                )}

                <p className="text-xs text-gray-500">
                  Confirming will delete {deletePreview.readyItems.length + deletePreview.bookedItems.length} unsold item(s) and their linked bookings from the database.
                </p>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setDeleteTargetImport(null)}
                    className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmDeleteImport}
                    disabled={deleting || (deletePreview.readyItems.length === 0 && deletePreview.bookedItems.length === 0)}
                    className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {deleting
                      ? 'Deleting...'
                      : `Confirm Delete (${deletePreview.readyItems.length + deletePreview.bookedItems.length} items)`}
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
