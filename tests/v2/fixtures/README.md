Pages reconstruites pour les tests hors ligne (aucun téléchargement réel).

- `rw-massive-attack.html` : structure de la page officielle Rock Werchter telle
  qu'observée le 3 novembre 2026 — date « 28 October 2026 » seule sous le titre,
  sans métadonnée ; en-tête « 1-2-3-4 July 2027 », mention du 27 juin 2003,
  billetterie « Friday 30 October », pied de page « © Rock Werchter 2026 ».
- `rw-turnstile.html` : communiqué sans aucune date visible (cas le plus dur).
- `rw-news-listing.html` : sommaire d'actualités avec plusieurs cartes datées.
  La date de Turnstile (30 octobre) est une hypothèse de test, pas une donnée réelle.

Pour ajouter un cas réel : enregistrer le HTML d'une page qui a posé problème
et écrire le test correspondant dans `engine.test.ts`.
