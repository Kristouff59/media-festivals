# BACKSTAGE — publier des articles assistés avec OpenAI

## Fonctionnement
Le radar gratuit détecte les nouvelles musicales deux fois par jour.
L'API OpenAI peut préparer un article, rechercher une annonce officielle et
vérifier la présence d'au moins trois passages textuels sur cette page.
Si elle ne dispose pas de preuves suffisantes, rien n'est proposé.
Si un article passe les contrôles, GitHub ouvre une Pull Request intitulée
**BACKSTAGE — article prêt à approuver**.

**Aucune publication automatique :** vous cliquez sur Merge pull request
pour publier sur GitHub Pages, ou sur Close pull request pour rejeter.
Cela implique toujours une responsabilité éditoriale humaine.

## Activer l'API OpenAI une seule fois

1. Ouvrir https://platform.openai.com/api-keys et se connecter.
2. De préférence, créer un projet API distinct nommé BACKSTAGE.
3. Créer une clé API dans ce projet.
4. Ouvrir https://github.com/Kristouff59/media-festivals/settings/secrets/actions
5. Cliquer New repository secret.
6. Nom : `OPENAI_API_KEY`
7. Valeur : votre clé privée OpenAI ; confirmer avec Add secret.
8. Revenir dans https://github.com/Kristouff59/media-festivals/actions/workflows/veille.yml
   puis cliquer Run workflow pour vérifier le fonctionnement.

**Ne jamais insérer la clé API dans un fichier du dépôt public, dans le site
ni dans une conversation.** Les secrets GitHub sont transmis seulement à
l'exécution du workflow sur GitHub Actions.

## Facturation — point important
L'abonnement ChatGPT Plus ne comprend pas l'utilisation de l'API OpenAI.
Vous devrez disposer d'un compte API facturable ou de crédits disponibles.

Le modèle configuré est `gpt-5.4-mini` avec OpenAI Responses API.
La recherche Web utilise l'outil officiel `web_search`.
La facturation tient compte des tokens et des recherches Web.

Les appels sont limités à **deux candidats maximum par passage du radar** ;
chaque candidat peut utiliser une recherche Web et, en cas de source suffisamment
corroborée, un appel supplémentaire de rédaction. Tant qu'une proposition de
publication est ouverte, l'automatisation s'abstient de proposer un nouvel article.

Réglez un plafond de dépenses et les alertes appropriées dans
https://platform.openai.com/settings/organization/limits
et suivez l'utilisation sur https://platform.openai.com/usage.
Les alertes et budgets souples ne constituent pas nécessairement des limites
de dépenses bloquantes ; vérifier les contrôles disponibles sur le compte.
L'absence de clé signifie zéro appel API.

## Exigence journalistique
- Rock comme culture de référence ; ouverture à tous les genres.
- Un article sensible, humain et vivant, sans langue administrative.
- Une curiosité pour les réalités sociales de la musique live, non partisane.
- Informations primaires confirmées et citations discrètes sous l'article.
- Pas de reportage inventé, pas de copie d'article tiers.
- Brève courte quand les faits sont rares ; format long quand c'est justifié.
- Les vérifications automatiques réduisent les erreurs, sans les éliminer.
- Une source inaccessible, une mauvaise correspondance ou un doute
  significatif entraîne l'abandon de la proposition.
- Aucun média ne peut garantir la publication de toutes les annonces importantes.

## Dépannage
- Un workflow vert avec zéro article n'est pas nécessairement un problème :
  l'actualité peut manquer de sources officielles corroborables.
- `OPENAI_API_KEY` absent : le radar fonctionne mais la rédaction n'est pas activée.
- HTTP 401 : clé invalide ; HTTP 429 : limite / crédit API possiblement épuisé.
- Le journal GitHub ne doit jamais afficher la valeur de la clé.
- Chaque nouvelle proposition de publication est une Pull Request distincte
  du radar `bot/radar-musique-live` ; la fusion des fiches de veille ne publie rien.
