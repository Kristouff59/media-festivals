-- BACKSTAGE · Mémoire éditoriale des refus motivés.
-- Exécuter une fois APRÈS supabase/schema.sql et migration-radar.sql.
-- Aucun article, compte ni ancienne décision n'est effacé.
create table if not exists public.editorial_feedback (
  draft_id uuid primary key references public.editorial_drafts(id) on delete cascade,
  article_title text not null,
  category text not null check (category in (
    'artiste', 'ligne_editoriale', 'angle', 'style', 'fiabilite',
    'actualite', 'autre'
  )),
  reason text not null check (char_length(btrim(reason)) between 8 and 1500),
  apply_to_future boolean not null default true,
  submitted_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists editorial_feedback_recent
  on public.editorial_feedback(created_at desc);

-- Toutes les observations restent privées, même lorsque des articles
-- sont publiés sur le site. Aucune modification directe du navigateur.
alter table public.editorial_feedback enable row level security;
revoke all on public.editorial_feedback from anon, authenticated;
grant select on public.editorial_feedback to authenticated;
drop policy if exists editorial_feedback_admin_read on public.editorial_feedback;
create policy editorial_feedback_admin_read on public.editorial_feedback
  for select to authenticated using (
    exists (
      select 1 from public.editorial_admins a
      where a.user_id = (select auth.uid())
    )
  );

-- Transaction atomique : vérifier les droits, enregistrer le retour et
-- refuser le brouillon. Seul un rédacteur authentifié peut l'exécuter.
create or replace function public.reject_editorial_draft_with_feedback(
  p_draft_id uuid,
  p_category text,
  p_reason text,
  p_apply_to_future boolean default true
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_title text;
begin
  if not exists (
    select 1 from public.editorial_admins a
    where a.user_id = (select auth.uid())
  ) then
    raise exception 'Accès rédaction refusé';
  end if;

  if p_category is null or p_category not in (
    'artiste', 'ligne_editoriale', 'angle', 'style',
    'fiabilite', 'actualite', 'autre'
  ) then
    raise exception 'Catégorie de refus incorrecte';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 8 and 1500 then
    raise exception 'Motif de refus attendu : entre 8 et 1500 caractères';
  end if;

  select status, title into v_status, v_title
  from public.editorial_drafts
  where id = p_draft_id
  for update;
  if not found then
    raise exception 'Article introuvable';
  end if;
  if v_status <> 'pending' then
    raise exception 'Article déjà traité (%)', v_status;
  end if;

  insert into public.editorial_feedback (
    draft_id, article_title, category, reason,
    apply_to_future, submitted_by
  )
  values (
    p_draft_id, v_title, p_category,
    btrim(p_reason), coalesce(p_apply_to_future, true), (select auth.uid())
  );

  update public.editorial_drafts
  set status = 'rejected', decided_at = now(), published_at = null
  where id = p_draft_id;

  return 'rejected';
end;
$$;

revoke all on function public.reject_editorial_draft_with_feedback(uuid,text,text,boolean)
  from public, anon;
grant execute on function public.reject_editorial_draft_with_feedback(uuid,text,text,boolean)
  to authenticated;

notify pgrst, 'reload schema';
