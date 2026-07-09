alter table inventory_items
add column if not exists batch_name text;

alter table inventory_items
add column if not exists batch_modal_total numeric;
