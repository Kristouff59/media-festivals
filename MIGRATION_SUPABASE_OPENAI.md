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
**deux requêtes OpenAI par passage** (une recherche Web qui peut utiliser
jusqu'à trois appels d'outil, puis une rédaction), deux fois par jour.
Les appels d'outil Web ont également un coût. Il limite également
la file à cinq articles en attente.

Supabase injecte automatiquement les variables `SUPABASE_URL` et
`SUPABASE_SECRET_KEYS` dans les Edge Functions hébergées. Il ne faut pas
les créer soi-même comme secrets de fonction.

## Important — mise à jour du moteur le 27 octobre 2026

Un premier essai a bien déposé un article sur Simple Plan, mais l'annonce
était déjà connue depuis novembre 2025. Cette anomalie a révélé que l'ancien
moteur vérifiait le fait sans vérifier la date de l'annonce.

Le code du radar inclut désormais une exigence stricte : la page officielle
doit contenir une **date de publication vérifiable dans ses métadonnées**,
datée des **7 derniers jours**. En l'absence de date, la proposition est
écartée. Cette politique peut écarter certaines annonces pourtant nouvelles
lorsque le site officiel ne fournit pas de date exploitable : c'est une
limitation assumée pour réduire les fausses actualités.

**Si `backstage-radar` a déjà été déployé**, remplacer son code par la
[version actuelle](supabase/functions/backstage-radar/index.ts) dans
Supabase → Edge Functions → backstage-radar → Code, puis redéployer.
**Modifier le fichier sur GitHub seul ne redéploie pas la fonction.**
Refuser depuis `/admin/` le premier brouillon Simple Plan s'il annonce
à tort une nouveauté d'octobre 2026.

Après redéploiement, utiliser d'abord une requête de santé
`{"healthcheck":true}`, puis programmer Supabase Cron.

## Mémoire éditoriale : pourquoi un article est refusé

À partir du 27 octobre 2026, BACKSTAGE propose un refus motivé :

- Motif classé : artiste, ligne éditoriale, angle, style, fiabilité,
  actualité ou autre.
- Commentaire libre : ce que vous ne voulez pas, ce que vous souhaiteriez
  davantage voir, ou comment améliorer le texte.
- Case **« Tenir compte de mon avis dans les prochains articles »**,
  cochée par défaut. Pour un refus isolé, décochez-la.
- Bouton **« Refuser sans commentaire »** toujours disponible.
- L'avis est visible uniquement dans `/admin/` pour le compte
  administrateur. Il n'est jamais joint à l'article public.

### Activation de la mémoire

1. Dans **Supabase → SQL Editor**, exécuter le contenu intégral du script
   [`supabase/migration-editorial-feedback.sql`](supabase/migration-editorial-feedback.sql).
   Il crée la table privée `editorial_feedback`, sa politique de lecture
   limitée aux administrateurs et une fonction transactionnelle
   `reject_editorial_draft_with_feedback`. Il ne supprime rien.
2. Dans **Supabase → Edge Functions → backstage-radar → Code**, remplacer
   le code par [la dernière version de `index.ts`](supabase/functions/backstage-radar/index.ts)
   puis **Deploy updates**. Les changements GitHub ne redéploient pas
   les Edge Functions à eux seuls.
3. Sur [`/admin/`](https://kristouff59.github.io/media-festivals/admin/),
   rafraîchir le navigateur, choisir un article en attente, et tester
   **Refuser et expliquer pourquoi**.

Lors du prochain passage du radar, il consulte (côté serveur) au plus
24 retours récents, uniquement ceux cochés pour application future.
Ils sont placés dans le contexte des requêtes OpenAI **pour la sélection
du sujet et pour la rédaction**. Ils ne changent pas les poids du modèle
d'IA : il s'agit d'une mémoire modifiable conservée dans Supabase.
Le refus et l'enregistrement du commentaire sont une transaction
indivisible : en cas d'erreur, l'article reste en attente.

Les contrôles sur l'ancienneté, les sources officielles et la publication
uniquement après validation restent obligatoires et ne peuvent pas être
écartés par un retour éditorial.

## Comprendre les recherches sans résultat (diagnostic du radar)

Le radar ne crée pas un article lorsqu'il n'a pas de source officielle récente
et vérifiable. Pour rendre ces vérifications compréhensibles, le résultat du
test `POST` affiche désormais les champs :

- `candidates_found` : nombre de pistes rendues par OpenAI ;
- `rejections` : liste des titres examinés et des raisons pour lesquelles
  ils ont été écartés.

Exemple :

```json
{
  "result": "aucune_source_officielle_verifiee",
  "candidates_found": 2,
  "rejections": [
    {
      "topic": "Exemple de festival",
      "reason": "date_publication_absente"
    },
    {
      "topic": "Exemple de tournée",
      "reason": "annonce_trop_ancienne"
    }
  ]
}
```

Principales raisons : `candidat_invalide`, `sujet_deja_traite`,
`url_officielle_invalide`, `source_inaccessible`, `source_non_html`,
`date_publication_absente`, `annonce_trop_ancienne`,
`date_publication_future`, `citations_non_retrouvees`,
`sujet_absent_de_la_source`. La sortie ne contient ni clé privée ni
extrait confidentiel ; elle affiche uniquement les sujets et la catégorie
du rejet.

La première version du diagnostic utilise volontairement les mêmes règles
strictes de fraîcheur et de recoupement. Le radar peut découvrir jusqu'à six pistes et vérifier au maximum quatre
candidats par passage : si aucun n'est acceptable, aucun article n'est créé.
Une découverte vide signale que la recherche elle-même n'a trouvé aucune
piste, et non que les sources ont été rejetées.

**Pour installer le diagnostic dans Supabase**, remplacer le code de
`backstage-radar` par celui du dépôt et cliquer sur **Deploy updates**.
Un changement dans GitHub seul ne met pas à jour la fonction déjà déployée.
La méthode de test et les en-têtes restent identiques.

## Optimisation de la découverte (27 octobre 2026, deuxième ajustement)

Le retour `{"candidates_found":0,"rejections":[]}` indiquait que le modèle
renvoyait directement une liste vide. La consigne précédente demandait
trop de preuves pendant la découverte (source primaire, métadonnée récente,
citations exactes). Le nouveau moteur cherche désormais les **pistes**
en premier, au besoin à travers des articles de presse qui signalent
l'actualité, puis **vérifie séparément la source officielle** avant toute
rédaction ou publication. Les pages officielles trop anciennes ou non
datées sont toujours écartées. Les sujets proposés peuvent donc
toujours être refusés par le vérificateur : une liste de pistes n'est
pas une preuve de publication possible.

L'outil Web peut exécuter jusqu'à trois appels au lieu de deux ; les
frais de recherche peuvent donc augmenter légèrement. En revanche,
le moteur n'effectue jamais une rédaction si aucune preuve acceptable
n'est trouvée.

**Cette amélioration nécessite un redéploiement de l'Edge Function** :
il ne suffit pas de mettre à jour GitHub.

## Élargissement de la lecture des dates officielles (27 octobre 2026)

Cas réel : OpenAI a découvert l'annonce de la tournée U2
« The Greatest Show on Earth » sur le site officiel, mais le contrôle
avait renvoyé `date_publication_absente`. Or l'annonce initiale
a été publiée le **15 octobre 2026**, soit plus de sept jours avant
la veille du 27 octobre : le diagnostic attendu était
`annonce_trop_ancienne`, **sans publication automatique**.

Le radar lit maintenant, en plus des métadonnées d'article et des
dates structurées, certaines dates publiées **dans l'en-tête de
l'article officiel à côté de son temps de lecture** (exemple :
`15 OCTOBER 2026 1 MIN READ`). Il ne considère jamais comme
preuve de fraîcheur une date de concert isolée. Si la date reste
inaccessible, le sujet est toujours écarté.

Les tests automatisés couvrent maintenant quatre cas supplémentaires :
date visible récente, date visible ancienne, date de concert seule,
et ancienne métadonnée combinée à une date visible récente.
La vérification doit rester stricte : une amélioration de l'extraction
de date n'autorise pas une annonce obsolète à être publiée.

Déployer `supabase/functions/backstage-radar/index.ts` à nouveau dans
Supabase pour bénéficier de cette modification : GitHub ne le fait pas
automatiquement.

## Journal privé des appels OpenAI (sans tokens supplémentaires)

La fonction journalise maintenant **les appels OpenAI déjà effectués** :
requête envoyée, texte de réponse, modèle, jetons d'entrée et de sortie,
nombre de recherches Web, durée, identifiant de réponse et erreurs.
Le nombre de requêtes OpenAI est **inchangé** : la collecte est faite
avec des écritures dans Supabase, non avec un deuxième appel au modèle.

La requête et la réponse sont plafonnées à 16 000 caractères chacune.
Ne sont jamais stockés les en-têtes d'authentification, la clé Supabase
ni la clé OpenAI. En revanche, les consignes internes et les préférences
éditoriales intégrées aux requêtes peuvent figurer dans le journal :
**consultation réservée aux administrateurs de rédaction par RLS**.
Le journal est automatiquement purgé au bout de 30 jours (lors de
l'insertion de nouveaux appels).

### Activation, dans cet ordre

1. **Supabase → SQL Editor** : copier et exécuter entièrement
   [`supabase/migration-ai-logs.sql`](supabase/migration-ai-logs.sql).
   Cette migration crée `editorial_ai_logs`, limite sa consultation
   aux administrateurs et règle la purge à 30 jours. Elle ne modifie
   aucun article existant.
2. **Supabase → Edge Functions → backstage-radar** : remplacer le
   code par la version de
   [`supabase/functions/backstage-radar/index.ts`](supabase/functions/backstage-radar/index.ts)
   sur la branche principale GitHub puis **Deploy updates**.
   Aucun nouveau secret n'est nécessaire.
3. Recharger le tableau de bord privé
   [`/admin/`](https://kristouff59.github.io/media-festivals/admin/) :
   sous l'état de la dernière veille, le panneau
   **« Journal privé des appels OpenAI »** affiche les 30 appels les plus
   récents. Il est vide jusqu'au prochain lancement réel du radar.

L'affichage du journal ne déclenche aucune nouvelle requête OpenAI.
Une panne de son écriture ne doit ni générer d'appel supplémentaire,
ni empêcher la validation des sources et la création des brouillons.
Les anciennes veilles ne peuvent pas être reconstruites rétroactivement.

## Radar de sources officielles prioritaires (27 octobre 2026)

**Pourquoi l'annonce du Cabaret Vert a été manquée :**
la veille initiale faisait une recherche OpenAI générale et ne possédait
**aucune liste de sources officielles à consulter systématiquement**.
Les pages de programmation officielles, souvent non datées, étaient
aussi rejetées même si un communiqué ou une nouvelle presse confirmait
l'ajout d'un artiste.

### Sources servant initialement d'amorçage, sans liste fermée

- Cabaret Vert : `https://cabaretvert.com/programmation/`
- Rock Werchter : `https://www.rockwerchter.be/en/news`
- Graspop Metal Meeting : `https://press.graspop.be/`
- Eurockéennes : `https://www.eurockeennes.fr/actualites/`
- We Love Green : `https://www.welovegreen.fr/music/`
- Main Square : `https://mainsquarefestival.fr/`
- Hellfest : `https://hellfest.fr/`
- Dour : `https://www.dourfestival.eu/`
- Rock en Seine : `https://www.rockenseine.com/`
- Pukkelpop : `https://www.pukkelpop.be/en/`

Les pages actives du registre sont contrôlées **directement** par
le radar à tour de rôle (12 maximum par passage) ; la liste peut désormais
s'agrandir automatiquement.
Leurs extraits sont ajoutés au prompt de la recherche Web OpenAI
existante. Il n'y a **pas d'appel OpenAI supplémentaire**, mais le
prompt étant enrichi, le coût en tokens d'entrée peut légèrement
augmenter. Les sites en erreur, vides ou inaccessibles sont ignorés
sans bloquer les autres sources.

Ces dix festivals ne constituent **pas une limite géographique** :
l'exploration générale des tournées, festivals internationaux et
enjeux de la musique live reste en place.

### Pages officielles sans date, mais annonces récentes

Si un programme officiel n'affiche aucune date de mise en ligne,
un sujet peut désormais être corroboré par **une page d'article récente**
sur une liste explicite de médias musicaux réputés, à condition que :

1. l'article de presse possède une date de publication datant de sept
   jours au maximum ;
2. le même festival et au moins un même artiste nommé apparaissent
   explicitement dans la presse **et** dans le programme officiel ;
3. la page officielle contient bien une citation littéralement
   vérifiable fournie par la recherche ;
4. aucune ancienne date de publication explicite n'apparaisse sur
   l'annonce officielle (une annonce officiellement ancienne ne peut
   pas être rajeunie par la presse).

Le brouillon conserve les **deux URLs** comme sources et attend toujours
la décision du rédacteur. La simple présence d'un groupe sur une
affiche ne prouve jamais qu'il vient d'être annoncé.

La réponse JSON du radar indique maintenant
`official_sources_reached`, qui liste **les sites prioritaires réellement
accessibles** pendant l'exécution. L'onglet des journaux OpenAI
enregistre aussi la liste des extraits consultés.

**Aucune publication automatique n'a été ajoutée** ; une veille sans
actualité intéressante peut toujours se terminer sans article.

### Déploiement

Installer la dernière version GitHub de
`supabase/functions/backstage-radar/index.ts` dans l'Edge Function
`backstage-radar` puis cliquer sur **Deploy updates**. Le site et le
code GitHub ne déploient pas la fonction Supabase automatiquement.
La migration SQL du journal reste valable : il n'y a pas de nouvelle
migration à exécuter pour ces sources.

## Sources ouvertes et apprentissage automatique (28 octobre 2026)

**Principe clé : aucune liste fixe ne limite les recherches.**
OpenAI cherche à chaque passage sur l'ensemble du Web des événements,
annonces de programmation et concerts dignes d'un article pour BACKSTAGE.
Le registre Supabase sert uniquement de **mémoire de sources fiables
déjà rencontrées**, qui peuvent suggérer des pistes supplémentaires.

### Activation

1. Dans **Supabase → SQL Editor**, exécuter une seule fois
   [`supabase/migration-dynamic-sources.sql`](supabase/migration-dynamic-sources.sql).
   Le script crée `editorial_sources` avec une politique RLS réservée
   aux administrateurs, deux RPC réservés au service serveur, et insère
   dix sources de démarrage **facultatives**, uniquement si elles sont absentes.
   Aucune préférence, aucun brouillon et aucune donnée de journal existante
   ne sont supprimés.
2. Dans **Supabase → Edge Functions → backstage-radar**, remplacer
   le code avec la
   [dernière version GitHub](supabase/functions/backstage-radar/index.ts),
   puis cliquer sur **Deploy updates**.
3. Recharger [l'espace rédaction](https://kristouff59.github.io/media-festivals/admin/)
   et ouvrir **« Sources officielles découvertes et suivies »** pour
   voir leur croissance. Une nouvelle source apparaît après une future
   proposition d'article vérifiée, jamais à partir d'une simple intuition
   du modèle.

### Comportement précis

- Recherche générale OpenAI sur **tous les festivals et artistes,
  sans restriction géographique ou de domaine**.
- En parallèle, consultation directe d'au plus **12 sites** déjà
  enregistrés par passage (sans appel OpenAI supplémentaire).
- Les 12 suivants sont sélectionnés lors du passage suivant grâce
  à une rotation sur la date de dernier contrôle : pas d'avantage
  permanent pour les 10 premières sources.
- Lorsque le radar a vérifié une annonce et **créé un brouillon privé**,
  le domaine de son site officiel est enregistré automatiquement
  (`origin=discovered`). Il sera proposé à la rotation dès les
  prochains passages. Une simple source médiatique, une piste non
  recoupée ou un article rejeté pour manque de preuves ne suffit pas
  à ajouter un site.
- La rotation concerne seulement les visites directes ; **aucun
  site non enregistré n'est exclu de la recherche Web**.
- Si la migration est absente ou si le registre n'est pas disponible,
  la recherche OpenAI ouverte continue, sans apprentissage persistant.
- Les entrées de départ et les nouvelles sources sont visibles
  uniquement dans le tableau de bord authentifié (RLS).

**Attention :** la découverte de nouvelles sources ne garantit
ni un article à chaque passage, ni la publication automatique.
La sélection éditoriale reste prioritaire, et chaque brouillon
attend toujours l'approbation humaine.

## Étape 3 — Lier Supabase Cron en toute sécurité

1. Aller dans **Settings → API Keys** et afficher la **Secret key**
   `sb_secret_...` du projet (jamais la clé publishable pour ce job).
2. Dans **Database → Vault → Secrets**, cliquer sur **New secret** et
   créer un secret nommé exactement `backstage_cron_secret`, avec pour valeur
   cette clé privée. **Ne pas coller la clé privée dans une requête SQL,
   le dépôt GitHub ou une conversation.**
3. Le secret est chiffré au repos par Supabase Vault. Le script de calendrier
   lit seulement `vault.decrypted_secrets` à l'exécution, côté base de données.
   Vérifier le nom du secret avant de poursuivre.
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

- Découverte de 0 à 6 pistes récentes avec une vraie recherche Web OpenAI.
  La recherche ne doit plus vérifier elle-même les métadonnées de publication
  ou produire deux citations avant de retourner une piste : elle identifie
  les annonces potentielles, puis le moteur vérifie les sources séparément.
  Jusqu'à quatre pistes sont examinées par passage, sans créer de brouillon
  en cas de vérification insuffisante.
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
