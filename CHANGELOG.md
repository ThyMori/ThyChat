# Journal des versions

Numérotation `MAJEUR.FONCTION.ESTHÉTIQUE`, affichée en bas de l'application :

- **MAJEUR** : changement majeur (refonte, rupture, action requise pour les utilisateurs). Remet les deux autres chiffres à 0.
- **FONCTION** : nouvelle fonction. Remet le dernier chiffre à 0.
- **ESTHÉTIQUE** : correction esthétique, retouche visuelle ou petit correctif sans nouvelle fonction.

Quand une livraison mélange plusieurs types de changements, le plus haut niveau l'emporte.

## 3.3.1 — 2026-11-14
- La section « Photo de l'espace » reste visible pour les administrateurs même avant la migration 007, avec une explication

## 3.3.0 — 2026-11-14
- Un utilisateur peut rayer son message (et le rétablir)
- photo de chaque espace choisie par ses administrateurs
- migration 007 à exécuter

## 3.2.0 — 2026-11-14
- Invitation : liste déroulante des personnes déjà présentes pour les ajouter à un espace (fonction invite-member à redéployer)

## 3.1.0 — 2026-11-14
- Dates de tournée par salon (étiquettes choisies avec #, filtre des messages par date)
- répondre à un message et citer
- migration 006 à exécuter

## 3.0.0 — 2026-11-14
- Nouvelle hiérarchie : espace (production ou compagnie) > salon (un spectacle) > sous-salon (par métier), avec deux niveaux d'accès
- les salons existants deviennent des salons avec un sous-salon « Tous »
- migration 005 et fonctions invite-member / send-push à redéployer

## 2.0.3 — 2026-11-14
- Bouton « Retour » du téléphone : ramène à la liste des salons ou ferme la fenêtre ouverte, au lieu de bloquer sur un écran gris

## 2.0.2 — 2026-11-14
- Le bouton « Installer l'application » lance l'installation directement et disparaît une fois l'application installée

## 2.0.1 — 2026-11-14
- Déclencheur des notifications push en SQL (migration 004), plus simple que le Database Webhook

## 2.0.0 — 2026-11-14
- Rôles (administrateur général, administrateur d'espace, utilisateur) et invitations depuis l'application
- Salons à accès restreint et messages privés
- Notifications push avec silence 8 h / 1 semaine / toujours par espace et par salon
- Pastilles de messages non lus (liste, espaces, icône)
- Profil avec photo, nom et e-mail
- Action requise : exécuter la migration SQL 003 et déployer les fonctions Supabase

## 1.1.0 — 2026-11-14
- Rappel et guide pour installer l'application sur téléphone et ordinateur
- Numéro de version affiché en bas de l'application

## 1.0.0 — 2026-11-14
- Première version : connexion sur invitation, espaces avec une couleur chacun, discussions, messages en temps réel, gestion des membres, application installable (PWA)
