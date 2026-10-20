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

## Longueur et valeur ajoutée des articles

Pas de longueur imposée aveuglément : **un sujet mérite la place nécessaire, pas davantage**.

| Format | Ordre de grandeur | Apport indispensable |
|---|---:|---|
| **Flash / brève** | 100–220 mots | Quoi, qui, où, quand, source vérifiée, lien utile |
| **Actualité** | 250–500 mots | Faits confirmés, contexte, implications pratiques |
| **Décryptage / dossier** | 550–1 100 mots | Question claire, points de vue attribués, documents croisés, rubriques |
| **Reportage / entretien** | Selon la matière récoltée | Observations et propos réellement recueillis, attribution et contexte |

Ces fourchettes sont des repères éditoriaux, pas des obligations.
Une petite annonce ne doit pas être gonflée de paragraphes artificiels.
Un sujet important ne doit pas être traité en trois phrases si des questions
essentielles restent sans réponse.

Chaque article doit apporter au moins **une valeur propre** : mise en contexte,
comparaison de sources, clarification de données, explication pour le public,
question pertinente, document primaire, angle d'analyse ou reportage réel.
**Recopier ou paraphraser mécaniquement un seul confrère ne suffit pas.**

Les sources apparaissent sous l'article, avec au moins une référence primaire
pour les annonces majeures quand elle est disponible. Les faits obtenus par
un média tiers sont attribués à ce média, sans se faire passer pour leur auteur.
Un article n'est jamais présenté comme un reportage s'il n'y a eu ni déplacement,
ni entretien, ni observation réelle.

## Circuit d'édition — obligatoire pour toute nouvelle publication

1. Le radar trouve des pistes, pas des faits confirmés.
2. Le rédacteur sélectionne un sujet ayant une portée réelle.
3. Les informations sont confrontées aux communications et documents originaux.
4. Un brouillon avec titre, angle, format, dates, attribution et liens sources est préparé.
5. **Contrôle éditorial humain substantiel** : la personne responsable vérifie les
   faits, choisit les formulations et décide d'approuver, corriger ou rejeter.
6. Publication seulement après cette approbation ; conserver une trace des
   sources utilisées et de la date de vérification.
7. Corriger et dater toute modification factuelle significative.

Aucune publication en masse sans approbation. La responsabilité éditoriale
appartient à une personne ou structure réellement identifiable.

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
