-- BACKSTAGE — 07:00 et 18:00 heure française, été comme hiver.
-- Version sans bloc DO et sans dollar-quoting.
-- Prérequis : pg_cron, pg_net, Supabase Vault, secret backstage_cron_secret.
-- Aucune clé privée n'est stockée dans le code.

-- Si le job existe déjà, le remplacer proprement sans doublon.
select cron.unschedule(jobid)
from cron.job
where jobname = 'backstage-radar-matin-soir';

-- UTC : 05/06 et 16/17, filtrés ensuite par l'heure Europe/Paris.
-- Seuls 07:00 et 18:00, heure française, effectuent l'appel HTTP.
select cron.schedule(
  'backstage-radar-matin-soir',
  '0 5,6,16,17 * * *',
  'select net.http_post(
     url := ''https://vvwkkgpahrsojmpteexz.supabase.co/functions/v1/backstage-radar'',
     headers := jsonb_build_object(
       ''Content-Type'', ''application/json'',
       ''apikey'', (
         select decrypted_secret
         from vault.decrypted_secrets
         where name = ''backstage_cron_secret''
         limit 1
       )
     ),
     body := ''{"source":"cron"}''::jsonb,
     timeout_milliseconds := 130000
   )
   where extract(hour from now() at time zone ''Europe/Paris'') in (7,18)'
);

-- Vérification : la ligne doit être active = true.
select jobid, jobname, schedule, active
from cron.job
where jobname = 'backstage-radar-matin-soir';
