-- BACKSTAGE v2 — pistes persistantes, récits et preuves de vérification.
-- À exécuter APRÈS toutes les migrations existantes. Réexécutable.
-- N'efface, ne modifie et ne publie aucun article existant.

-- 1. Les pistes : chaque annonce repérée devient un dossier qui avance.
create table if not exists public.editorial_leads (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'openai'
    check (channel in ('officiel', 'openai', 'manuel')),
  status text not null default 'new'
    check (status in ('new','retry','verified','needs_review','rejected',
                      'duplicate','written','write_failed','dismissed')),
  shadow boolean not null default false,
  title text not null check (char_length(title) between 5 and 300),
  why_now text,
  official_url text not null check (official_url ~ '^https://'),
  canonical_url text not null,
  event_name text,
  edition integer check (edition is null or edition between 2020 and 2040),
  kind text not null default 'other'
    check (kind in ('lineup','tour','concert','cancellation','industry','other')),
  artists text[] not null default '{}',
  places text[] not null default '{}',
  press_urls text[] not null default '{}',
  claimed_publication_date date,          -- affirmation du modèle : jamais une preuve
  listing_hint jsonb,                     -- date lue par le serveur dans un sommaire officiel
  priority smallint not null default 50 check (priority between 0 and 100),
  story_key text,
  -- Journal de vérification structuré (voir verify.ts)
  verification jsonb,
  publication_date date,
  date_evidence_url text,
  date_evidence_type text,
  rejection_reason text,
  source_text text,                       -- contenu officiel transmis à la rédaction
  story_verdict jsonb,
  draft_id uuid references public.editorial_drafts(id) on delete set null,
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  discovered_slot text,
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (canonical_url, story_key)
);
create index if not exists editorial_leads_queue
  on public.editorial_leads(status, next_attempt_at);
create index if not exists editorial_leads_recent
  on public.editorial_leads(created_at desc);

alter table public.editorial_leads enable row level security;
revoke all on public.editorial_leads from anon, authenticated;
grant select on public.editorial_leads to authenticated;
drop policy if exists editorial_leads_admin_read on public.editorial_leads;
create policy editorial_leads_admin_read on public.editorial_leads
  for select to authenticated using (
    exists (select 1 from public.editorial_admins a where a.user_id = (select auth.uid()))
  );

-- 2. Les brouillons gardent leur forme actuelle (le site n'est pas touché) ;
--    ils gagnent un lien vers leur piste, leur récit et la relecture automatique.
alter table public.editorial_drafts add column if not exists lead_id uuid;
alter table public.editorial_drafts add column if not exists story_key text;
alter table public.editorial_drafts add column if not exists story jsonb;
alter table public.editorial_drafts add column if not exists quality jsonb;
create index if not exists editorial_drafts_story on public.editorial_drafts(story_key);

-- 3. Décision humaine sur une piste « à examiner ».
--    Valider = la preuve est jugée suffisante : la piste part en rédaction.
--    Écarter = elle ne sera plus proposée.
create or replace function public.review_editorial_lead(
  p_lead_id uuid, p_decision text, p_publication_date date default null
)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_status text;
begin
  if not exists (select 1 from public.editorial_admins a where a.user_id = (select auth.uid())) then
    raise exception 'Accès rédaction refusé';
  end if;
  if p_decision not in ('verified', 'dismissed') then
    raise exception 'Décision incorrecte';
  end if;
  select status into v_status from public.editorial_leads where id = p_lead_id for update;
  if not found then raise exception 'Piste introuvable'; end if;
  if v_status not in ('needs_review', 'rejected', 'retry', 'write_failed') then
    raise exception 'Piste déjà traitée (%).', v_status;
  end if;
  update public.editorial_leads set
    status = p_decision,
    publication_date = coalesce(p_publication_date, publication_date),
    date_evidence_type = case when p_decision = 'verified' and p_publication_date is not null
      then 'validation_humaine' else date_evidence_type end,
    rejection_reason = case when p_decision = 'verified' then null else rejection_reason end,
    reviewed_by = (select auth.uid()),
    next_attempt_at = now(), updated_at = now()
  where id = p_lead_id;
  return p_decision;
end;
$$;
revoke all on function public.review_editorial_lead(uuid, text, date) from public, anon;
grant execute on function public.review_editorial_lead(uuid, text, date) to authenticated;

-- 4. Purge : les pistes rejetées depuis plus de 60 jours n'apportent plus rien.
create or replace function public.trim_editorial_leads()
returns void language sql security invoker set search_path = ''
as $$
  delete from public.editorial_leads
  where status in ('rejected', 'dismissed', 'duplicate')
    and updated_at < now() - interval '60 days';
$$;
revoke all on function public.trim_editorial_leads() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- 5. Journal des appels : la veille dédiée aux grands festivals a son propre libellé.
alter table public.editorial_ai_logs drop constraint if exists editorial_ai_logs_stage_check;
alter table public.editorial_ai_logs add constraint editorial_ai_logs_stage_check
  check (stage = any (array['decouverte'::text, 'redaction'::text, 'veille_festivals'::text]));
