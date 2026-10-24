# BACKSTAGE — boîte de validation des articles

## Le nouveau fonctionnement

Tu n'as **plus besoin d'utiliser les Pull Requests pour publier un article**.

1. GitHub Actions surveille l'actualité deux fois par jour.
2. Les scripts et OpenAI recherchent des sources officielles et rédigent un article.
3. Les contrôles automatiques peuvent refuser une proposition insuffisamment fondée.
4. Quand un texte est suffisamment abouti, le robot crée une **Issue de relecture** dans le dépôt GitHub. Elle contient le texte intégral et les sources ; elle t'est assignée et elle te mentionne.
5. Tu reçois une notification GitHub si tes réglages de notification le permettent. En ouvrant l'Issue, **tu lis immédiatement l'article complet**, sans consulter de code.
6. Tu écris simplement `PUBLIER` en commentaire : GitHub vérifie que le commentaire provient de `Kristouff59`, puis ajoute le texte à BACKSTAGE et demande la reconstruction de GitHub Pages.
7. Tu écris `REFUSER` : l'article est écarté et rien n'est ajouté au site.

Pour voir tous tes textes en attente :
https://github.com/Kristouff59/media-festivals/issues?q=is%3Aissue+is%3Aopen+assignee%3AKristouff59

Pour recevoir des messages, vérifier les notifications GitHub et les préférences e-mail :
https://github.com/settings/notifications

**Important : le dépôt est PUBLIC. Les Issues, y compris le texte non encore approuvé, sont visibles publiquement.**
Ce système ne doit pas accueillir de contenu confidentiel ou sous embargo.
Pour un espace éditorial privé, il faudrait passer par un dépôt GitHub privé séparé ou un outil d'approbation doté d'une connexion sécurisée.

## Sécurité, publication et limites

- Les textes ne sont jamais publiés sans un commentaire de l'éditeur contenant exactement `PUBLIER`.
- Seul le compte GitHub `Kristouff59` est autorisé par le workflow de décision.
- Les nouvelles fiches sont créées uniquement par GitHub Actions ; leur contenu éditorial est scellé par une empreinte de contrôle pour éviter les modifications non souhaitées.
- GitHub refuse de remplacer un article ou une fiche festival modifiée depuis la préparation.
- Les sources officielles restent consultables, discrètement, sous les articles.
- Le système accepte jusqu'à **cinq propositions simultanées**, pour éviter qu'un seul article non traité n'arrête la rédaction.
- Une approbation fait un commit sur `main` et demande une reconstruction GitHub Pages. Un problème d'autorisation Pages ou de configuration peut empêcher la mise en ligne automatique ; le commentaire de résultat dans l'Issue signale cette difficulté.
- Les vérifications documentaires automatisées réduisent les erreurs, mais ne sont pas infaillibles. L'éditeur garde la responsabilité de publication.

## Consommation de l'API

- Secret GitHub : `OPENAI_API_KEY` (ne jamais le publier).
- Modèle : `gpt-5.4-mini`, via Responses API, avec recherche Web OpenAI.
- La veille RSS Google Actualités reste gratuite hors cas de secours OpenAI.
- Le moteur traite au maximum deux sujets potentiels par exécution du radar ; il peut en proposer au plus un par exécution.
- Le compte API OpenAI est distinct de ChatGPT Plus et peut être facturé.
- Consulter https://platform.openai.com/usage et les limites de consommation.

## Dépannage

- Workflow vert sans nouvelle Issue : aucun texte n'a satisfait les vérifications, ou le nombre maximal de propositions est atteint.
- Une nouvelle Issue peut déclencher une alerte GitHub par assignation et mention ; la livraison par e-mail dépend de tes paramètres GitHub.
- Tu peux lire un article complet depuis un navigateur ou l'application GitHub sur ton téléphone.
- Si une décision échoue, consulter Actions → BACKSTAGE — publier ou refuser un article.
- La veille ne génère plus de Pull Requests de suivi ; les données du radar sont archivées automatiquement.
