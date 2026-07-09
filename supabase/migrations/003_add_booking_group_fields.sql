alter table bookings
add column if not exists booking_group_id uuid;

alter table bookings
add column if not exists group_total_deal_price numeric;

alter table sales
add column if not exists booking_group_id uuid;

create index if not exists idx_bookings_booking_group_id on bookings(booking_group_id);
create index if not exists idx_sales_booking_group_id on sales(booking_group_id);
