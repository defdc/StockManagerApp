import { formatIDR, formatDate } from './format'
import type { FulfillmentStatus } from '../types/database'

export interface SaleSummaryInput {
  id: string
  buyer_name: string
  sale_price: number
  gross_profit: number
  net_profit: number
  sale_date: string
  fulfillment_status: FulfillmentStatus | null
  inventory_items?: { item_name?: string; batch_name?: string | null } | null
}

export interface ExpenseSummaryInput {
  id: string
  amount: number
  expense_date: string
}

export interface PeriodSummary {
  periodType: 'week' | 'month'
  label: string
  startDate: string
  endDate: string
  itemsSold: number
  revenue: number
  grossProfit: number
  expenses: number
  netProfit: number
  topBuyer: string
  fulfillmentSummary: Record<FulfillmentStatus, number>
  sales: SaleSummaryInput[]
}

/**
 * Returns Monday to Sunday date strings for a given week offset (0 = current week).
 * Week boundary rule: Monday – Sunday.
 */
export function getWeekBounds(offsetWeeks: number = 0, baseDate: Date = new Date()): { start: string; end: string; label: string } {
  const d = new Date(baseDate)
  d.setDate(d.getDate() + offsetWeeks * 7)

  const day = d.getDay() // 0 = Sun, 1 = Mon...
  const diffToMon = day === 0 ? -6 : 1 - day

  const monday = new Date(d)
  monday.setDate(d.getDate() + diffToMon)

  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const start = monday.toISOString().slice(0, 10)
  const end = sunday.toISOString().slice(0, 10)
  const label = `${formatDate(start)} – ${formatDate(end)}`

  return { start, end, label }
}

/**
 * Returns 1st to last day of month date strings for a given month offset (0 = current month).
 * Month boundary rule: 1st to end of month.
 */
export function getMonthBounds(offsetMonths: number = 0, baseDate: Date = new Date()): { start: string; end: string; label: string } {
  const year = baseDate.getFullYear()
  const month = baseDate.getMonth() + offsetMonths

  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)

  const start = firstDay.toISOString().slice(0, 10)
  const end = lastDay.toISOString().slice(0, 10)
  const label = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(firstDay)

  return { start, end, label }
}

/**
 * Calculates metrics for any period given a date range.
 */
export function calculatePeriodSummary(
  sales: SaleSummaryInput[],
  expenses: ExpenseSummaryInput[],
  startDate: string,
  endDate: string,
  label: string,
  periodType: 'week' | 'month'
): PeriodSummary {
  const periodSales = sales.filter((s) => s.sale_date >= startDate && s.sale_date <= endDate)
  const periodExpenses = expenses.filter((e) => e.expense_date >= startDate && e.expense_date <= endDate)

  const revenue = periodSales.reduce((sum, s) => sum + s.sale_price, 0)
  const grossProfit = periodSales.reduce((sum, s) => sum + s.gross_profit, 0)
  const expenseTotal = periodExpenses.reduce((sum, e) => sum + e.amount, 0)
  const netProfit = periodSales.reduce((sum, s) => sum + s.net_profit, 0) - expenseTotal

  const buyerRevenue = new Map<string, number>()
  for (const sale of periodSales) {
    buyerRevenue.set(sale.buyer_name, (buyerRevenue.get(sale.buyer_name) ?? 0) + sale.sale_price)
  }
  const topBuyerEntry = [...buyerRevenue.entries()].sort((a, b) => b[1] - a[1])[0]

  const fulfillmentSummary = periodSales.reduce(
    (summary, sale) => {
      const status = (sale.fulfillment_status ?? 'parking') as FulfillmentStatus
      summary[status] = (summary[status] ?? 0) + 1
      return summary
    },
    { parking: 0, shipping: 0, parking_shipping: 0, delivered: 0 } as Record<FulfillmentStatus, number>
  )

  return {
    periodType,
    label,
    startDate,
    endDate,
    itemsSold: periodSales.length,
    revenue,
    grossProfit,
    expenses: expenseTotal,
    netProfit,
    topBuyer: topBuyerEntry ? `${topBuyerEntry[0]} (${formatIDR(topBuyerEntry[1])})` : '-',
    fulfillmentSummary,
    sales: periodSales,
  }
}
