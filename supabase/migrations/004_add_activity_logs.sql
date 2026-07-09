create table if not exists activity_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity text not null,
  entity_id uuid null,
  details jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table activity_logs enable row level security;

drop policy if exists "authenticated_select" on activity_logs;
drop policy if exists "authenticated_insert" on activity_logs;
drop policy if exists "authenticated_update" on activity_logs;
drop policy if exists "authenticated_delete" on activity_logs;

create policy "authenticated_select" on activity_logs for select to authenticated using (true);
create policy "authenticated_insert" on activity_logs for insert to authenticated with check (true);
create policy "authenticated_update" on activity_logs for update to authenticated using (true) with check (true);
create policy "authenticated_delete" on activity_logs for delete to authenticated using (true);

create index if not exists idx_activity_logs_created_at on activity_logs(created_at);
create index if not exists idx_activity_logs_action on activity_logs(action);
