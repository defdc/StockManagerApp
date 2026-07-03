-- Stock Manager - initial schema
-- Internal-only app: any authenticated user has full read/write access.
-- Anonymous (public) access is blocked entirely.

create extension if not exists pgcrypto;

-- ============================================================
-- Tables
-- ============================================================

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text default 'partner',
  created_at timestamptz default now()
);

create table if not exists partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  created_at timestamptz default now()
);

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  item_code text unique,
  item_name text not null,
  brand text,
  category text,
  condition text default 'unknown' check (condition in ('carded', 'loose', 'damaged', 'unknown')),
  quantity integer default 1,
  modal_price numeric default 0,
  target_price numeric default 0,
  status text default 'ready' check (status in ('ready', 'booked', 'sold', 'cancelled')),
  owner text default 'shared',
  notes text,
  legacy_import_id uuid null,
  legacy_row_id uuid null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  notes text,
  created_at timestamptz default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid references inventory_items(id),
  customer_id uuid references customers(id),
  buyer_name text not null,
  deal_price numeric default 0,
  dp_amount numeric default 0,
  remaining_amount numeric default 0,
  deadline date,
  status text default 'active' check (status in ('active', 'cancelled', 'converted_to_sale')),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid references inventory_items(id),
  customer_id uuid references customers(id),
  buyer_name text not null,
  platform text default 'Other' check (platform in ('Live', 'WhatsApp', 'Instagram', 'Tokopedia', 'Shopee', 'Event', 'Other')),
  sale_price numeric default 0,
  modal_price numeric default 0,
  marketplace_fee numeric default 0,
  packing_cost numeric default 0,
  shipping_subsidy numeric default 0,
  gross_profit numeric default 0,
  net_profit numeric default 0,
  sale_date date default current_date,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date default current_date,
  type text default 'other' check (type in ('packing', 'shipping', 'marketplace_fee', 'event_fee', 'other')),
  amount numeric default 0,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists partner_withdrawals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references partners(id),
  amount numeric not null,
  withdrawal_date date default current_date,
  notes text,
  created_at timestamptz default now()
);

create table if not exists legacy_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  sheet_name text,
  uploaded_by uuid references auth.users(id),
  total_rows integer default 0,
  clean_rows_created integer default 0,
  skipped_rows integer default 0,
  created_at timestamptz default now()
);

create table if not exists legacy_rows (
  id uuid primary key default gen_random_uuid(),
  legacy_import_id uuid references legacy_imports(id),
  sheet_name text,
  row_number integer,
  raw_json jsonb not null,
  mapped_inventory_item_id uuid null references inventory_items(id),
  created_at timestamptz default now()
);

alter table inventory_items
  add constraint inventory_items_legacy_import_id_fkey
  foreign key (legacy_import_id) references legacy_imports(id);

alter table inventory_items
  add constraint inventory_items_legacy_row_id_fkey
  foreign key (legacy_row_id) references legacy_rows(id);

-- ============================================================
-- Indexes
-- ============================================================

create index if not exists idx_inventory_items_status on inventory_items(status);
create index if not exists idx_inventory_items_owner on inventory_items(owner);
create index if not exists idx_bookings_status on bookings(status);
create index if not exists idx_bookings_inventory_item_id on bookings(inventory_item_id);
create index if not exists idx_sales_inventory_item_id on sales(inventory_item_id);
create index if not exists idx_sales_sale_date on sales(sale_date);
create index if not exists idx_legacy_rows_import_id on legacy_rows(legacy_import_id);

-- ============================================================
-- Row Level Security
-- Internal tool: any authenticated user can read/write everything.
-- Anonymous users get no access at all.
-- ============================================================

alter table profiles enable row level security;
alter table partners enable row level security;
alter table inventory_items enable row level security;
alter table customers enable row level security;
alter table bookings enable row level security;
alter table sales enable row level security;
alter table expenses enable row level security;
alter table partner_withdrawals enable row level security;
alter table legacy_imports enable row level security;
alter table legacy_rows enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'partners', 'inventory_items', 'customers', 'bookings',
    'sales', 'expenses', 'partner_withdrawals', 'legacy_imports', 'legacy_rows'
  ]
  loop
    execute format('drop policy if exists "authenticated_select" on %I', t);
    execute format('drop policy if exists "authenticated_insert" on %I', t);
    execute format('drop policy if exists "authenticated_update" on %I', t);
    execute format('drop policy if exists "authenticated_delete" on %I', t);

    execute format(
      'create policy "authenticated_select" on %I for select to authenticated using (true)', t
    );
    execute format(
      'create policy "authenticated_insert" on %I for insert to authenticated with check (true)', t
    );
    execute format(
      'create policy "authenticated_update" on %I for update to authenticated using (true) with check (true)', t
    );
    execute format(
      'create policy "authenticated_delete" on %I for delete to authenticated using (true)', t
    );
  end loop;
end $$;

-- ============================================================
-- Auto-create a profile row whenever a new auth user signs up
-- ============================================================

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
