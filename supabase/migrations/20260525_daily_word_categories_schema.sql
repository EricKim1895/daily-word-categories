create extension if not exists pgcrypto with schema extensions;

create table if not exists public.puzzles (
  date date primary key,
  words text[] not null check (array_length(words, 1) = 16),
  categories jsonb not null check (
    jsonb_typeof(categories) = 'array'
    and jsonb_array_length(categories) = 4
  ),
  source_model text not null default 'manual',
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.userprogress (
  userid uuid not null references auth.users(id) on delete cascade,
  puzzledate date not null references public.puzzles(date) on delete cascade,
  solvedat timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (userid, puzzledate)
);

create index if not exists userprogress_puzzledate_idx
on public.userprogress (puzzledate);

alter table public.puzzles enable row level security;
alter table public.userprogress enable row level security;

drop policy if exists puzzles_select_all on public.puzzles;
drop policy if exists userprogress_select_own on public.userprogress;
drop policy if exists userprogress_insert_own on public.userprogress;
drop policy if exists userprogress_update_own on public.userprogress;
drop policy if exists userprogress_delete_own on public.userprogress;

create policy puzzles_select_all
on public.puzzles
for select
to anon, authenticated
using (true);

create policy userprogress_select_own
on public.userprogress
for select
to authenticated
using (auth.uid() = userid);

create policy userprogress_insert_own
on public.userprogress
for insert
to authenticated
with check (auth.uid() = userid);

create policy userprogress_update_own
on public.userprogress
for update
to authenticated
using (auth.uid() = userid)
with check (auth.uid() = userid);

create policy userprogress_delete_own
on public.userprogress
for delete
to authenticated
using (auth.uid() = userid);

grant select on public.puzzles to anon, authenticated;
grant select, insert, update, delete on public.userprogress to authenticated;
