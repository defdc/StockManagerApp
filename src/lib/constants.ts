import type { BookingStatus, ExpenseType, FulfillmentStatus, ItemStatus } from '../types/database'

export const APP_NAME = 'Kereta Pingki'

export const ITEM_STATUSES: ItemStatus[] = ['ready', 'booked', 'sold', 'cancelled']
export const BOOKING_STATUSES: BookingStatus[] = ['active', 'cancelled', 'converted_to_sale']
export const EXPENSE_TYPES: ExpenseType[] = [
  'packing',
  'shipping',
  'marketplace_fee',
  'event_fee',
  'other',
]
export const FULFILLMENT_STATUSES: FulfillmentStatus[] = ['parking', 'shipping', 'parking_shipping', 'delivered']

export const FULFILLMENT_LABELS: Record<FulfillmentStatus, string> = {
  parking: 'Parking',
  shipping: 'Shipping',
  parking_shipping: 'Parking + Shipping',
  delivered: 'Delivered',
}

export const FULFILLMENT_BADGE_CLASSES: Record<FulfillmentStatus, string> = {
  parking: 'bg-gray-100 text-gray-700',
  shipping: 'bg-blue-100 text-blue-700',
  parking_shipping: 'bg-orange-100 text-orange-700',
  delivered: 'bg-green-100 text-green-700',
}

export const STATUS_BADGE_CLASSES: Record<string, string> = {
  ready: 'bg-green-100 text-green-700',
  booked: 'bg-amber-100 text-amber-700',
  sold: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-gray-100 text-gray-500',
  active: 'bg-amber-100 text-amber-700',
  converted_to_sale: 'bg-blue-100 text-blue-700',
}
