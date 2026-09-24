-- Connecta — initial Postgres schema for Supabase.
--
-- Mirrors the SQLite schema in server/src/db.js so the app's data model maps
-- 1:1 onto Postgres. Two things to know before you run this:
--
--   * ids are uuid (Supabase Auth assigns them). The current Node backend
--     generates its own uuids + bcrypt/JWT auth; if you keep that backend you
--     connect with the service_role key (RLS bypassed) and ids still line up.
--     If you switch to Supabase Auth, users.id should equal auth.users.id.
--   * created_at / *_at are bigint epoch-milliseconds to match Date.now() in
--     the app code. Swap to timestamptz if you also migrate the app layer.
--
-- Apply with either:
--   supabase db reset            (local, via the Supabase CLI — runs this file)
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_init.sql
-- or paste into the Supabase SQL editor.

create extension if not exists pgcrypto;

-- --------------------------------- users ----------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null,
  password_hash text not null,
  display_name  text not null,
  created_at    bigint not null
);
-- Case-insensitive uniqueness (SQLite used COLLATE NOCASE).
create unique index if not exists users_username_lower_key
  on public.users (lower(username));

-- -------------------------------- contacts --------------------------------
create table if not exists public.contacts (
  owner_id   uuid not null references public.users(id) on delete cascade,
  contact_id uuid not null references public.users(id) on delete cascade,
  created_at bigint not null,
  primary key (owner_id, contact_id)
);

-- -------------------------------- messages -------------------------------
create table if not exists public.messages (
  id           bigint generated always as identity primary key,
  sender_id    uuid not null references public.users(id) on delete cascade,
  recipient_id uuid not null references public.users(id) on delete cascade,
  body         text not null,
  created_at   bigint not null,
  delivered    boolean not null default false,
  read         boolean not null default false
);
create index if not exists idx_messages_thread
  on public.messages (sender_id, recipient_id, created_at);

-- --------------------------------- calls ---------------------------------
create table if not exists public.calls (
  id         uuid primary key default gen_random_uuid(),
  caller_id  uuid not null references public.users(id) on delete cascade,
  callee_id  uuid not null references public.users(id) on delete cascade,
  kind       text not null,
  status     text not null,
  started_at bigint not null,
  ended_at   bigint
);
create index if not exists idx_calls_participant
  on public.calls (caller_id, started_at desc);
create index if not exists idx_calls_callee
  on public.calls (callee_id, started_at desc);

-- -------------------------------- groups ---------------------------------
create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid not null references public.users(id) on delete cascade,
  created_at bigint not null
);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null references public.users(id) on delete cascade,
  joined_at bigint not null,
  primary key (group_id, user_id)
);
create index if not exists idx_group_members_user
  on public.group_members (user_id);

create table if not exists public.group_messages (
  id         bigint generated always as identity primary key,
  group_id   uuid not null references public.groups(id) on delete cascade,
  sender_id  uuid not null references public.users(id) on delete cascade,
  body       text not null,
  created_at bigint not null
);
create index if not exists idx_group_messages
  on public.group_messages (group_id, created_at desc, id desc);

create table if not exists public.group_reads (
  group_id         uuid not null references public.groups(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  last_read_msg_id bigint not null default 0,
  primary key (group_id, user_id)
);

-- ============================= Row Level Security =========================
--
-- These policies matter only for clients that authenticate as a Supabase Auth
-- user (anon/authenticated JWTs). A server-side backend using the
-- service_role key bypasses RLS entirely — that is expected and how the Node
-- server would talk to Postgres today. Enable RLS so that IF you later expose
-- the DB directly to a browser/mobile client, users only see their own data.

alter table public.users           enable row level security;
alter table public.contacts        enable row level security;
alter table public.messages        enable row level security;
alter table public.calls           enable row level security;
alter table public.groups          enable row level security;
alter table public.group_members   enable row level security;
alter table public.group_messages  enable row level security;
alter table public.group_reads     enable row level security;

-- users: you can read your own row; password_hash is never exposed via select *
-- to other users because of the id = auth.uid() guard below.
drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
  for select using (id = auth.uid());

-- contacts: only your own contact edges.
drop policy if exists contacts_owner on public.contacts;
create policy contacts_owner on public.contacts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- messages: visible to sender or recipient.
drop policy if exists messages_participant on public.messages;
create policy messages_participant on public.messages
  for select using (sender_id = auth.uid() or recipient_id = auth.uid());
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert with check (sender_id = auth.uid());

-- calls: visible to caller or callee.
drop policy if exists calls_participant on public.calls;
create policy calls_participant on public.calls
  for select using (caller_id = auth.uid() or callee_id = auth.uid());

-- group_members: you can see the roster of groups you belong to.
drop policy if exists group_members_visible on public.group_members;
create policy group_members_visible on public.group_members
  for select using (
    user_id = auth.uid()
    or group_id in (select group_id from public.group_members where user_id = auth.uid())
  );

-- groups: readable if you are a member.
drop policy if exists groups_member on public.groups;
create policy groups_member on public.groups
  for select using (
    id in (select group_id from public.group_members where user_id = auth.uid())
  );

-- group_messages: readable/postable only within your groups.
drop policy if exists group_messages_member on public.group_messages;
create policy group_messages_member on public.group_messages
  for select using (
    group_id in (select group_id from public.group_members where user_id = auth.uid())
  );
drop policy if exists group_messages_insert on public.group_messages;
create policy group_messages_insert on public.group_messages
  for insert with check (
    sender_id = auth.uid()
    and group_id in (select group_id from public.group_members where user_id = auth.uid())
  );

-- group_reads: your own read cursors.
drop policy if exists group_reads_own on public.group_reads;
create policy group_reads_own on public.group_reads
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
