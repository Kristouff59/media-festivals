-- BACKSTAGE : migration après le schéma initial déjà exécuté.
-- Peut être réexécutée : elle ne supprime aucun article ni compte.
alter table public.editorial_drafts
  add column if not exists topic_key text;
-- PostgREST upsert utilise ON CONFLICT (topic_key).
-- Un index unique partiel « WHERE topic_key IS NOT NULL » n'est pas compatible
-- sans fournir sa condition. PostgreSQL accepte plusieurs NULL dans un
-- index unique ordinaire, donc cet index complet protège aussi les anciens
-- brouillons dont topic_key est NULL.
drop index if exists public.editorial_drafts_topic_unique;
create unique index editorial_drafts_topic_unique
  on public.editorial_drafts(topic_key);
notify pgrst, 'reload schema';

create table if not exists public.editorial_radar_runs (
  slot text primary key,
  status text not null default 'running',
  detail text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.editorial_radar_runs enable row level security;
revoke all on public.editorial_radar_runs from anon, authenticated;
grant select on public.editorial_radar_runs to authenticated;
drop policy if exists editorial_admin_radar_status on public.editorial_radar_runs;
create policy editorial_admin_radar_status on public.editorial_radar_runs
  for select to authenticated using (
    exists (select 1 from public.editorial_admins a
            where a.user_id = (select auth.uid()))
  );
-- Seuls les rédacteurs connectés peuvent consulter le statut du radar.
-- Aucune insertion ou modification depuis le navigateur.

-- Les droits RLS existants des articles sont préservés.
-- Aucun job Cron n'est créé par cette migration :
-- activer le calendrier seulement après le déploiement et le test de la fonction.
