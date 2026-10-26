-- Exécuter UNIQUEMENT après le déploiement de backstage-radar et la mise
-- en place des secrets OPENAI_API_KEY et Supabase Vault.
-- Clé privée : ne jamais coller sa valeur dans GitHub ni dans cette conversation.
--
-- Dans SQL Editor, exécuter UNE FOIS en remplaçant LE_SECRET uniquement :
-- select vault.create_secret('VOTRE_CLE_sb_secret_...', 'backstage_cron_secret');
--
-- L'URL du projet public est connue ; la clé serveur ne figure jamais ici.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- Supprimer l'ancien job homonyme au cas où il existe, pour éviter des doublons.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'backstage-radar-matin-soir') then
    perform cron.unschedule('backstage-radar-matin-soir');
  end if;
end $$;

select cron.schedule(
  'backstage-radar-matin-soir',
  '17 7,18 * * *', -- UTC, 2 fois par jour (l'heure française varie avec l'heure d'été)
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
      timeout_milliseconds := 10000
    );
  $job$
);

-- Après : inspecter Database > Cron > Jobs ou
-- select jobid, jobname, schedule, active from cron.job;
-- Pour arrêter : select cron.unschedule('backstage-radar-matin-soir');
