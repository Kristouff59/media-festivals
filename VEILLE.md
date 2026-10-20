# BACKSTAGE — veille gratuite (version 0.2)

Le site public reste servi par GitHub Pages depuis la branche main.
La veille quotidienne prépare uniquement des propositions dans une Pull Request GitHub.
Elle n'écrit pas sur le site et n'envoie aucun email.

## Activation

1. Ouvrir Settings → Actions → General → Workflow permissions.
2. Activer Read and write permissions, et Allow GitHub Actions to create and approve pull requests.
3. Ouvrir Actions → BACKSTAGE — veille officielle → Run workflow.
4. Le premier passage établit seulement une référence des pages officielles.
5. Dans Pull requests, relire et fusionner la proposition de référence.
6. Les exécutions suivantes peuvent créer des brouillons dans data/review_queue pour vérification.

Le workflow s'exécute environ une fois par jour via GitHub Actions ; l'horaire effectif peut varier.
Il peut échouer si un site bloque l'extraction automatique, et ces cas ne valent pas annonces.
Il ne consomme pas d'API d'IA payante. La rédaction assistée par IA et l'intégration des articles
dans le site seront mises en place ensuite. Ne publier aucune annonce sans vérifier sa source.
