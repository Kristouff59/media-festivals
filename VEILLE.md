# BACKSTAGE — Radar d'actualité musique live

## Objectif
Repérer de grands sujets d'actualité : concerts, tournées, reformations, festivals
et sujets de société. **Ce n'est pas un agenda de salles.**

La veille utilise six recherches RSS thématiques, dont une en anglais pour
détecter les grands retours de groupes internationaux.
Les flux Google Actualités ne constituent ni une source officielle ni une API
garantie. On les utilise uniquement pour la **découverte de sujets**.

## Automatisation sans API payante
- Deux exécutions quotidiennes via GitHub Actions (heures UTC).
- Maximum **5 sujets proposés par passage** afin de limiter la charge.
- Les doublons de titres sont supprimés.
- Seuls des titres et liens de découverte sont conservés, jamais le texte
  complet d'articles externes.
- Les propositions sont consignées dans `data/candidats/`.
- Une seule Pull Request récurrente, si de nouveaux candidats existent.
- Aucun article n'est publié automatiquement. Un événement important peut
  encore être manqué ou détecté avec retard.

## Vérifier une Pull Request
1. Ouvrir `Pull requests` → `BACKSTAGE — nouvelles pistes éditoriales à vérifier`.
2. Ouvrir `Files changed` et lire la liste de candidats.
3. Conserver uniquement les sujets vraiment importants.
4. **Confirmer chaque information directement auprès de l'artiste, du festival,
   du tourneur ou de l'organisateur**, y compris les dates et les changements.
5. Préparer un article original puis relire avant publication.
6. Fusionner la PR pour mémoriser les sujets déjà vus (la fusion ne publie rien
   sur le magazine).

## À savoir
- `data/source_state.json` vient de l'ancienne surveillance de pages ;
  il n'est plus utilisé par le nouveau radar.
- Le moteur ne génère pas encore de véritables brouillons IA ; prochaine étape.
- Aucun accès premium, compte Google News ou clé API ne sont requis.
- Si les flux RSS deviennent indisponibles, l'exécution sera signalée en échec.
- Le site GitHub Pages est totalement distinct de ces candidats : il ne présente
  que des articles intégrés au code du site après vérification.

## Test
GitHub → Actions → `BACKSTAGE — radar musique live` → Run workflow (nouvelle exécution).
Les logs affichent les titres inspectés et le nombre de propositions.
