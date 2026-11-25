-- BACKSTAGE — Tri en masse des articles en attente devenus trop anciens.
-- Les articles choisis passent en « refusés » avec la mention « trop ancien » :
-- ils ne sont pas publiés, ne servent pas d'avis pour la veille, et restent consultables
-- dans l'onglet Refusés. Seuls les articles encore en attente sont touchés. Réexécutable.

create or replace function public.expire_editorial_drafts(p_ids uuid[])
returns integer language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  if not exists (select 1 from public.editorial_admins a where a.user_id = (select auth.uid())) then
    raise exception 'Accès rédaction refusé';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'Trop d''articles à la fois (200 au maximum).';
  end if;
  update public.editorial_drafts
     set status = 'rejected',
         decided_at = now(),
         published_at = null,
         quality = coalesce(quality, '{}'::jsonb) || jsonb_build_object('expired', true, 'expired_at', now())
   where id = any(p_ids) and status = 'pending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_editorial_drafts(uuid[]) from public, anon;
grant execute on function public.expire_editorial_drafts(uuid[]) to authenticated;

notify pgrst, 'reload schema';
