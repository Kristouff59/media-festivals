# BACKSTAGE v2 — une salle de rédaction, pas un script

## Le diagnostic

Le moteur v18 fait tout en une seule exécution de 130 secondes : découverte,
vérification, recherche de presse, rédaction de tous les articles en un lot,
écriture en base. Chaque étape est un filtre binaire et ce qui tombe est perdu.

Les échecs observés ne sont pas des bugs isolés, ils découlent de ce modèle :

| Symptôme | Cause racine |
|---|---|
| Massive Attack rejeté (`date_publication_absente`) | La date « 28 October 2026 » est sous le titre, sans « published » ni « min read » : aucun des quatre motifs ne la reconnaît. |
| `presse_trop_volumineuse` | Une page trop lourde est **rejetée** au lieu d'être lue partiellement. |
| Annonces vraies perdues | `redirect: "error"` : la moindre redirection (www, langue, barre finale) annule la source. |
| Vérification fragile | Le modèle doit recopier mot pour mot une phrase de 35 caractères ; une paraphrase suffit à tout rejeter. |
| Presse non recevable | Liste fermée de 20 médias ; festivalinfo.nl ou un média belge sont refusés d'office. |
| Pistes disparues | Une piste rejetée n'est enregistrée nulle part : pas de nouvelle tentative, pas d'examen humain. Après 7 jours, elle est hors fenêtre pour toujours. |
| Doublons | Comparaison de titres en texte libre et de `topic_key` inventés par le modèle. |
| Rédaction en lot | Six articles longs dans une seule réponse : limite de génération, et un JSON cassé fait tomber tout le lot. |
| Demi-journée perdue | Un verrou par créneau : si le passage échoue, rien ne se relance avant 12 h. |

## Le principe de la v2

**Chaque piste devient un dossier persistant qui avance d'étape en étape.**
Rien n'est jeté silencieusement : une piste est vérifiée, à examiner, ou
rejetée avec un motif lisible, et reste consultable.

```
 Découverte ──► Pistes ──► Vérification ──► Récits ──► Rédaction ──► Validation humaine
 (2 canaux)   (table)     (moteur de      (doublon /   (1 article    (admin)
                           preuves)        mise à jour   par appel)
                                           / nouveau)
```

### 1. Deux canaux de découverte

- **Canal officiel, gratuit** : les sommaires d'actualités des sources du
  registre sont lus par le serveur. Chaque lien daté récent devient une piste,
  avec sa date déjà prouvée par le sommaire. Aucun appel OpenAI.
- **Canal ouvert, OpenAI + recherche Web** : pour tout ce que le registre ne
  couvre pas. Le modèle propose ; il ne prouve rien.

Les deux alimentent la même table `editorial_leads`.

### 2. Moteur de preuves

Le serveur lit lui-même chaque page officielle :

- redirections suivies (5 maximum, chaque étape revalidée contre les adresses
  privées) ;
- lecture **tronquée** à 3 Mo au lieu d'un rejet ;
- extraction séparée du titre, du contenu principal, des métadonnées et du JSON-LD.

Chaque indice de date devient une **preuve typée et pondérée** :
`jsonld`, `meta`, `time`, `sous_le_titre`, `marqueur_publication`, `url`,
`sommaire_officiel`, `presse`. Les dates de concert, de billetterie ou
d'historique (« July 2027 », « 27 June 2003 ») sont écartées par leur contexte
et par leur position. Le sommaire officiel est relié **à l'URL exacte** du
communiqué, pas à une date voisine.

Les faits sont vérifiés par le serveur : festival, édition, artistes annoncés
doivent apparaître dans le contenu principal de la page. Plus aucune citation
exigée du modèle.

Le résultat est un journal structuré (`official_url`, `publication_date`,
`date_evidence_url`, `date_evidence_type`, `verification_status`,
`rejection_reason`, `corroborating_sources`, `checks`) et trois issues :

- `verified` : preuve officielle suffisante ;
- `needs_review` : annonce réelle mais preuve incomplète (date absente,
  page inaccessible) — elle apparaît dans l'admin, un clic suffit ;
- `rejected` : motif réel (ancienne, sans rapport, inexistante).

Les erreurs réseau sont réessayées au passage suivant.

### 3. Récits plutôt que titres

Chaque annonce vérifiée reçoit une identité déterministe :
`événement + édition + type d'annonce + ensemble d'artistes`.
Comparée aux récits existants, elle est classée :

- **doublon** : mêmes artistes, même événement, même édition ;
- **mise à jour** : même événement, artistes nouveaux ou dates nouvelles —
  c'est une vraie actualité, l'article peut renvoyer au précédent ;
- **nouveau**.

### 4. Rédaction : un article par appel

Format choisi selon la matière disponible (brève, actualité, dossier), budget
de tokens adapté, et un relecteur automatique qui produit des **alertes**
(clichés, année absente des sources, chiffres non sourcés) affichées dans
l'admin au lieu de jeter l'article.

### 5. Exécution par petits pas

Le cron appelle `backstage-pipeline` toutes les 30 minutes avec un budget
de 100 s. Chaque appel avance ce qui est prêt (vérifier, réessayer, rédiger).
La découverte OpenAI reste à 7 h et 18 h. Un appel sans travail ne coûte rien.

### 6. Mise en service sans risque

La v18 reste en production. La v2 démarre en **mode fantôme** :
elle remplit `editorial_leads` sans créer d'articles. On compare pendant
quelques jours ce que la v2 aurait proposé à ce que la v18 a proposé,
puis on bascule (`BACKSTAGE_PIPELINE_MODE=live`) et on désactive l'ancien cron.

## Organisation du code

```
supabase/functions/_shared/backstage/
  fetch.ts      lecture bornée et sûre des pages
  html.ts       titre, contenu principal, métadonnées, JSON-LD, liens
  dates.ts      dates multilingues (fr, en, nl, de, es, it)
  evidence.ts   preuves de publication et rapprochement avec le sommaire
  verify.ts     vérification complète d'une piste
  story.ts      identité des récits et doublons
  quality.ts    relecture automatique
supabase/functions/backstage-pipeline/index.ts
supabase/migration-v2-pipeline.sql
tests/v2/       tests hors ligne (aucun appel API)
```

Tous les modules sont des fonctions pures ou à dépendances injectées :
ils s'exécutent dans Deno (Supabase) et dans Node (tests, CI).

## Mise en service (dans cet ordre)

1. Exécuter `supabase/migration-v2-pipeline.sql` dans l'éditeur SQL (aucune donnée modifiée).
2. Déployer : `supabase functions deploy backstage-pipeline --project-ref vvwkkgpahrsojmpteexz`
   (le secret `BACKSTAGE_PIPELINE_MODE` absent = mode fantôme).
3. Test sans coût : appeler la fonction avec `{"stage":"verify_url","url":"https://www.rockwerchter.be/en/news/massive-attack-make-their-return-at-rock-werchter","event_name":"Rock Werchter","artists":["Massive Attack"]}`.
   Attendu : `verification_status: "verified"`, `publication_date: "2026-10-28"`.
4. Rejeu : `{"stage":"discover","force":true,"replay_runs":10}` rejoue les dix dernières
   découvertes de la v18 et remplit `editorial_leads`. Comparer avec `editorial_radar_runs`.
5. Exécuter `supabase/schedule-v2-pipeline.sql` (mode fantôme, l'ancien cron continue).
6. Après quelques jours concluants : ajouter le secret `BACKSTAGE_PIPELINE_MODE=live`
   et désactiver `backstage-radar-matin-soir`.

## Ce qui reste à faire

- Admin : un onglet « Pistes » (à examiner, rejetées, doublons) avec la preuve de date,
  et les alertes de relecture affichées sur chaque article.
- Fiche festival (`payload.festivals`) : non produite par la v2 pour l'instant.
- Images : pipeline de recherche et de vérification des droits.
- Le test historique `tests/backstage-radar.test.mjs` dépend de l'horloge réelle
  (dates d'octobre codées en dur) et échoue désormais sur `main` ; les tests v2 fixent la date.
