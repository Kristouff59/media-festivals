# BACKSTAGE — fonctionnement de la rédaction automatique

## Objectif
L'équipe n'a qu'une décision de publication à prendre :
**valider une Pull Request pour publier**, ou **la fermer pour rejeter**.

Le radar (gratuit) fonctionne déjà deux fois par jour. La rédaction complète
requiert une seule configuration supplémentaire : une clé d'API Gemini,
conservée dans un secret GitHub. La clé n'est jamais écrite dans le code public.

## Activer une fois, sans facturation souhaitée
1. Aller dans [Google AI Studio — clés API](https://aistudio.google.com/api-keys).
2. Créer une clé pour un **projet au niveau gratuit**, en évitant d'activer la
   facturation ou de rattacher un projet payant.
3. Copier la clé **uniquement** dans
   [GitHub → Settings → Secrets and variables → Actions](https://github.com/Kristouff59/media-festivals/settings/secrets/actions).
4. Cliquer sur **New repository secret**.
5. Nom exact : `GEMINI_API_KEY` ; valeur : ta clé privée ; puis **Add secret**.
6. Sur [Actions → BACKSTAGE — radar musique live](https://github.com/Kristouff59/media-festivals/actions/workflows/veille.yml),
   faire **Run workflow** une seule fois pour tester.

**Ne jamais coller la clé dans une conversation, un ticket, un fichier, une PR
ou sur le site public.** Vérifier régulièrement le quota et le projet utilisé.
Gemini propose des quotas sans frais en France, mais leurs niveaux et conditions
peuvent changer. Le modèle choisi est `gemini-2.5-flash` avec recherche Google.

## Comment fonctionne la vérification automatique
1. Le radar propose au maximum cinq pistes thématiques.
2. L'outil en examine au plus trois.
3. Le moteur recherche sur le Web une **source primaire** : site officiel
   d'artiste, d'organisateur ou d'institution (et non un article de presse).
4. Il exige plusieurs extraits factuels, puis ouvre la page officielle et
   cherche **au moins deux extraits exactement présents** sur la page.
5. Si l'étape échoue, ce sujet est abandonné sans publication.
6. Le moteur rédige un article original, plus humain et plus incarné, fondé
   uniquement sur les éléments corroborés.
7. Il refuse les années absentes de la source, les articles trop courts,
   les contenus sans sources et les publications en doublon.
8. Si tout passe, il prépare une **PR `bot/article-a-publier`** qui modifie
   directement `index.html`. L'article n'est pas encore en ligne.
9. Le responsable ouvre cette PR et clique **Merge pull request** pour publier,
   ou **Close pull request** pour rejeter. La fusion déclenche le déploiement du site.

**Limite essentielle :** aucun logiciel n'assure à lui seul une exactitude
journalistique absolue. Ces contrôles sont stricts et peuvent refuser beaucoup
de sujets ; ils réduisent les erreurs, sans les rendre impossibles.
La décision finale de publier reste une responsabilité éditoriale réelle.

## Ligne éditoriale de rédaction
- Une voix humaine, expressive, rythmée, pas un communiqué recopié.
- Dominante rock, sans exclure la pop, le rap, le jazz et l'électronique.
- Sensibilité sociale (accès à la musique, billet, travail, solidarité)
  sans slogans politiques.
- Les sources sont discrètement accessibles sous l'article ; ni encyclopédie
  bureaucratique ni attribution absente.
- Aucune citation ou ambiance de concert inventée.
- Brèves courtes pour petites nouvelles, articles plus développés quand
  plusieurs faits solides permettent une analyse réelle.

## En cas de panne ou sans clé
Le radar continue de fonctionner. Le système ne rédige simplement pas
d'article complet et ne crée pas de nouvelle PR de publication.

Les PR de radar `bot/radar-musique-live` sont des fiches de travail,
**pas des publications** : elles peuvent être ignorées pendant les essais.
