# BACKSTAGE — passer de GitHub Actions à Supabase + OpenAI

**Objectif :** surveiller l'actualité musicale, choisir les véritables annonces,
vérifier la source officielle, rédiger un article complet, l'enregistrer **en privé**
et notifier la rédaction. La décision de publier reste dans `/admin/`.

Le site reste momentanément sur GitHub Pages, mais **ni la veille ni la validation
des articles ne dépendront de GitHub** après activation du nouveau moteur.

## Ce qui est déjà préparé dans le code

- `supabase/functions/backstage-radar/index.ts` : moteur Web OpenAI et contrôles
  (une recherche puis, seulement si un sujet est vérifié, un appel de rédaction).
- `supabase/migration-radar.sql` : journal des recherches, historique des sujets
  et accès sécurisé au statut depuis le tableau de bord.
- `supabase/config.toml` : authentification spécifique au déclenchement Cron.
- `supabase/schedule-radar.sql` : deux passages par jour en UTC, protégés par
  une clé serveur enregistrée dans Supabase Vault.
- `tests/backstage-radar.test.mjs` : simulations hors ligne des appels,
  des sources officielles, de la protection par clé et de l'insertion d'un
  brouillon NON publié.
- `admin/` : liste des articles en attente et statut du dernier passage.

## Étape 1 — Base de données (sans toucher au schéma précédent)

Sur votre projet Supabase `vvwkkgpahrsojmpteexz`, ouvrir
**SQL Editor → New query** et exécuter **uniquement**
[la migration du radar](https://github.com/Kristouff59/media-festivals/blob/main/supabase/migration-radar.sql).

Ne **pas** rejouer `supabase/schema.sql` si les tables et votre compte
rédacteur ont déjà été créés.

## Étape 2 — Activer la fonction OpenAI sur Supabase

1. Aller dans **Supabase → Edge Functions**.
2. Créer une fonction appelée exactement `backstage-radar` via
   l'éditeur de code du Dashboard (ou Supabase CLI).
3. Coller le contenu intégral de
   [`supabase/functions/backstage-radar/index.ts`](https://github.com/Kristouff59/media-festivals/blob/main/supabase/functions/backstage-radar/index.ts)
   puis déployer.
4. **Désactiver `Verify JWT` pour cette fonction uniquement.** Ce n'est pas
   une ouverture publique : la fonction exige et compare elle-même la
   clé serveur Supabase présente dans l'en-tête `apikey`. Sans la clé
   serveur, elle renvoie HTTP 401 AVANT tout appel payant OpenAI.
5. Dans **Edge Functions → Secrets**, créer `OPENAI_API_KEY` avec une
   clé privée créée sur https://platform.openai.com/api-keys.
   Ne jamais enregistrer cette clé dans GitHub, le code public ou
   une conversation. Vous pouvez conserver `gpt-5.4-mini` (valeur par défaut)
   ou indiquer un autre modèle compatible avec Responses + web_search
   dans le secret `OPENAI_MODEL`.

**Important :** le coût API OpenAI est distinct de ChatGPT Plus. Activer
des alertes de consommation sur le compte API. Le radar prévoit au plus
**deux appels OpenAI par passage**, deux fois par jour. Il limite également
la file à cinq articles en attente.

Supabase injecte automatiquement les variables `SUPABASE_URL` et
`SUPABASE_SECRET_KEYS` dans les Edge Functions hébergées. Il ne faut pas
les créer soi-même comme secrets de fonction.

## Étape 3 — Lier Supabase Cron en toute sécurité

1. Aller dans **Settings → API Keys** et afficher la **Secret key**
   `sb_secret_...` du projet (jamais la clé publishable pour ce job).
2. Dans **SQL Editor**, exécuter la commande SQL suivante en remplaçant
   le texte entre apostrophes par votre clé secrète :

   `select vault.create_secret('VOTRE_CLE_SB_SECRET', 'backstage_cron_secret');`

3. Dans Supabase, ne pas partager ni conserver le résultat de la requête
   en dehors du projet. Au besoin supprimer l'historique de l'éditeur SQL
   contenant la clé. La clé est chiffrée par Supabase Vault pour son stockage.
4. Lancer d'abord un **test sans OpenAI** avec :

   ```sql
   create extension if not exists pg_net;
   select net.http_post(
     url := 'https://vvwkkgpahrsojmpteexz.supabase.co/functions/v1/backstage-radar',
     headers := jsonb_build_object(
       'Content-Type','application/json',
       'apikey',(select decrypted_secret from vault.decrypted_secrets
                 where name = 'backstage_cron_secret' limit 1)
     ),
     body := '{"healthcheck":true}'::jsonb,
     timeout_milliseconds := 20000
   ) as request_id;
   ```

   Un numéro `request_id` signifie que la requête a été mise en file,
   pas nécessairement qu'elle a réussi : vérifier le statut et les logs
   dans **Edge Functions → backstage-radar → Logs**. La réponse attendue
   est `{"ok":true,"db":"ok",...}`.
5. Après avoir validé ce test, faire un seul essai réel en remplaçant
   le corps de la requête par `'{}'::jsonb`.
   Ce test est susceptible de **déclencher des frais API**.
6. Lorsque la fonction répond normalement, exécuter
   [`supabase/schedule-radar.sql`](https://github.com/Kristouff59/media-festivals/blob/main/supabase/schedule-radar.sql).
   Le cron lance la fonction à **07 h 17 et 18 h 17 UTC**. Les heures
   affichées en France changent avec l'heure d'été.
7. **Désactiver ensuite le vieux calendrier GitHub Actions `veille.yml`**,
   afin d'éviter les recherches en double. Le code reste sur GitHub,
   mais l'automatisation éditoriale n'en dépend plus.

Il est possible de tester le déclenchement, puis de consulter
**Database → Cron → Jobs → History** et le journal du radar dans `/admin/`.

## Étape 4 — Recevoir des notifications

L'e-mail est **facultatif pour que la veille et la publication fonctionnent**,
mais nécessaire si l'on veut être averti automatiquement. Avec Resend :

1. Créer un compte sur https://resend.com, vérifier un domaine expéditeur,
   puis créer une clé API d'envoi.
2. Dans **Supabase Edge Functions → Secrets**, créer :
   - `RESEND_API_KEY` (clé privée d'envoi)
   - `BACKSTAGE_ALERT_EMAIL` (adresse de réception)
   - `BACKSTAGE_FROM_EMAIL` (expéditeur autorisé sur le domaine vérifié)
   - `BACKSTAGE_SITE_URL` (optionnel, URL racine de BACKSTAGE)
3. Un seul e-mail est envoyé par nouvel article, avec lien direct vers `/admin/`.

Ne publiez jamais `RESEND_API_KEY` ni vos clés Supabase serveur.
Sans notification configurée, les nouveaux brouillons restent disponibles
dans `/admin/` et visibles au prochain accès.

## Comment fonctionne la veille OpenAI

- Sélection de 0 à 3 pistes récentes avec une vraie recherche Web OpenAI.
- Sources primaires seulement, HTTPS, blocage des agrégateurs courants.
- Vérification directe des extraits réellement présents sur la page officielle.
- Rédaction originale, bornes de longueur et cohérence de quelques données
  factuelles. Si un contrôle échoue, rien n'est proposé.
- Déduplication des sujets déjà enregistrés, y compris après un refus.
- Si cinq brouillons attendent, la recherche s'arrête **avant tout appel OpenAI**.
- Création d'un brouillon privé Supabase (statut `pending`), éventuellement
  une proposition de mise à jour du festival.
- Votre décision dans BACKSTAGE /admin passe à `published` ou `rejected`.
  Seuls les articles publiés deviennent accessibles publiquement.

**Limites :** la validation automatique des sources ne garantit pas une
exactitude parfaite. Certains sites officiels fortement dynamiques peuvent
être difficiles à vérifier. Les Edge Functions Free ont une limite de durée
d'environ 150 s ; les appels sont volontairement plafonnés.

## Plan de retour arrière

Tant que le nouveau radar n'a pas produit un article complet et fonctionnel,
conserver le vieux workflow GitHub actif. On le désactive **uniquement après**
un test réel. Si Supabase est indisponible, les articles historiques du site
restent visibles grâce au HTML statique existant.

## Installation assistée depuis ChatGPT

Si vous connectez Supabase à ChatGPT par l'intégration correspondante,
il sera possible de réaliser les migrations et les déploiements depuis
l'application plutôt que de copier le code dans Supabase.
L'installation/connexion nécessite votre autorisation et aucune
connexion n'a été établie automatiquement.
