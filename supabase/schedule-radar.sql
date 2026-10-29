-- Exécuter UNIQUEMENT après le déploiement de backstage-radar et la mise
-- en place des secrets OPENAI_API_KEY et Supabase Vault.
-- Clé privée : ne jamais coller sa valeur dans GitHub ni dans cette conversation.
--
-- Créer d'abord dans l'interface Database > Vault > Secrets un secret
-- nommé backstage_cron_secret avec pour valeur la clé serveur sb_secret_....
-- Ne jamais écrire cette clé dans ce fichier, les logs ou un message.
--
-- L'URL du projet public est connue ; la clé serveur ne figure jamais ici.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- Échec explicite si la clé n'a pas été enregistrée dans Vault.
do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'backstage_cron_secret'
  ) then
    raise exception 'Créer le secret backstage_cron_secret dans Supabase Vault avant de planifier la veille';
  end if;
end $$;

-- Supprimer l'ancien job homonyme au cas où il existe, pour éviter des doublons.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'backstage-radar-matin-soir') then
    perform cron.unschedule('backstage-radar-matin-soir');
  end if;
end $$;

select cron.schedule(
  'backstage-radar-matin-soir',
  '0 5,6,16,17 * * *', -- créneaux UTC possibles pour 07:00/18:00 à Paris
  -- pg_cron reste en UTC : ce filtre exécute la requête HTTP uniquement
  -- à 07 h et 18 h heure de Paris, hiver comme été. Les deux autres
  -- passages SQL sont des opérations sans réseau et sans coût OpenAI.
  $job$
    select net.http_post(
      url := 'https://vvwkkgpahrsojmpteexz.supabase.co/functions/v1/backstage-radar',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'backstage_cron_secret'
          limit 1
        )
      ),
      body := '{"source":"cron"}'::jsonb,
      timeout_milliseconds := 130000
    )
    where extract(hour from now() at time zone 'Europe/Paris') in (7,18);
  $job$
);

-- Après : inspecter Database > Cron > Jobs ou
-- select jobid, jobname, schedule, active from cron.job;
-- Pour arrêter : select cron.unschedule('backstage-radar-matin-soir');
