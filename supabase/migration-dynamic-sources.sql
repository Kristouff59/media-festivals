-- BACKSTAGE — sources vivantes, pas de liste fermée.
-- À exécuter après schema.sql et migration-radar.sql.
-- Aucune modification des articles et préférences existants.
create table if not exists public.editorial_sources (
  host text primary key check (host ~ '^[a-z0-9.-]{4,253}$'),
  name text not null check (char_length(name) between 2 and 180),
  site_url text not null check (site_url ~ '^https://'),
  sample_url text,
  source_kind text not null default 'festival'
    check (source_kind in ('festival', 'artiste', 'salle', 'organisateur', 'autre')),
  origin text not null default 'discovered'
    check (origin in ('seed', 'discovered')),
  status text not null default 'active'
    check (status in ('active', 'paused')),
  verified_articles integer not null default 0 check (verified_articles >= 0),
  last_verified_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists editorial_sources_rotation
  on public.editorial_sources(status, last_checked_at asc nulls first);
alter table public.editorial_sources enable row level security;
revoke all on public.editorial_sources from anon, authenticated;
grant select on public.editorial_sources to authenticated;
drop policy if exists editorial_sources_admin_read on public.editorial_sources;
create policy editorial_sources_admin_read on public.editorial_sources
  for select to authenticated using (
    exists (select 1 from public.editorial_admins a
            where a.user_id = (select auth.uid()))
  );

-- Les sources actuelles ne sont qu'un amorçage facultatif.
-- La table peut accueillir sans plafond les nouvelles sources vérifiées.
insert into public.editorial_sources(host,name,site_url,source_kind,origin)
values
  ('cabaretvert.com','Cabaret Vert','https://cabaretvert.com/programmation/','festival','seed'),
  ('rockwerchter.be','Rock Werchter','https://www.rockwerchter.be/en/news','festival','seed'),
  ('graspop.be','Graspop Metal Meeting','https://press.graspop.be/','festival','seed'),
  ('eurockeennes.fr','Eurockéennes','https://www.eurockeennes.fr/actualites/','festival','seed'),
  ('welovegreen.fr','We Love Green','https://www.welovegreen.fr/music/','festival','seed'),
  ('mainsquarefestival.fr','Main Square','https://mainsquarefestival.fr/','festival','seed'),
  ('hellfest.fr','Hellfest','https://hellfest.fr/','festival','seed'),
  ('dourfestival.eu','Dour','https://www.dourfestival.eu/','festival','seed'),
  ('rockenseine.com','Rock en Seine','https://www.rockenseine.com/','festival','seed'),
  ('pukkelpop.be','Pukkelpop','https://www.pukkelpop.be/en/','festival','seed')
on conflict(host) do nothing;

-- Exécutée exclusivement par le service backend avec sa clé serveur.
-- Un nom ou une URL générés par OpenAI seuls ne peuvent jamais
-- être enregistrés : le backend appelle ce RPC après validation
-- ET création d'une proposition d'article.
create or replace function public.learn_editorial_source(
  p_host text, p_name text, p_site_url text, p_sample_url text,
  p_source_kind text default 'autre'
)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if p_host is null or p_host !~ '^[a-z0-9.-]{4,253}$'
    or p_name is null or char_length(p_name) not between 2 and 180
    or p_site_url not like 'https://%'
    or p_source_kind not in ('festival','artiste','salle','organisateur','autre') then
    raise exception 'Source non valide';
  end if;
  insert into public.editorial_sources(
    host,name,site_url,sample_url,source_kind,origin,
    verified_articles,last_verified_at
  )
  values (
    p_host,p_name,p_site_url,p_sample_url,p_source_kind,'discovered',1,now()
  )
  on conflict(host) do update
    set verified_articles = public.editorial_sources.verified_articles + 1,
        last_verified_at = now(),
        sample_url = excluded.sample_url;
end;
$$;
revoke all on function public.learn_editorial_source(text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.learn_editorial_source(text,text,text,text,text)
  to service_role;

-- Avance la rotation pour tous les sites tentés, même inaccessibles.
-- Pas de boucle de requêtes SQL, ni de suivi limité aux premiers sites.
create or replace function public.mark_editorial_sources_checked(p_hosts text[])
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  update public.editorial_sources
  set last_checked_at=now()
  where host=any(p_hosts) and status='active';
end;
$$;
revoke all on function public.mark_editorial_sources_checked(text[])
  from public,anon,authenticated;
grant execute on function public.mark_editorial_sources_checked(text[])
  to service_role;
notify pgrst, 'reload schema';
