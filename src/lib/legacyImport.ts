import * as XLSX from 'xlsx'

export type SheetGrid = {
  header: string[]
  rows: unknown[][]
}

export async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buffer = await file.arrayBuffer()
  return XLSX.read(buffer, { type: 'array' })
}

export function getSheetGrid(workbook: XLSX.WorkBook, sheetName: string): SheetGrid {
  const worksheet = workbook.Sheets[sheetName]
  const allRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null }) as unknown[][]
  const header = (allRows[0] ?? []).map((h) => (h === null || h === undefined ? '' : String(h).trim()))
  const rows = allRows.slice(1)
  return { header, rows }
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
  const obj: Record<string, unknown> = {}
  const len = Math.max(header.length, row.length)
  for (let i = 0; i < len; i++) {
    const key = header[i] && header[i].length > 0 ? header[i] : `col_${i + 1}`
    obj[key] = row[i] ?? null
  }
  return obj
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
    const cleaned = value.replace(/[^0-9.-]/g, '')
    if (cleaned === '' || cleaned === '-') return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
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
  const modal = idx.modal >= 0 ? toNumberOrNull(row[idx.modal]) : null
  const booked = idx.booked >= 0 ? toNumberOrNull(row[idx.booked]) : null
  const cuan = idx.cuan >= 0 ? toNumberOrNull(row[idx.cuan]) : null

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
