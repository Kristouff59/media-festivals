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

## Préparation automatique d'articles (nouvelle étape)

Lors d'une veille réussie, `scripts/preparer_articles.py` sélectionne au maximum
**trois sujets par passage** et crée des fiches dans `data/brouillons/AAAA-MM-JJ/`.

Chaque fiche contient : titre provisoire, angle de traitement, format et longueur
conseillés, plan d'article, éléments factuels à confirmer, lien de découverte
et cases de vérification. Un sujet de fond peut déboucher sur un article long ;
une petite annonce ne doit pas être gonflée artificiellement.

**Important : les fiches ne sont PAS des articles rédigés.** Les informations
des agrégateurs sont des pistes à recouper auprès d'une source primaire.
La génération de prose complète par modèle n'est pas activée : elle demanderait
une source officielle confirmée et, pour un service API payant, une clé dédiée.
Aucune clé ni aucun coût n'est requis pour les fiches actuelles.

### Décider quoi publier

1. Dans la Pull Request du radar, examiner `data/brouillons/`.
2. Rejeter les sujets locaux peu importants ou déjà traités.
3. Confirmer dates, noms, lieux et chiffres par des liens officiels.
4. Rédiger un texte original avec une valeur ajoutée, puis le faire relire.
5. Publier uniquement l'article validé ; fusionner une fiche ne le publie pas.

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
- Le moteur génère des fiches structurées ; la rédaction intégrale à partir de faits confirmés reste à connecter.
- Aucun accès premium, compte Google News ou clé API ne sont requis.
- Si les flux RSS deviennent indisponibles, l'exécution sera signalée en échec.
- Le site GitHub Pages est totalement distinct de ces candidats : il ne présente
  que des articles intégrés au code du site après vérification.

## Test
GitHub → Actions → `BACKSTAGE — radar musique live` → Run workflow (nouvelle exécution).
Les logs affichent les titres inspectés et le nombre de propositions.
