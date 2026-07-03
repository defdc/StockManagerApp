import type { BookingStatus, ExpenseType, ItemCondition, ItemStatus, Platform } from '../types/database'

export const ITEM_STATUSES: ItemStatus[] = ['ready', 'booked', 'sold', 'cancelled']
export const ITEM_CONDITIONS: ItemCondition[] = ['carded', 'loose', 'damaged', 'unknown']
export const CATEGORIES = ['Hot Wheels', 'Tomica', 'Mini GT', 'Pop Race', 'Other']
export const BOOKING_STATUSES: BookingStatus[] = ['active', 'cancelled', 'converted_to_sale']
export const PLATFORMS: Platform[] = [
  'Live',
  'WhatsApp',
  'Instagram',
  'Tokopedia',
  'Shopee',
  'Event',
  'Other',
]
export const EXPENSE_TYPES: ExpenseType[] = [
  'packing',
  'shipping',
  'marketplace_fee',
  'event_fee',
  'other',
]

export const STATUS_BADGE_CLASSES: Record<string, string> = {
  ready: 'bg-green-100 text-green-700',
  booked: 'bg-amber-100 text-amber-700',
  sold: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-gray-100 text-gray-500',
  active: 'bg-amber-100 text-amber-700',
  converted_to_sale: 'bg-blue-100 text-blue-700',
}
