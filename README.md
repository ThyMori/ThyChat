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
js/chat.js              interface de messagerie (espaces, discussions, messages en temps réel, membres)
js/themes.js            palette de couleurs : une couleur par espace
js/install.js           rappel et guide d'installation de l'application
js/version.js           numéro de version affiché en bas de l'application
scripts/bump-version.mjs  incrémente la version (version.js, sw.js, CHANGELOG.md)
CHANGELOG.md            journal des versions
sw.js                   service worker (coquille hors ligne)
manifest.webmanifest    installation sur mobile / ordinateur
icons/                  icônes de l'application
supabase/schema.sql     tables, sécurité (RLS), temps réel
supabase/migrations/    mises à jour de la base, à exécuter une fois dans l'ordre
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
2. Dans ThyChat, **crée un espace** avec le bouton **+** à côté du sélecteur d'espace : tu en deviens administrateur et un canal « général » est créé.
3. Ouvre **Membres de l'espace** et ajoute la personne invitée par son e-mail (son compte doit exister : étape 1).

Les administrateurs d'un espace créent les canaux et gèrent les membres ; les membres lisent, écrivent et suppriment leurs propres messages.

## Mettre à jour la base

Quand une version ajoute un fichier dans `supabase/migrations/`, colle son contenu dans **SQL Editor** puis **Run** (sans risque si exécuté deux fois). Une installation neuve n'a besoin que de `supabase/schema.sql`.

| Fichier | Apporte |
| --- | --- |
| `002_workspace_theme.sql` | la couleur de chaque espace (sans elle, la couleur est déduite de l'espace et ne peut pas être choisie) |

## Couleurs des espaces

Chaque espace (une production, une compagnie…) a sa couleur, qui teinte toute l'interface : fond, barre latérale, bulles, boutons. À la création, ThyChat propose une couleur pas encore utilisée par tes autres espaces ; les administrateurs la changent dans **Espace et membres**. La palette est dans `js/themes.js`.

## Versions

Le numéro (`MAJEUR.FONCTION.ESTHÉTIQUE`) est affiché en petit en bas de l'application. À chaque livraison : `node scripts/bump-version.mjs <major|feature|fix> "description"`, puis commit. `--check` vérifie la cohérence. Détails dans `CLAUDE.md` et `CHANGELOG.md`.

## Installer l'application

Un bandeau propose l'installation (reportable une semaine, trois fois maximum) et le bouton **Installer l'application** du menu ouvre un guide adapté à l'appareil : iPhone/iPad, Android, Chrome/Edge, Safari sur Mac. Sur Chrome, Edge et Android, le bouton déclenche l'installation native.

## Feuille de route

- [x] Structure PWA, écran de connexion, gestion des invitations
- [x] Schéma de base de données et règles de sécurité
- [x] Espaces, canaux et membres
- [x] Messages en temps réel (envoi, suppression, liens cliquables)
- [x] Couleur par espace, look « bulles » façon messagerie grand public
- [ ] Fils de discussion, messages épinglés, recherche
- [ ] Envoi de fichiers et d'images (plans de feu, fiches techniques)
- [ ] Messages privés
- [ ] Notifications push
- [ ] Indicateurs de messages non lus
- [ ] Gestion des membres (retirer, changer de rôle) et des canaux (renommer, supprimer)

## Dépannage

**L'écran reste sur « Chargement… »** : après 8 secondes, l'application affiche un bandeau avec le détail de l'erreur et un bouton **Réinitialiser et recharger**. Il supprime le service worker et les caches (la session de connexion est conservée). Si le bandeau n'apparaît pas, faire un rechargement forcé (Ctrl/Cmd + Maj + R) ou vider les données du site dans le navigateur.
