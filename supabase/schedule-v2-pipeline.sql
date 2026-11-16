-- BACKSTAGE v2 — appel du pipeline toutes les 30 minutes (à :15 et :45).
-- La découverte n'a lieu qu'à 7 h et 18 h (heure de Paris) : la fonction
-- le décide elle-même. Les autres appels vérifient, réessaient et rédigent ;
-- sans travail en attente, ils ne coûtent rien.
-- NE PAS exécuter avant : migration-v2-pipeline.sql + déploiement de backstage-pipeline.
-- En mode fantôme (défaut), l'ancien cron backstage-radar-matin-soir reste actif.
select cron.unschedule(jobid) from cron.job where jobname = 'backstage-pipeline-v2';
select cron.schedule(
  'backstage-pipeline-v2',
  '15,45 * * * *',
  'select net.http_post(
     url := ''https://vvwkkgpahrsojmpteexz.supabase.co/functions/v1/backstage-pipeline'',
     headers := jsonb_build_object(
       ''Content-Type'', ''application/json'',
       ''apikey'', (select decrypted_secret from vault.decrypted_secrets
                    where name = ''backstage_cron_secret'' limit 1)
     ),
     body := ''{"stage":"tick"}''::jsonb,
     timeout_milliseconds := 120000
   )'
);
select jobid, jobname, schedule, active from cron.job where jobname = 'backstage-pipeline-v2';
