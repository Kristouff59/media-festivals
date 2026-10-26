-- BACKSTAGE : migration après le schéma initial déjà exécuté.
-- Peut être réexécutée : elle ne supprime aucun article ni compte.
alter table public.editorial_drafts
  add column if not exists topic_key text;
create unique index if not exists editorial_drafts_topic_unique
  on public.editorial_drafts(topic_key) where topic_key is not null;

create table if not exists public.editorial_radar_runs (
  slot text primary key,
  status text not null default 'running',
  detail text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.editorial_radar_runs enable row level security;
revoke all on public.editorial_radar_runs from anon, authenticated;
-- Cette table est réservée à la clé serveur, jamais au navigateur.

-- Les droits RLS existants des articles sont préservés.
-- Aucun job Cron n'est créé par cette migration :
-- activer le calendrier seulement après le déploiement et le test de la fonction.
