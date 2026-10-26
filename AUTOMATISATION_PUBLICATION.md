# BACKSTAGE — architecture éditoriale Supabase + OpenAI

**Nouvelle architecture privilégiée (26 octobre 2026).** L'article complet,
la validation et la publication se font depuis BACKSTAGE `/admin/`.
Le moteur de veille autonome est préparé dans Supabase Edge Functions, mais
**il n'est pas encore déployé ni programmé sur le projet Supabase**.
Tant que les tests réels ne sont pas achevés, l'ancien radar GitHub
reste actif pour éviter une interruption.

**Procédure de mise en service :**
[MIGRATION_SUPABASE_OPENAI.md](MIGRATION_SUPABASE_OPENAI.md)

Le reste de cette page décrit l'ancien circuit de transition, conservé
uniquement jusqu'au basculement définitif.

---


## Ce que voit la rédaction

- Accès : https://kristouff59.github.io/media-festivals/admin/
- Après mise sur votre propre domaine : `https://votre-domaine/admin/`
- Connexion privée par e-mail et mot de passe : un compte rédacteur créé dans Supabase Auth, sans nécessité de serveur SMTP.
- Liste des articles **complets**, avec titres, intertitres, paragraphes et sources.
- **Publier cet article** : l'article devient directement visible sur le site public sans Pull Request ni déploiement GitHub.
- **Refuser** : l'article est écarté, aucune publication.
- Une actualité de festival peut modifier simultanément sa fiche programmation.

Les brouillons sont conservés dans une base Supabase privée. Les visiteurs non connectés ne voient que les articles **déjà publiés** ; le moteur historique statique reste en place pour les articles plus anciens.

Le site et son tableau de bord sont installés dans le dépôt, mais **l'espace privé n'est pas opérationnel avant les étapes de configuration ci-dessous**. Pendant cette transition, la veille utilise l'ancien circuit GitHub Issues pour éviter d'interrompre la production éditoriale.

## Mise en service (une seule fois)

### 1. Créer la base privée

1. Sur https://supabase.com/dashboard, créer un **nouveau projet distinct** intitulé `BACKSTAGE` (ne pas réutiliser la base de vos autres projets).
2. Dans l'éditeur SQL du projet, exécuter `supabase/schema.sql`.
3. Dans Authentication > Users > Add user > Create new user, créer **votre utilisateur rédacteur**, avec votre adresse e-mail et un mot de passe fort. Laisser **Auto Confirm User** activé pour pouvoir vous connecter immédiatement sans SMTP. Le mot de passe ne doit jamais être commité ni partagé.
4. Dans Authentication > Users, copier l'identifiant UUID (User UID) de cet utilisateur.
5. Dans SQL Editor, exécuter :
   `insert into public.editorial_admins(user_id) values ('VOTRE-UUID-ICI');`
6. Optionnel pour l'authentification par mot de passe ; utile si des liens de réinitialisation ou invitations sont activés : dans Authentication > URL Configuration, autoriser comme Redirect URL :
   `https://kristouff59.github.io/media-festivals/admin/`.
   Après migration de domaine, remplacer ou ajouter `https://votre-domaine/admin/`.

### 2. Relier le site et le moteur de veille

Depuis Supabase, relever le **Project URL** et la **publishable API key**.

Dans `admin/config.js`, remplacer :
- `SUPABASE_URL` : URL publique `https://<projet>.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` : clé `sb_publishable_...` (ou ancienne clé `anon`).

Ces deux paramètres sont **publics par nature**, mais l'accès aux brouillons est protégé par l'authentification et les politiques RLS. **Ne jamais placer la clé secrète dans un fichier du site.**

Dans les GitHub Actions **Secrets** du dépôt technique, ajouter :
- `SUPABASE_URL` : même URL Supabase
- `SUPABASE_SECRET_KEY` : clé serveur `sb_secret_...` (ou ancienne clé `service_role`).

Dès que ces secrets existent, la veille dépose ses nouveaux brouillons dans Supabase au lieu de créer des Issues GitHub. La soumission est dédoublonnée et arrêtée lorsque cinq articles attendent une décision.

### 3. Notifications e-mail

Option recommandée : https://resend.com (formule gratuite sous réserve des quotas).

Créer une clé de **simple envoi**, vérifier votre domaine d'envoi dans Resend, puis ajouter les Secrets GitHub :
- `RESEND_API_KEY` : clé privée Resend
- `BACKSTAGE_ALERT_EMAIL` : adresse où recevoir « Nouvel article à valider »
- `BACKSTAGE_FROM_EMAIL` : adresse expéditrice autorisée par Resend (ex. `BACKSTAGE <redaction@votre-domaine.fr>`).

Facultatif : dans **Settings → Secrets and variables → Actions → Variables**, ajouter `BACKSTAGE_SITE_URL` avec l'URL racine du magazine, pour que les e-mails pointent vers le futur domaine.

Sans Resend configuré, le tableau de bord peut servir, **mais aucune notification par e-mail n'est envoyée**. Les anciennes alertes ChatGPT qui surveillent les Issues GitHub ne sont pas adaptées à la nouvelle base privée et devront être désactivées après migration.

## Fonctionnement de la publication

Le site récupère les articles publiés depuis Supabase avec une **clé publique et des politiques Row Level Security** : les brouillons en attente ou rejetés restent invisibles. L'approbation utilise une fonction SQL transactionnelle vérifiant l'identité du rédacteur.

La commande **Publier** affecte immédiatement le statut `published`. Aucun jeton GitHub, aucun workflow de déploiement et aucun mot de passe serveur n'est nécessaire dans le navigateur. Le code du site reste versionné sur GitHub, mais le rédacteur n'a plus à y accéder.

Le modèle OpenAI sert uniquement à rechercher et proposer une rédaction ; la publication ne nécessite pas de crédit OpenAI.

## Sécurité et limites

- Projet Supabase dédié et politiques RLS. Seuls les utilisateurs placés dans `editorial_admins` peuvent lire les brouillons et prendre une décision.
- La clé serveur Supabase doit rester dans les Secrets du moteur technique ; seuls l'URL publique et la clé publishable sont visibles dans le navigateur.
- Aucun brouillon n'est ajouté au HTML public avant approbation.
- Le site lit actuellement les dernières 100 publications de Supabase en complément du catalogue statique.
- La vérification automatique des sources réduit les risques, sans garantir l'exactitude absolue.
- Un projet Supabase Free peut être mis en pause après une période d'inactivité. La partie statique du magazine reste visible, mais les nouveaux articles dynamiques ne le seront pas tant que la base n'est pas accessible.
- Après changement de domaine, il faut reconfigurer les redirect URLs d'authentification et éventuellement le lien expéditeur des notifications. Le circuit de validation reste identique.

## Vérification de mise en service

1. Ouvrir `/admin/` puis se connecter.
2. Déclencher le radar GitHub Actions une seule fois pour **tester la génération**.
3. Vérifier qu'un article complet apparaît dans la rédaction, sans apparaître sur le site public.
4. Cliquer **Publier cet article** et vérifier qu'il est visible sur la page publique.
5. Faire un second essai avec **Refuser** pour confirmer qu'un brouillon rejeté reste privé.
6. Vérifier la notification e-mail si Resend est configuré.

**Important** : à ce stade, le code est prêt à connecter, mais l'intégration n'a pas pu être testée de bout en bout sans votre projet Supabase, votre utilisateur et les secrets de notification.
