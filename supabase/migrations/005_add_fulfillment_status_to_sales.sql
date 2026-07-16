do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sales'
      and column_name = 'fulfillment_status'
  ) then
    alter table public.sales add column fulfillment_status text;
  end if;
end $$;

update public.sales
set fulfillment_status = 'parking'
where fulfillment_status is null;

alter table public.sales
  alter column fulfillment_status set default 'parking';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sales_fulfillment_status_check'
  ) then
    alter table public.sales
      add constraint sales_fulfillment_status_check
      check (fulfillment_status in ('parking', 'shipping', 'parking_shipping', 'delivered'));
  end if;
end $$;
