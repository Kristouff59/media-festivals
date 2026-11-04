# Tournois de fléchettes

Application complète d'organisation de tournois de fléchettes — inscriptions, poules, planification intelligente des
cibles, saisie des résultats en **501 (double-out)**, **Cricket** et **Cricket Cut-Throat**, classements automatiques,
qualifications, tableaux à élimination directe, suivi en temps réel, exports et archives.

L'organisateur inscrit les participants, choisit les règles, lance le tournoi et saisit les résultats ; le logiciel
gère les poules, les rencontres, les cibles, les classements, les qualifications et les phases finales.

## Démarrer

Prérequis : **Node.js 20 ou plus récent**. Aucune dépendance à installer.

```bash
cd flechettes
npm start            # http://localhost:3000
npm test             # tests automatisés (moteur + serveur)
```

Variables : `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (`./data`), `LOG=0` pour couper les journaux HTTP.

En salle, lancez le serveur sur un ordinateur du réseau local : les arbitres, responsables de cible et spectateurs
se connectent depuis leur téléphone avec l'adresse réseau de l'ordinateur (affichée dans **Partage & exports**,
avec le QR code).

Le premier compte créé administre l'instance. Outil local :
`node src/server/admin-cli.js reset-password <email> <mot-de-passe>` (serveur arrêté).

## Utilisation rapide

1. **Créer** un tournoi (préréglage « Scénario de référence », ou réutilisation de la configuration d'un tournoi passé).
2. **Configuration** : mode individuel / équipes, phases, jeu, Best of, limites de tours (par phase et par tour),
   barème, ordre des critères de classement, petite finale, planification.
3. **Participants** : saisie, import CSV, inscriptions en ligne, confirmation de présence.
4. **Aperçu** : clore les inscriptions → tirer au sort les poules (ajustables) → valider → lancer.
5. **Cibles & calendrier** : les rencontres sont appelées automatiquement sur les cibles libres ; démarrer, saisir le
   résultat (saisie résumée ou compteur fléchette par fléchette), valider.
6. Les classements, la qualification, le tableau final et le classement final se mettent à jour seuls.
7. **Archiver** ; palmarès et statistiques dans le menu.

Le menu **Démonstration** crée des tournois fictifs isolés et les simule avec les vraies règles.

## Architecture

```
src/engine/     moteur métier pur (aucune E/S), partagé avec le navigateur
  games/        x01.js · cricket.js · cutthroat.js · cricketBoard.js (marquage commun, sans règle de score)
  match.js      Best of, nuls, forfaits, abandons, exemptions
  config.js     formats paramétrables, préréglages, contrôle de cohérence
  roundRobin.js pools.js bracket.js standings.js ranking.js
  scheduler.js  affectation des cibles + prévision du calendrier
  tournament.js agrégat : commandes, machine d'états, recalculs, contrôle d'impact des corrections
  permissions.js view.js stats.js simulate.js csv.js
src/server/     API HTTP, comptes, persistance atomique + journal, temps réel (SSE), exports CSV/JSON/PDF
public/         interface web (sans framework), QR code autonome
test/           tests automatisés
docs/           analyse fonctionnelle, décisions et points à arbitrer
```

Voir **[docs/ANALYSE_ET_DECISIONS.md](docs/ANALYSE_ET_DECISIONS.md)** : modules, modèle de données, mécanismes de
cohérence, choix du scénario de référence, **points de règlement à arbitrer**, couverture du cahier des charges et
limites connues.
