# BACKSTAGE — ligne éditoriale (version 0.3)

## Identité
BACKSTAGE est un média **d'actualité et de société sur la musique live**.
Il suit les festivals, les grands concerts, les tournées, les retours et
reformations d'artistes, la billetterie, les festivals et l'économie du spectacle vivant.
La couverture privilégie la France et ses pays voisins, sans exclure les événements
internationaux importants. Aucun « partenariat » ou « média accrédité » sans preuve.

## Hiérarchie éditoriale
1. **Breaking news importantes** : reformation d'un groupe marquant, tournée majeure,
   nouvelles dates en France, programmation d'un grand festival, annulation, changements majeurs.
2. **Festivals** : affiches confirmées, billetterie, organisation, retours sourcés.
3. **Live & société** : tarification dynamique, économie, travail, accessibilité, sécurité,
   environnement, culture des concerts. Les controverses sont exposées loyalement.
4. **Dossiers et guides** : articles explicatifs et angles de fond.
5. **Reportages** : uniquement après entretiens ou présence sur le terrain réels.

Le site n'est pas un agenda exhaustif des salles et ne suit pas deux salles arbitraires.
Aucun quota mécanique. Une grande annonce mondiale vaut davantage que dix micro-brèves.

## Production réaliste
- Deux recherches automatiques par jour à partir de six recherches thématiques RSS.
- Maximum cinq **candidats** par passage, regroupés dans une Pull Request GitHub.
- Les titres et médias détectés servent de **pistes**, jamais de sources suffisantes.
- Une personne vérifie auprès de l'artiste, du festival, du tourneur ou de la salle.
- La vérification porte sur les villes, dates, tarifs, lieux, reprogrammations et disponibilité.
- La rédaction originale peut être assistée par IA, mais ce module n'est pas encore activé.
- Choisir au plus quelques sujets forts : viser initialement 1 à 3 contenus publiés
  par semaine, et réagir plus vite en cas d'annonce exceptionnelle.
- Ne pas automatiser la publication avant relecture humaine.

## Confiance et déontologie
- Ne pas copier les articles d'autres médias ni les photos sous droit.
- Citer les sources primaires, et attribuer les informations de presse utilisées.
- Date de publication exacte, correction lorsqu'une annonce évolue.
- Ne pas inventer interviews, reportages, critiques de concert, statistiques d'audience
  ou relations avec des organisateurs.
- Déclarer les invitations, prises en charge, liens affiliés et contenus sponsorisés.
- Une invitation ou une accréditation n'achète jamais une critique favorable.
- Avant de démarcher : renseigner une adresse de contact, l'identité éditoriale,
  les mentions légales applicables et des références éditoriales réelles.

## Technologie et limites
- Site statique déployé par GitHub Pages, code dans index.html.
- Config de veille dans config/sources.json, radar dans scripts/veille.py.
- RSS Google Actualités : mécanisme d'agrégation non documenté officiellement.
  Disponibilité et couverture non garanties. Il peut rater une annonce ; compléter par
  des sources officielles ciblées en cas de grand événement.
- Les Pull Requests contiennent seulement des **propositions d'angles**. Une fusion
  marque les liens repérés comme vus. Elle ne publie aucun article.
- L'IA payante n'est pas nécessaire pour le radar. Jamais de clé en dépôt public.

## Prochaines évolutions utiles
1. Un petit back-office « Approuver / Rejeter » indépendant de GitHub.
2. Un générateur de brouillons à partir de sources **officiellement confirmées**.
3. Un système de pages d'articles statiques indexables, avec métadonnées de recherche.
4. Contact professionnel et transparence légale.
