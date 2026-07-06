import * as XLSX from 'xlsx'

export type SheetGrid = {
  header: string[]
  rows: unknown[][]
  rawHeader: string[]
  rawRows: unknown[][]
}

export async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buffer = await file.arrayBuffer()
  return XLSX.read(buffer, { type: 'array' })
}

export function expandMergedCells(grid: unknown[][], worksheet: XLSX.WorkSheet): unknown[][] {
  const expanded = Array.from(grid, (row) => [...(row ?? [])])

  for (const merge of worksheet['!merges'] ?? []) {
    const value = expanded[merge.s.r]?.[merge.s.c]
    if (value === undefined || value === null || value === '') continue

    for (let rowIndex = merge.s.r; rowIndex <= merge.e.r; rowIndex++) {
      if (!expanded[rowIndex]) expanded[rowIndex] = []
      for (let columnIndex = merge.s.c; columnIndex <= merge.e.c; columnIndex++) {
        const currentValue = expanded[rowIndex][columnIndex]
        if (currentValue === undefined || currentValue === null || currentValue === '') {
          expanded[rowIndex][columnIndex] = value
        }
      }
    }
  }

  return expanded
}

export function getSheetGrid(workbook: XLSX.WorkBook, sheetName: string): SheetGrid {
  const worksheet = workbook.Sheets[sheetName]
  const allRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null }) as unknown[][]
  const expandedRows = expandMergedCells(allRows, worksheet)
  const normalizeHeader = (row: unknown[]) =>
    (row ?? []).map((h) => (h === null || h === undefined ? '' : String(h).trim()))
  const header = normalizeHeader(expandedRows[0] ?? [])
  const rawHeader = normalizeHeader(allRows[0] ?? [])
  // Fully blank rows can come back as sparse-array holes rather than `[]`. Array.from
  // (unlike slice/map) visits every index and turns holes into real `undefined` entries,
  // so downstream code never silently skips a row.
  const rowCount = Math.max(expandedRows.length - 1, allRows.length - 1, 0)
  const rows = Array.from({ length: rowCount }, (_, i) => expandedRows[i + 1] ?? [])
  const rawRows = Array.from({ length: rowCount }, (_, i) => allRows[i + 1] ?? [])
  return { header, rows, rawHeader, rawRows }
}

export function findColumnIndex(header: string[], candidates: string[]): number {
  const normalized = header.map((h) => h.toLowerCase().trim())
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate.toLowerCase())
    if (idx !== -1) return idx
  }
  return -1
}

export function buildRawJson(header: string[], row: unknown[]): Record<string, unknown> {
  if (!Array.isArray(row) || (row.length === 0 && header.length === 0)) {
    return { _empty: true }
  }
  const obj: Record<string, unknown> = {}
  const len = Math.max(header.length, row.length)
  for (let i = 0; i < len; i++) {
    const key = header[i] && header[i].length > 0 ? header[i] : `col_${i + 1}`
    obj[key] = row[i] ?? null
  }
  return obj
}

export interface LegacyRowInsert {
  legacy_import_id: string
  sheet_name: string | null
  row_number: number
  raw_json: Record<string, unknown>
}

// Last line of defense before a legacy_rows insert: raw_json is NOT NULL in the database,
// so a null/undefined/non-object value here would otherwise surface as a Postgres constraint
// violation instead of a readable error.
export function normalizeRawJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { _empty: true }
  }
  return value as Record<string, unknown>
}

// Array.from (not .map) so a sparse/holey input array can't silently drop a row instead of
// sanitizing it.
export function sanitizeLegacyRows(rows: unknown[]): LegacyRowInsert[] {
  return Array.from(rows)
    .filter((row): row is Partial<LegacyRowInsert> => {
      return !!row && typeof row === 'object' && !Array.isArray(row)
    })
    .map((row) => ({
      ...row,
      raw_json: normalizeRawJson(row.raw_json),
    })) as LegacyRowInsert[]
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

const DATE_LIKE_REGEX = /^\d{1,2}[/\-. ]\d{1,2}([/\-. ]\d{2,4})?$/
const MONTH_NAME_REGEX =
  /^(jan|feb|mar|apr|mei|may|jun|jul|agu|aug|sep|okt|oct|nov|des|dec)[a-z]*\.?\s*\d{0,4}$/i

function looksLikeDateOrMonthRow(value: unknown): boolean {
  if (typeof value === 'number') return true // Excel date serial in the item-name column
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (DATE_LIKE_REGEX.test(trimmed)) return true
    if (MONTH_NAME_REGEX.test(trimmed)) return true
    if (/^week\s*\d/i.test(trimmed)) return true
  }
  return false
}

function looksLikeTotalRow(name: string): boolean {
  return name.trim().toLowerCase().startsWith('total')
}

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const negative = trimmed.includes('-') || /^\(.*\)$/.test(trimmed)
    const cleaned = trimmed.replace(/rp/gi, '').replace(/\s/g, '').replace(/[^0-9.,]/g, '')
    if (cleaned === '') return null

    const commaCount = (cleaned.match(/,/g) ?? []).length
    const dotCount = (cleaned.match(/\./g) ?? []).length
    let normalized = cleaned

    if (commaCount > 0 && dotCount > 0) {
      const lastSeparator = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'))
      const decimalDigits = cleaned.length - lastSeparator - 1
      if (decimalDigits > 0 && decimalDigits <= 2) {
        normalized = `${cleaned.slice(0, lastSeparator).replace(/[.,]/g, '')}.${cleaned.slice(lastSeparator + 1)}`
      } else {
        normalized = cleaned.replace(/[.,]/g, '')
      }
    } else if (commaCount + dotCount > 0) {
      const separator = commaCount > 0 ? ',' : '.'
      const separatorCount = commaCount + dotCount
      const separatorIndex = cleaned.lastIndexOf(separator)
      const digitsAfter = cleaned.length - separatorIndex - 1
      if (separatorCount > 1 || digitsAfter === 3) {
        normalized = cleaned.replace(/[.,]/g, '')
      } else {
        normalized = cleaned.replace(separator, '.')
      }
    }

    const n = Number(`${negative ? '-' : ''}${normalized}`)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function parseCurrency(value: unknown): number | null {
  const parsed = toNumberOrNull(value)
  return parsed === null ? null : Math.trunc(parsed)
}

export interface StockColumnIndexes {
  itemName: number
  pcs: number
  modal: number
  booked: number
  cuan: number
}

export function detectStockColumns(header: string[]): StockColumnIndexes {
  return {
    itemName: findColumnIndex(header, ['item name', 'item_name', 'name']),
    pcs: findColumnIndex(header, ['pcs']),
    modal: findColumnIndex(header, ['modal', 'modal/pcs']),
    booked: findColumnIndex(header, ['booked']),
    cuan: findColumnIndex(header, ['cuan']),
  }
}

export type RowEvaluation =
  | { skip: true; reason: 'empty_name' | 'month_or_date_row' | 'total_row' }
  | {
      skip: false
      itemName: string
      quantity: number
      modalPrice: number
      targetPrice: number
      legacyCuan: number | null
      missingModal: boolean
      missingPrice: boolean
    }

export function evaluateStockRow(row: unknown[], idx: StockColumnIndexes): RowEvaluation {
  const rawName = idx.itemName >= 0 ? row[idx.itemName] : null

  if (isEmptyValue(rawName)) return { skip: true, reason: 'empty_name' }
  if (looksLikeDateOrMonthRow(rawName)) return { skip: true, reason: 'month_or_date_row' }

  const nameStr = String(rawName).trim()
  if (looksLikeTotalRow(nameStr)) return { skip: true, reason: 'total_row' }

  const pcs = idx.pcs >= 0 ? toNumberOrNull(row[idx.pcs]) : null
  const modal = idx.modal >= 0 ? parseCurrency(row[idx.modal]) : null
  const booked = idx.booked >= 0 ? parseCurrency(row[idx.booked]) : null
  const cuan = idx.cuan >= 0 ? parseCurrency(row[idx.cuan]) : null

  return {
    skip: false,
    itemName: nameStr,
    quantity: pcs && pcs > 0 ? pcs : 1,
    modalPrice: modal ?? 0,
    targetPrice: booked ?? 0,
    legacyCuan: cuan,
    missingModal: modal === null,
    missingPrice: booked === null,
  }
}

export function guessCategoryFromSheetName(sheetName: string): string {
  const lower = sheetName.toLowerCase()
  if (lower.includes('hot wheels') || lower.includes('hotwheels') || lower.includes('hotwheel')) {
    return 'Hot Wheels'
  }
  if (lower.includes('tomica')) return 'Tomica'
  if (lower.includes('mini gt') || lower.includes('minigt')) return 'Mini GT'
  if (lower.includes('pop race') || lower.includes('poprace')) return 'Pop Race'
  return 'Other'
}
