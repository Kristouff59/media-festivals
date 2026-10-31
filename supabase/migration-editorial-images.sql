-- BACKSTAGE : édition des visuels autorisés des brouillons en attente.
-- Aucune modification des articles déjà publiés ni accès direct en écriture.
create or replace function public.update_editorial_draft_images(
 p_draft_id uuid, p_hero jsonb, p_inline jsonb default '[]'::jsonb
) returns text language plpgsql security definer set search_path = ''
as $$
declare v_status text; v_image jsonb;
begin
 if not exists(select 1 from public.editorial_admins a where a.user_id=(select auth.uid())) then
   raise exception 'Accès rédaction refusé';
 end if;
 select status into v_status from public.editorial_drafts where id=p_draft_id for update;
 if not found then raise exception 'Article introuvable'; end if;
 if v_status<>'pending' then raise exception 'Seuls les brouillons en attente sont modifiables'; end if;
 if p_hero is not null and p_hero <> 'null'::jsonb then
   if jsonb_typeof(p_hero)<>'object' then raise exception 'Couverture invalide'; end if;
   if coalesce(p_hero->>'url','') !~ '^https://[^[:space:]<>"'']+$'
      or length(coalesce(p_hero->>'alt',''))<3
      or length(coalesce(p_hero->>'credit',''))<2 then
     raise exception 'Couverture incomplète ou URL invalide';
   end if;
 end if;
 if jsonb_typeof(p_inline)<>'array' or jsonb_array_length(p_inline)>4 then
   raise exception 'Quatre illustrations maximum';
 end if;
 for v_image in select value from jsonb_array_elements(p_inline) loop
   if jsonb_typeof(v_image)<>'object'
      or coalesce(v_image->>'url','') !~ '^https://[^[:space:]<>"'']+$'
      or length(coalesce(v_image->>'alt',''))<3
      or length(coalesce(v_image->>'credit',''))<2
      or (v_image->>'afterSection') !~ '^[0-9]+$' then
     raise exception 'Illustration invalide';
   end if;
 end loop;
 update public.editorial_drafts
 set payload=jsonb_set(
   jsonb_set(payload,'{article,heroImage}',coalesce(p_hero,'null'::jsonb),true),
   '{article,inlineImages}',p_inline,true)
 where id=p_draft_id;
 return 'saved';
end;
$$;
revoke all on function public.update_editorial_draft_images(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.update_editorial_draft_images(uuid,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
