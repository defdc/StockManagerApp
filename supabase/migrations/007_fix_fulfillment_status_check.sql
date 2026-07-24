-- Ensure the sales_fulfillment_status_check constraint allows all intended values.
-- Previous migrations (005, 006) used "if not exists" guards, so if the constraint
-- was already present with a different definition it was never updated.
-- This migration drops the old constraint and re-creates it with the canonical list.

do $$
begin
  -- Drop the constraint if it exists (regardless of its current definition)
  if exists (
    select 1
    from pg_constraint
    where conname = 'sales_fulfillment_status_check'
  ) then
    alter table public.sales
      drop constraint sales_fulfillment_status_check;
  end if;

  -- Re-create with the full set of allowed values
  alter table public.sales
    add constraint sales_fulfillment_status_check
    check (fulfillment_status in ('parking', 'shipping', 'parking_shipping', 'delivered'));
end $$;
