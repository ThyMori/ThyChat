# ThyChat

Messagerie professionnelle pour les équipes de spectacle vivant : espaces par équipe, canaux par production, fils de discussion, fichiers. Accès sur invitation uniquement.

**Stack** : PWA statique (HTML / CSS / JavaScript, sans étape de build) hébergée sur GitHub Pages, avec [Supabase](https://supabase.com) pour l'authentification, la base Postgres et le temps réel.

## Structure

```
index.html              coquille de l'application (écrans : chargement, connexion, mot de passe, app)
css/style.css           thème (variables de couleur dans :root)
js/config.js            URL + clé publique Supabase (à renseigner)
js/supabase.js          client Supabase
js/app.js               authentification et routage des écrans
sw.js                   service worker (coquille hors ligne)
manifest.webmanifest    installation sur mobile / ordinateur
icons/                  icônes de l'application
supabase/schema.sql     tables, sécurité (RLS), temps réel
```

## Mise en route

### 1. Créer le projet Supabase

1. Créer un projet sur supabase.com, avec une région européenne (RGPD).
2. **SQL Editor > New query** : coller le contenu de `supabase/schema.sql`, puis **Run**.
3. **Authentication > Sign In / Providers** : désactiver **Allow new users to sign up** (accès sur invitation uniquement).
4. **Authentication > URL Configuration** : mettre en **Site URL** l'adresse de l'application (`https://thychat.thierry-morin.com/`) et l'ajouter aussi dans **Redirect URLs**.
5. **Project Settings > API** : copier l'**URL du projet** et la **clé publique** (`anon` ou `publishable`) dans `js/config.js`.
   La clé `service_role` / `secret` ne doit **jamais** y figurer.

### 2. Publier sur GitHub Pages

L'application est servie sur `https://thychat.thierry-morin.com/` (le fichier `CNAME` à la racine déclare le domaine).

1. **DNS** (chez l'hébergeur du domaine `thierry-morin.com`) : ajouter un enregistrement **CNAME** `thychat` pointant vers `thymori.github.io`.
2. **Settings > Pages > Build and deployment** : *Deploy from a branch*, branche `main`, dossier `/ (root)`.
3. **Settings > Pages > Custom domain** : vérifier que `thychat.thierry-morin.com` est renseigné, attendre la validation du DNS, puis cocher **Enforce HTTPS**.

### 3. Inviter les équipes

1. **Supabase > Authentication > Users > Invite user** : la personne reçoit un e-mail, clique, choisit son nom et son mot de passe.
2. Créer un espace (pour l'instant en SQL, l'interface arrive ensuite) :

   ```sql
   insert into public.workspaces (name, created_by)
   values ('Mon équipe', '<ton user id>');   -- Authentication > Users > colonne « User UID »
   ```
   Le créateur devient automatiquement administrateur de l'espace.
3. Ajouter un compte invité à l'espace :

   ```sql
   select public.add_member_by_email('<id de l''espace>', 'prenom@exemple.fr');
   ```

## Feuille de route

- [x] Structure PWA, écran de connexion, gestion des invitations
- [x] Schéma de base de données et règles de sécurité
- [ ] Liste des espaces et des canaux
- [ ] Messages en temps réel
- [ ] Fils de discussion, messages épinglés, recherche
- [ ] Envoi de fichiers et d'images (plans de feu, fiches techniques)
- [ ] Messages privés
- [ ] Notifications push
- [ ] Interface d'administration (inviter, gérer les membres)
