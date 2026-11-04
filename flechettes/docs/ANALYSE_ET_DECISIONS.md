# Analyse fonctionnelle, conception et points à arbitrer

## 1. Modules et dépendances

| Module | Rôle | Dépend de |
|---|---|---|
| **Jeux** (`engine/games/`) | Règles du 501, du Cricket et du Cut-Throat, chacune dans son module : moteur fléchette par fléchette + validation d'une manche saisie en résumé | — |
| **Rencontre** (`engine/match.js`) | Best of, manches de départage, nuls, forfait / abandon / disqualification / exemption | Jeux |
| **Configuration** (`engine/config.js`) | Formats, phases, barèmes, critères, surcharges par tour, préréglages, contrôle de cohérence | Jeux |
| **Poules** (`pools.js`, `roundRobin.js`) | Tirage reproductible, répartition équilibrée, round-robin sans doublon | — |
| **Classements** (`standings.js`) | Statistiques, départages ordonnés, confrontations directes, égalités persistantes, qualification mathématique | Rencontre |
| **Tableau** (`bracket.js`) | Placement des têtes de série, exemptions, séparation des poules, petite finale, surcharges par tour | Configuration |
| **Planification** (`scheduler.js`) | Affectation des cibles en temps réel + prévision du calendrier | — |
| **Tournoi** (`tournament.js`) | Agrégat : machine d'états, commandes, recalculs, impact des corrections | tous |
| **Classement final** (`ranking.js`), **Vues** (`view.js`), **Statistiques** (`stats.js`), **Simulation** (`simulate.js`) | Dérivés | Tournoi |
| **Serveur** (`server/`) | Comptes, autorisations, persistance, journal, temps réel, exports | Moteur |
| **Interface** (`public/`) | Organisateurs, arbitres, responsables de cible, spectateurs | API + moteur partagé |

Ordre logique : configuration → inscriptions → poules → rencontres → planification → résultats → classements → qualification → tableau → classement final → archivage / statistiques.

## 2. Architecture

* **Moteur métier pur** (`src/engine`) : aucune entrée/sortie, aucune dépendance. Toute modification passe par
  `applyCommand(état, commande, contexte)` qui travaille sur une copie, valide, applique, puis **recalcule les
  données dépendantes** (propagation du tableau, forfaits automatiques, fin de phase, génération de la phase suivante,
  affectation des cibles). Une commande invalide lève une `DomainError` et ne modifie rien.
* **Classements, statuts de qualification, état des cibles, prévisions : jamais stockés**, toujours recalculés à partir
  des résultats (impossible d'avoir un classement désynchronisé). Seul le classement final est figé à la clôture
  (et recalculé si une correction rouvre le tournoi).
* **Le même code** tourne dans le navigateur (le serveur publie `src/engine` sous `/engine/`) : la saisie d'un résultat
  est vérifiée en direct avec exactement les règles appliquées par le serveur ; le compteur de score utilise les
  mêmes moteurs.
* **Serveur Node.js sans dépendance** : API JSON, flux temps réel (Server-Sent Events), fichiers statiques.

### Modèle de données (un document par tournoi)

```
Tournoi { id, nom, statut (draft|ready|running|paused|finished|archived), version, graine,
          config { mode, teamSize, maxParticipants, politiques, scheduling, phases[] },
          participants[] { id, nom, joueurs[] {id, nom, historique}, statut, tête de série, contact, source },
          cibles[] { id, nom, statut (available|unavailable), note },
          phases[] { id, statut (pending|draft|active|completed), poules[] {participantIds, ordre manuel}, entrants, graine du tirage },
          rencontres[] { id, phase, poule | tour du tableau, a, b, sources (vainqueur/perdant de…), règles figées
                         {jeu, bestOf, limite de tours, nul autorisé}, statut, cible, priorité, report,
                         résultat {issue, vainqueur, manches[], manchesA/B, pointsPour A/B, validé par…},
                         résultat en attente, version du résultat, historique },
          membres[] { utilisateur, rôle, cibles autorisées, participant lié },
          partage { jeton spectateur, jeton d'inscription },
          décisions[] (journal des arbitrages de l'organisateur), classement final }
```

Statuts d'une rencontre : `waiting` (adversaires inconnus) → `ready` → `called` (cible attribuée) → `playing` ⇄
`suspended` → `awaiting_validation` → `finished` ; ou `postponed`, `cancelled`.

### Mécanismes garantissant la cohérence

| Risque | Mécanisme |
|---|---|
| Perte de données | Écriture atomique (fichier temporaire + fsync + renommage), copie de sécurité de la version précédente relue automatiquement si le fichier principal est corrompu, journal append-only de chaque commande |
| Modifications simultanées | Verrou par tournoi côté serveur (commandes sérialisées) ; numéro de version vérifié pour les modifications globales (configuration) ; version **par rencontre** pour les résultats (deux arbitres sur deux cibles ne se gênent pas, mais deux saisies sur la même rencontre sont détectées) |
| Coupure réseau / double envoi | Identifiant unique par commande : un renvoi automatique n'est jamais appliqué deux fois |
| Validations contradictoires | Une rencontre terminée refuse toute nouvelle saisie : seule la **correction** (rôle organisateur, avec version attendue) est possible, l'ancien résultat est historisé |
| Rencontre générée deux fois | Round-robin par la méthode du cercle + garde-fou sur les paires |
| Conflits de calendrier | Le planificateur et les commandes manuelles refusent tout participant déjà occupé et toute cible occupée ou indisponible ; invariants vérifiés après chaque étape dans les tests |
| Correction tardive | Analyse d'impact : si la correction change les qualifiés / le placement ou le vainqueur d'un match dont dépendent des rencontres déjà jouées, **la commande est refusée tant que l'organisateur n'a pas choisi** (conserver / régénérer / réinitialiser) ; les résultats écartés sont archivés |
| Égalité non départageable | La phase reste ouverte, une alerte demande la décision (ordre choisi ou tirage au sort enregistré) |
| Reprise après interruption | L'état complet est sur disque après chaque commande ; au redémarrage, tout est rechargé ; le client se resynchronise à la reconnexion |

## 3. Scénario de référence : choix retenus

* **Qualification** : avec 8 équipes et des quarts de finale, les 8 équipes accèdent au tableau. Les poules ne sont
  **pas éliminatoires** ; elles servent **au placement** : têtes de série 1 à 8 = rangs de poule (1ers, puis 2es,
  etc.), départagés entre poules par la moyenne de points par match, puis de différence de manches, de différence de
  points, de manches gagnées. Placement standard : **A1–B4, B2–A3, B1–A4, A2–B3** — jamais deux équipes de la même
  poule en quart, les deux premiers de poule ne peuvent se retrouver qu'en finale. *(Alternative possible sur simple
  changement de configuration : 2 qualifiés par poule → demi-finales directes.)*
* **Finale BO3** : le cahier des charges précise « 20 tours maximum hors finale » sans fixer la limite de la finale.
  Valeur par défaut retenue : **20 tours par manche en finale aussi** — **décision à confirmer** (modifiable dans
  Configuration → règles par tour, « vide » = aucune limite).
* Petite finale en BO1 / 20 tours (comme les autres tours hors finale).
* Positions 5 à 8 : perdants des quarts **5e ex aequo** (option « départagés par tête de série » disponible).

## 4. Points à arbitrer (section 21)

Chaque point est **paramétrable** ; la valeur par défaut est une proposition, pas une règle officielle.

| # | Question | Options proposées | Défaut |
|---|---|---|---|
| 1 | Nuls en poules | (a) interdits : départage obligatoire à la limite de tours ; (b) autorisés (barème « nul ») | (a) interdits |
| 2 | Limite de tours atteinte | 501 : le **reste le plus faible** gagne la manche ; Cricket : le **plus de points** ; Cut-Throat : le **moins de points**. Égalité → nul si autorisé, sinon **vainqueur du départage saisi par l'arbitre** (bull-off, tour supplémentaire… — la méthode de départage sur cible n'est pas codée : elle relève du règlement local) | comme décrit |
| 3 | Différence de points en 501 | (a) points marqués − points marqués par l'adversaire = reste adverse − propre reste, cumulé sur les manches ; (b) seulement les restes à la limite | (a) |
| 4 | Ordre des critères de classement | Liste ordonnée libre parmi : points, victoires, confrontation directe, différence de manches, manches gagnées, différence de points, points marqués, tirage au sort | points > confrontation directe > diff. de manches > diff. de points > manches gagnées |
| 5 | Égalités parfaites | (a) décision de l'organisateur (ordre ou tirage au sort enregistré) ; (b) tirage au sort automatique reproductible (critère « lot ») | (a), et seulement si l'égalité a une incidence (qualification, placement, titre) |
| 6 | Qualification du scénario à 8 équipes | voir §3 | tous qualifiés, poules = placement |
| 7 | Correction après le début des phases finales | (a) conserver la phase suivante telle quelle (classement corrigé, tableau inchangé, décision journalisée) ; (b) régénérer la phase suivante (résultats archivés) ; si aucune rencontre de la phase suivante n'a été jouée, la régénération est automatique et signalée. En élimination directe : changement de vainqueur → réinitialisation explicite des rencontres dépendantes déjà jouées | choix demandé à chaque fois |
| 8 | Appariement des qualifiés entre poules | (a) têtes de série selon le classement + séparation des poules au 1er tour ; (b) tirage au sort intégral | (a) |
| 9 | Modification des inscriptions après le lancement | Ajout / suppression interdits ; corrections de nom autorisées et historisées ; remplacement de joueur si le règlement l'autorise ; désistement / disqualification avec politique (résultats acquis conservés + forfaits, ou annulation de toutes les rencontres de poule) | ajout interdit, remplacement autorisé |
| 10 | Équipes / joueurs si le format change entre deux phases | Non pris en charge : le mode (individuel / équipes) et la taille des équipes sont communs à tout le tournoi. **Décision nécessaire** si un tel format est souhaité (ex. poules par équipes puis tableau individuel : faut-il qualifier des joueurs ? lesquels ?) | — |
| 11 | Désistement en poule | voir 9 ; un participant hors compétition n'est jamais qualifié : le suivant prend sa place | résultats conservés + forfaits |
| 12 | Points d'une défaite par forfait | barème distinct (« défaite par forfait ») | 0 (comme une défaite) |
| 13 | Manches créditées sur forfait | le vainqueur reçoit les manches nécessaires à la victoire ; aucun point de jeu n'est crédité (n'influence pas la différence de points) | comme décrit |

## 5. Couverture du cahier des charges

Légende : ✅ réalisé et testé · 🟡 réalisé avec une limite indiquée · ❌ non réalisé.

| § | Exigence | État |
|---|---|---|
| 1 | Créer, modifier, dupliquer, supprimer, archiver ; phases multiples, jeu / Best of / limite de tours par phase et par tour ; poules, qualifiés, cibles ; démarrer, interrompre, reprendre, terminer ; modification en cours encadrée ; vérification de cohérence | ✅ |
| 2 | Inscriptions manuelles, publiques (lien + QR), import CSV, doublons, présences, absents, désistements, forfaits, remplacements, clôture / réouverture, verrouillage | ✅ |
| 3 | Tirage, répartition équilibrée, poules inégales, modification manuelle, validation, génération round-robin sans doublon | ✅ |
| 4 | Planification : contraintes impératives, repos, cibles exploitées, recalcul après chaque événement, modifications manuelles (affectation, réservation de cible, priorité, report, retard) | ✅ (heuristique gloutonne optimisée ; pas d'optimisation globale exacte) |
| 5 | Cibles : libres / occupées / indisponibles, affectation auto et manuelle, panne → suspension et réaffectation prioritaire, ajout / retrait en cours | ✅ |
| 6 | Rencontres : démarrage, suspension, reprise, saisie, validation, correction, annulation, forfait, abandon, disqualification | ✅ |
| 7 | 501 double-out, Cricket, Cut-Throat, limites de tours, départages, Best of, aucun nul en élimination directe | ✅ (rencontres à 2 camps ; le Cut-Throat à 3 joueurs et plus n'est pas géré) |
| 8 | Classements automatiques, critères configurables, confrontations directes, égalités, déterminisme, qualification mathématique | ✅ |
| 9 | Qualifications, placement inter-poules, séparation des poules, exemptions, nombre non puissance de 2 | ✅ |
| 10 | Tableaux de toute taille, petite finale, avancement, corrections contrôlées, classement final | ✅ |
| 11 | Formats : poules seules, élimination seule, combinaison, individuel / équipes, jeux et limites par phase, impairs, exemptions | ✅ (une phase à élimination directe est toujours la dernière) |
| 12 | Temps réel multi-utilisateurs, spectateurs en lecture seule, partage par lien / QR | ✅ |
| 13 | 7 rôles appliqués côté serveur à chaque opération, plusieurs organisateurs, journal | ✅ (pas de réinitialisation de mot de passe par e-mail : outil `admin-cli.js`) |
| 14 | Imprévus (absent, forfait, abandon, disqualification, remplacement, annulation, à rejouer, report, cible indisponible, corrections, interruption, nombre de cibles) | ✅ |
| 15 | Sauvegarde automatique, archives, historique, palmarès, duplication, réutilisation d'une configuration, restauration sur un autre appareil | ✅ |
| 16 | Statistiques à partir des seules données enregistrées | ✅ (victoires, défaites, taux, manches, par jeu, classements, titres ; pas de moyennes par fléchette : non enregistrées) |
| 17 | Import / export CSV, JSON, PDF, feuilles de match, partage | ✅ (PDF en tableaux ; le tableau final y est présenté tour par tour, sans dessin graphique) |
| 18 | Mode démonstration isolé, simulation fléchette par fléchette avec les vraies règles, réinitialisation | ✅ |
| 19 | Fiabilité, synchronisation, données personnelles (masquage, export, anonymisation, suppression du compte) | 🟡 pas de file d'attente hors ligne : en cas de coupure prolongée, la saisie est refusée et l'utilisateur prévenu (les renvois automatiques sont sans risque de doublon) |
| 20 | Scénario de référence de bout en bout | ✅ (tests automatisés en Cricket et en Cut-Throat + parcours dans le navigateur) |

## 6. Limites connues

* Le compteur fléchette par fléchette n'est pas sauvegardé côté serveur pendant la manche : seul le résumé de manche
  reporté dans la saisie est enregistré.
* Stockage sur fichiers, un seul processus serveur : adapté à un club, une salle, un réseau local (centaines de
  participants), pas à une plateforme multi-clubs à forte charge.
* Pas d'envoi d'e-mails (invitations, réinitialisation).
