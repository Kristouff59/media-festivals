# Diagnostic BACKSTAGE du 31 octobre 2026

Base examinée : `88ad216380d401792f2d33e3294fef1404ab84ee` (main).
Le dépôt ne prouve pas la version déployée dans Supabase ni les réponses HTTP du matin.

## Sens du rejet

`presse_non_corroboree` signifie : la source officielle a passé les contrôles
d'accès, de longueur, de citation et de sujet ; aucune date de publication
officielle n'a été reconnue ; `press_url` est renseigné ; la preuve de secours
par la presse a échoué. Cela ne signifie pas que l'information est fausse.
Une date officielle ancienne ou future provoque son propre rejet, sans secours presse.

La preuve de secours exige une URL HTTPS sans port ni identifiants, appartenant
à l'un des 20 domaines de `trustedPressHosts` (ou ses sous-domaines).
Le prompt demande un média fiable mais n'explicite pas cette liste : une URL
authentique d'un autre média est donc rejetée avant toute lecture.
La réponse doit être HTML, HTTP OK, sans redirection, de 700 000 caractères
maximum et contenir au moins 250 caractères normalisés. Le nom du festival
doit être retrouvé dans les deux pages, ainsi qu'au moins un artiste annoncé.
La date doit être reconnue, âgée de sept jours maximum, avec une tolérance
d'un jour dans le futur. Les limites sont calculées en durée, pas en jours civils.

Avant correction, festival et artistes de moins de cinq caractères étaient exclus.
Un alias, une traduction, une variante du nom ou un contenu chargé en JavaScript
peuvent aussi empêcher une correspondance. Le texte est limité aux 60 000 premiers
caractères après extraction. Une panne, un blocage anti-robot ou une redirection
de presse était masqué sous le même motif général.

## Corrections et vérification

- Accepter les noms à partir de deux caractères, avec des limites de mots :
  U2, IAM, Muse et Pulp deviennent vérifiables ; Museum ne prouve pas Muse.
- Une date de presse explicitement ancienne ou future ne peut plus être
  remplacée par une date récente trouvée près du titre. Ce défaut pouvait
  produire des acceptations injustifiées, pas expliquer les rejets du matin.
- Conserver le motif général et ajouter `press_reason` dans les réponses,
  le résumé SQL quand il y a zéro candidat admissible, et les logs Edge complets
  de vérification, y compris lorsqu'une autre piste aboutit.
- Activer la validation des PR qui modifient la fonction ou ses tests.

Tests hors réseau : `node tests/backstage-radar.test.mjs`. Les régressions
utilisent une horloge fixe au 31 octobre et des pages simulées. Aucun appel
OpenAI ni Supabase réel. Aucun déploiement ni migration nécessaire au code,
mais la fonction doit être redéployée après fusion pour modifier la production.

## Limites conservées

La liste de médias reste restrictive. La supprimer sans autre règle de confiance
affaiblirait la preuve. La présence de noms dans les deux pages n'établit pas
à elle seule le lien sémantique avec une nouvelle annonce, ni la même édition.
Sans métadonnée, `datedNewsHeader` peut encore prendre une date d'événement
près du titre pour une date de publication. La correction interdit seulement
de contredire une métadonnée explicite. La validation de l'éditeur reste nécessaire.

## Pièces nécessaires pour expliquer le matin, piste par piste

Exécuter les requêtes en lecture seule ci-dessous dans Supabase et fournir les
résultats complets. Le journal IA est déjà limité à 16 000 caractères par réponse ;
ne pas ajouter un `LEFT(..., 3000)` qui pourrait cacher des pistes.

```sql
select slot, status, detail,
       started_at at time zone 'Europe/Paris' as heure_debut,
       finished_at at time zone 'Europe/Paris' as heure_fin
from public.editorial_radar_runs
where slot = '2026-10-31-matin';

select created_at, stage, status, model, request_text, response_text,
       error_detail, input_tokens, output_tokens, web_search_calls
from public.editorial_ai_logs
where slot = '2026-10-31-matin'
order by created_at, id;
```

Ajouter l'identifiant et l'heure de déploiement de la fonction exécutée et, si
disponible, la réponse HTTP du passage automatique ou les logs Edge vers
07 h Europe/Paris (06 h UTC). Le résumé SQL est tronqué à 440 caractères et,
avant correction, un passage produisant un article ne conserve pas ses rejets
dans ce résumé. Les anciens logs ne contiennent pas les sous-motifs ajoutés ici.
Les URL et noms retournés permettent de vérifier les blocages déterministes.
Relire une page aujourd'hui ne prouve pas son contenu ni son accessibilité à 07 h.
Une absence de détails historiques peut empêcher d'attribuer exactement un
échec de réseau ou d'extraction. Ne pas relancer une veille payante pour lire ces logs.
