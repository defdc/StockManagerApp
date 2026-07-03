import { useEffect, useState, type ChangeEvent } from 'react'
import type * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { formatDateTime } from '../lib/format'
import {
  buildRawJson,
  detectStockColumns,
  evaluateStockRow,
  getSheetGrid,
  guessCategoryFromSheetName,
  readWorkbook,
  sanitizeLegacyRows,
} from '../lib/legacyImport'
import type { LegacyImport } from '../types/database'

const CHUNK_SIZE = 300

interface ImportResult {
  totalRows: number
  cleanRows: number
  skippedRows: number
  missingModal: number
  missingPrice: number
}

export default function ImportExcel() {
  const { user } = useAuth()
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [fileName, setFileName] = useState('')
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [previewHeader, setPreviewHeader] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<unknown[][]>([])

  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [pastImports, setPastImports] = useState<LegacyImport[]>([])

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
      loadPreview(wb, firstSheet)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read the Excel file.')
    }
  }

  function loadPreview(wb: XLSX.WorkBook, sheetName: string) {
    const { header, rows } = getSheetGrid(wb, sheetName)
    setPreviewHeader(header)
    setPreviewRows(rows.slice(0, 20))
  }

  function handleSheetSelect(name: string) {
    setSelectedSheet(name)
    setResult(null)
    if (workbook) loadPreview(workbook, name)
  }

  async function handleImport() {
    if (!workbook || !selectedSheet || !user) return
    setImporting(true)
    setError(null)
    setResult(null)

    try {
      const { header, rows } = getSheetGrid(workbook, selectedSheet)
      const stockIdx = detectStockColumns(header)
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
      let missingPrice = 0

      for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
        const chunk = rows.slice(start, start + CHUNK_SIZE)

        const legacyRowsPayload = chunk.map((row, i) => ({
          legacy_import_id: importRow.id,
          sheet_name: selectedSheet,
          row_number: start + i + 2, // +1 for header row, +1 for 1-based numbering
          raw_json: buildRawJson(header, row),
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

        chunk.forEach((row, i) => {
          const rowNumber = start + i + 2
          const evalResult = evaluateStockRow(row, stockIdx)
          if (evalResult.skip) {
            skippedRows++
            return
          }
          cleanRows++
          if (evalResult.missingModal) missingModal++
          if (evalResult.missingPrice) missingPrice++

          const legacyRowId = rowNumberToLegacyId.get(rowNumber) ?? null

          inventoryPayload.push({
            item_name: evalResult.itemName,
            category,
            condition: 'unknown',
            quantity: evalResult.quantity,
            modal_price: evalResult.modalPrice,
            target_price: evalResult.targetPrice,
            status: 'ready',
            owner: 'shared',
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
        missingPrice,
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

        {sheetNames.length > 0 && (
          <button
            onClick={handleImport}
            disabled={importing}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {importing
              ? `Importing... ${progress.done}/${progress.total}`
              : 'Save raw rows & import inventory'}
          </button>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {result && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <h2 className="mb-2 font-medium text-green-900">Import complete</h2>
          <ul className="space-y-1 text-sm text-green-800">
            <li>Total raw rows saved: {result.totalRows}</li>
            <li>Clean inventory rows created: {result.cleanRows}</li>
            <li>Skipped rows (empty/month/total): {result.skippedRows}</li>
            <li>Rows with missing modal price: {result.missingModal}</li>
            <li>Rows with missing target price: {result.missingPrice}</li>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pastImports.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                    No imports yet.
                  </td>
                </tr>
              ) : (
                pastImports.map((imp) => (
                  <tr key={imp.id}>
                    <td className="px-3 py-2">{imp.file_name}</td>
                    <td className="px-3 py-2">{imp.sheet_name}</td>
                    <td className="px-3 py-2">{imp.total_rows}</td>
                    <td className="px-3 py-2">{imp.clean_rows_created}</td>
                    <td className="px-3 py-2">{imp.skipped_rows}</td>
                    <td className="px-3 py-2">{formatDateTime(imp.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
