-- Connecta — optional email login alias.
--
-- Adds a nullable, unique `email` column to users so accounts can sign up with an
-- email and sign in with either their username or email. NULLs are distinct, so
-- many users may leave it empty. Idempotent: safe to re-run.
--
-- For a hosted Supabase project, paste this into the SQL Editor or run:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0003_user_email.sql

alter table public.users add column if not exists email text;
create unique index if not exists users_email_key on public.users (email);
