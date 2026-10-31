-- BACKSTAGE : suppression éditoriale avec trace de sécurité.
-- Une suppression retire immédiatement un article publié de la sélection
-- Supabase, et masque également une éventuelle copie intégrée au site.
-- Les données restent archivées (status='deleted') pour empêcher un
-- retour accidentel via la veille et permettre un audit interne.
alter table public.editorial_drafts
  drop constraint if exists editorial_drafts_status_check;
alter table public.editorial_drafts
  add constraint editorial_drafts_status_check
  check (status in ('pending','rejected','published','deleted'));

create table if not exists public.editorial_hidden_articles (
  slug text primary key check (length(slug) between 1 and 180),
  hidden_at timestamptz not null default now()
);
alter table public.editorial_hidden_articles enable row level security;
revoke all on public.editorial_hidden_articles from public, anon, authenticated;

-- Pour le site public : retourner UNIQUEMENT les slugs exclus, sans
-- divulguer titres, brouillons, comptes ni contenu supprimé.
create or replace function public.list_hidden_article_slugs()
returns table(slug text)
language sql stable security definer set search_path = ''
as $$
  select h.slug from public.editorial_hidden_articles h;
$$;
revoke all on function public.list_hidden_article_slugs() from public;
grant execute on function public.list_hidden_article_slugs() to anon, authenticated;

create or replace function public.remove_editorial_article(
  p_draft_id uuid default null,
  p_slug text default null
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_slug text;
  v_status text;
begin
  if not exists(
    select 1 from public.editorial_admins a
    where a.user_id=(select auth.uid())
  ) then raise exception 'Accès rédaction refusé'; end if;
  if p_draft_id is not null then
    select d.slug,d.status into v_slug,v_status
    from public.editorial_drafts d where d.id=p_draft_id for update;
    if not found then raise exception 'Article introuvable'; end if;
    if v_status='deleted' then return 'already_deleted'; end if;
    update public.editorial_drafts
       set status='deleted'
     where id=p_draft_id;
  elsif p_slug is not null and length(p_slug) between 1 and 180 then
    v_slug := p_slug;
    -- Également traiter toute version publiée en base du même slug.
    update public.editorial_drafts set status='deleted'
    where slug=v_slug and status <> 'deleted';
  else
    raise exception 'Identifiant ou slug requis';
  end if;
  insert into public.editorial_hidden_articles(slug)
    values(v_slug) on conflict (slug) do nothing;
  return 'deleted';
end;
$$;
revoke all on function public.remove_editorial_article(uuid,text) from public,anon;
grant execute on function public.remove_editorial_article(uuid,text) to authenticated;
notify pgrst, 'reload schema';
