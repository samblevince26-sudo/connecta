-- Connecta — message attachments (media/file sharing).
--
-- Adds an `uploads` table (file metadata; bytes live on the app server's disk or
-- object storage) and a nullable `attachment` JSON column on both message tables.
-- Idempotent: safe to re-run. Applied automatically by the postgres Docker image
-- (initdb runs every file in this dir in order) and by `supabase db reset`.
--
-- For a hosted Supabase project, paste this into the SQL Editor or run:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0002_message_attachments.sql

create table if not exists public.uploads (
  id         text primary key,
  owner_id   uuid not null references public.users(id) on delete cascade,
  name       text not null,
  mime       text not null,
  size       bigint not null,
  created_at bigint not null
);
create index if not exists idx_uploads_owner on public.uploads (owner_id, created_at desc);

alter table public.messages       add column if not exists attachment text;
alter table public.group_messages add column if not exists attachment text;

-- RLS (Supabase only; skipped on plain Postgres). The Node backend connects with
-- a role that bypasses RLS, so these matter only for direct Supabase clients.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    raise notice 'auth.uid() not present — skipping uploads RLS (plain Postgres).';
    return;
  end if;

  execute 'alter table public.uploads enable row level security';
  execute 'drop policy if exists uploads_owner_select on public.uploads';
  execute 'create policy uploads_owner_select on public.uploads
             for select using (owner_id = auth.uid())';
  execute 'drop policy if exists uploads_owner_insert on public.uploads';
  execute 'create policy uploads_owner_insert on public.uploads
             for insert with check (owner_id = auth.uid())';
end $$;
