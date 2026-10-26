-- BACKSTAGE · boîte éditoriale privée (Supabase Postgres)
-- Exécuter une seule fois dans l'éditeur SQL d'un projet Supabase dédié.
create table if not exists public.editorial_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.editorial_admins enable row level security;
drop policy if exists editorial_admin_self on public.editorial_admins;
create policy editorial_admin_self on public.editorial_admins
  for select to authenticated using ((select auth.uid()) = user_id);

create table if not exists public.editorial_drafts (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique
    check (fingerprint ~ '^[a-f0-9]{64}$'),
  slug text not null,
  title text not null,
  excerpt text,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','published')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  published_at timestamptz
);
create index if not exists idx_editorial_drafts_status_date
  on public.editorial_drafts(status, created_at desc);
alter table public.editorial_drafts enable row level security;
drop policy if exists editorial_admin_read on public.editorial_drafts;
create policy editorial_admin_read on public.editorial_drafts
  for select to authenticated using (
    exists (select 1 from public.editorial_admins a
            where a.user_id = (select auth.uid()))
  );
-- Aucune écriture directe possible depuis le navigateur.
-- Insertion et confirmation de publication : scripts serveur (clé secrète).
-- Approbation : fonction SQL transactionnelle ci-dessous.

create or replace function public.decide_editorial_draft(
  p_draft_id uuid,
  p_decision text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not exists (
    select 1 from public.editorial_admins a
    where a.user_id = (select auth.uid())
  ) then
    raise exception 'Accès rédaction refusé';
  end if;
  if p_decision not in ('approved','rejected') then
    raise exception 'Décision incorrecte';
  end if;
  select status into v_status
  from public.editorial_drafts
  where id = p_draft_id
  for update;
  if not found then
    raise exception 'Article introuvable';
  end if;
  if v_status <> 'pending' then
    raise exception 'Article déjà traité (%).', v_status;
  end if;
  update public.editorial_drafts
  set status = p_decision, decided_at = now()
  where id = p_draft_id;
  return p_decision;
end;
$$;
revoke all on function public.decide_editorial_draft(uuid,text) from public,anon;
grant execute on function public.decide_editorial_draft(uuid,text) to authenticated;

-- Après première connexion avec son compte Supabase Auth :
-- 1. Dashboard Supabase > Authentication > Users > copier le User UID
-- 2. Remplacer l'UUID ci-dessous puis exécuter :
-- insert into public.editorial_admins (user_id)
-- values ('VOTRE-USER-UID-ICI');
