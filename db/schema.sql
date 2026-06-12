-- SUPERCOACH — Schema Supabase
-- Branche: feature/auth
-- Date: 2026-06-12

-- Extension UUID
create extension if not exists "uuid-ossp";

-- ══════════════════════════════════════════
-- TABLE PROFILES (liée à auth.users)
-- ══════════════════════════════════════════
create table public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  username      text unique,
  avatar_id     text default 'coach_01',
  language      text default 'en',
  user_timezone text default 'Europe/Paris',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ══════════════════════════════════════════
-- TABLE BANKROLL
-- ══════════════════════════════════════════
create table public.bankroll (
  id                uuid default uuid_generate_v4() primary key,
  user_id           uuid references public.profiles(id) on delete cascade unique,
  current_bankroll  decimal(10,2) default 1000.00,
  default_unit_size decimal(10,2) default 10.00,
  currency          text default 'EUR',
  updated_at        timestamptz default now()
);

-- ══════════════════════════════════════════
-- TABLE STATS
-- ══════════════════════════════════════════
create table public.stats (
  id              uuid default uuid_generate_v4() primary key,
  user_id         uuid references public.profiles(id) on delete cascade unique,
  total_analyses  integer default 0,
  total_picks     integer default 0,
  wins            integer default 0,
  losses          integer default 0,
  draws           integer default 0,
  roi             decimal(6,2) default 0.00,
  yield           decimal(6,2) default 0.00,
  last_updated    timestamptz default now()
);

-- ══════════════════════════════════════════
-- TABLE ANALYSES (historique)
-- ══════════════════════════════════════════
create table public.analyses (
  id            uuid default uuid_generate_v4() primary key,
  user_id       uuid references public.profiles(id) on delete cascade,
  matches       jsonb not null,
  result        text check (result in ('win','loss','draw','pending')) default 'pending',
  roi_pct       decimal(6,2),
  sport         text,
  competition   text,
  analysis_date date default current_date,
  created_at    timestamptz default now()
);

-- ══════════════════════════════════════════
-- TABLE SUBSCRIPTIONS
-- ══════════════════════════════════════════
create table public.subscriptions (
  id                    uuid default uuid_generate_v4() primary key,
  user_id               uuid references public.profiles(id) on delete cascade unique,
  plan                  text default 'free' check (plan in ('free','starter','pro')),
  status                text default 'active' check (status in ('active','cancelled','expired')),
  provider              text,
  provider_id           text,
  preferred_bookmaker   text,
  started_at            timestamptz,
  expires_at            timestamptz,
  created_at            timestamptz default now()
);

-- ══════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════
alter table public.profiles      enable row level security;
alter table public.bankroll      enable row level security;
alter table public.stats         enable row level security;
alter table public.analyses      enable row level security;
alter table public.subscriptions enable row level security;

-- Policies : chaque user ne voit que ses propres données
create policy "Own profile" on public.profiles
  for all using (auth.uid() = id);

create policy "Own bankroll" on public.bankroll
  for all using (auth.uid() = user_id);

create policy "Own stats" on public.stats
  for all using (auth.uid() = user_id);

create policy "Own analyses" on public.analyses
  for all using (auth.uid() = user_id);

create policy "Own subscription" on public.subscriptions
  for all using (auth.uid() = user_id);

-- ══════════════════════════════════════════
-- TRIGGER : créer profil auto à l'inscription
-- ══════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, language)
  values (
    new.id,
    split_part(new.email, '@', 1),
    coalesce(new.raw_user_meta_data->>'language', 'en')
  );
  insert into public.bankroll (user_id) values (new.id);
  insert into public.stats    (user_id) values (new.id);
  insert into public.subscriptions (user_id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
