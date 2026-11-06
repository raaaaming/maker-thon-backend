-- Run once in Supabase Dashboard -> SQL Editor. Safe to re-run.
-- The backend uses the secret key (bypasses RLS). RLS below protects the tables
-- if anyone calls the Supabase Data API with the publishable key / a user token:
-- users may only READ their own rows; all writes go through the backend.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 50),
  created_at timestamptz not null default now()
);

create table if not exists public.devices (
  id text primary key,
  name text not null,
  last_seen_at timestamptz
);

create table if not exists public.device_members (
  device_id text not null references public.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (device_id, user_id)
);

create table if not exists public.toilet_sessions (
  id text primary key,
  device_id text not null references public.devices(id),
  user_id uuid references auth.users(id) on delete cascade,   -- null until a user claims it
  measurement_status text not null check (measurement_status in ('measuring','completed','discarded')),
  started_at timestamptz,
  ended_at timestamptz,
  completed_at timestamptz,
  sitting_sec double precision,
  time_source text not null check (time_source in ('sensor','unknown')),
  clock_status text not null check (clock_status in ('synced','unknown')),
  stool_color text,
  urine_color text,
  color_status text not null,
  spectral_raw jsonb,
  env jsonb,
  shape integer check (shape between 1 and 7),
  shape_status text,
  excretion_type text,
  claimed_at timestamptz,
  received_at timestamptz not null default now()
);
-- Added after the first release; safe to re-run.
alter table public.toilet_sessions add column if not exists analysis jsonb;  -- full board packet
alter table public.devices add column if not exists status jsonb;            -- last heartbeat diagnostics
create index if not exists toilet_sessions_owner on public.toilet_sessions (user_id, ended_at desc);
create index if not exists toilet_sessions_candidates on public.toilet_sessions (device_id, measurement_status, ended_at) where user_id is null;

create table if not exists public.meals (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  foods jsonb not null,
  eaten_at timestamptz not null,
  photo text,
  source text not null check (source in ('ai','manual')),
  created_at timestamptz not null default now()
);
create index if not exists meals_owner on public.meals (user_id, eaten_at desc);

-- Prevents a late board resend from resurrecting a record the user deleted.
create table if not exists public.deleted_sessions (
  id text primary key,
  device_id text not null
);

-- Last time a user tapped the NFC tag at a device (one row per device+user).
create table if not exists public.checkins (
  device_id text not null references public.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  checked_at timestamptz not null default now(),
  primary key (device_id, user_id)
);

insert into public.devices (id, name) values ('toilet-01', '우리 변기') on conflict do nothing;

-- Auto-create a profile when someone signs up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(nullif(split_part(new.email, '@', 1), ''), '사용자'), 50))
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row Level Security
alter table public.profiles        enable row level security;
alter table public.devices         enable row level security;
alter table public.device_members  enable row level security;
alter table public.toilet_sessions enable row level security;
alter table public.meals           enable row level security;
alter table public.deleted_sessions enable row level security;
alter table public.checkins        enable row level security;

revoke all on public.profiles, public.devices, public.device_members,
  public.toilet_sessions, public.meals, public.deleted_sessions, public.checkins from anon, authenticated;
grant select on public.profiles, public.devices, public.device_members,
  public.toilet_sessions, public.meals to authenticated;

drop policy if exists "own profile"  on public.profiles;
create policy "own profile"  on public.profiles        for select to authenticated using (id = (select auth.uid()));
drop policy if exists "own links"    on public.device_members;
create policy "own links"    on public.device_members  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own devices"  on public.devices;
create policy "own devices"  on public.devices         for select to authenticated using (
  exists (select 1 from public.device_members m where m.device_id = devices.id and m.user_id = (select auth.uid())));
drop policy if exists "own records"  on public.toilet_sessions;
create policy "own records"  on public.toilet_sessions for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own meals"    on public.meals;
create policy "own meals"    on public.meals           for select to authenticated using (user_id = (select auth.uid()));
-- deleted_sessions: RLS on, no policy -> invisible to API roles.
