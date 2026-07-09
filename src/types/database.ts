export type ItemStatus = 'ready' | 'booked' | 'sold' | 'cancelled'
export type ItemCondition = 'carded' | 'loose' | 'damaged' | 'unknown'
export type BookingStatus = 'active' | 'cancelled' | 'converted_to_sale'
export type Platform =
  | 'Live'
  | 'WhatsApp'
  | 'Instagram'
  | 'Tokopedia'
  | 'Shopee'
  | 'Event'
  | 'Other'
export type ExpenseType = 'packing' | 'shipping' | 'marketplace_fee' | 'event_fee' | 'other'

export interface Profile {
  id: string
  full_name: string | null
  role: string
  created_at: string
}

export interface Partner {
  id: string
  name: string
  email: string | null
  created_at: string
}

export interface InventoryItem {
  id: string
  item_code: string | null
  item_name: string
  brand: string | null
  category: string | null
  condition: ItemCondition
  quantity: number
  modal_price: number
  target_price: number
  batch_name?: string | null
  batch_modal_total?: number | null
  status: ItemStatus
  owner: string
  notes: string | null
  legacy_import_id: string | null
  legacy_row_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Customer {
  id: string
  name: string
  phone: string | null
  notes: string | null
  created_at: string
}

export interface Booking {
  id: string
  inventory_item_id: string | null
  customer_id: string | null
  booking_group_id: string | null
  group_total_deal_price: number | null
  buyer_name: string
  deal_price: number
  dp_amount: number
  remaining_amount: number
  deadline: string | null
  status: BookingStatus
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Sale {
  id: string
  inventory_item_id: string | null
  customer_id: string | null
  booking_group_id: string | null
  buyer_name: string
  platform: Platform
  sale_price: number
  modal_price: number
  marketplace_fee: number
  packing_cost: number
  shipping_subsidy: number
  gross_profit: number
  net_profit: number
  sale_date: string
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Expense {
  id: string
  expense_date: string
  type: ExpenseType
  amount: number
  notes: string | null
  created_by: string | null
  created_at: string
}

export interface PartnerWithdrawal {
  id: string
  partner_id: string | null
  amount: number
  withdrawal_date: string
  notes: string | null
  created_at: string
}

export interface LegacyImport {
  id: string
  file_name: string
  sheet_name: string | null
  uploaded_by: string | null
  total_rows: number
  clean_rows_created: number
  skipped_rows: number
  created_at: string
}

export interface LegacyRow {
  id: string
  legacy_import_id: string
  sheet_name: string | null
  row_number: number | null
  raw_json: Record<string, unknown>
  mapped_inventory_item_id: string | null
  created_at: string
}

export interface ActivityLog {
  id: string
  action: string
  entity: string
  entity_id: string | null
  details: Record<string, unknown>
  created_by: string | null
  created_at: string
}
