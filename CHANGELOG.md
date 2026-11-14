# Journal des versions

Numérotation `MAJEUR.FONCTION.ESTHÉTIQUE`, affichée en bas de l'application :

- **MAJEUR** : changement majeur (refonte, rupture, action requise pour les utilisateurs). Remet les deux autres chiffres à 0.
- **FONCTION** : nouvelle fonction. Remet le dernier chiffre à 0.
- **ESTHÉTIQUE** : correction esthétique, retouche visuelle ou petit correctif sans nouvelle fonction.

Quand une livraison mélange plusieurs types de changements, le plus haut niveau l'emporte.

## 3.10.0 — 2026-11-14
- Documents PDF par date de tournée (feuilles de route, billets, livrets) ajoutés par les administrateurs, lisibles par les membres

## 3.9.1 — 2026-11-14
- Boutons loupe, poubelle et cloche : icônes au trait, plus sobres (à la place des émojis)

## 3.9.0 — 2026-11-14
- Recherche sans accents
- nouveau logo : œil de chat dont la pupille forme un T

## 3.8.0 — 2026-11-14
- Recherche dans les messages
- messages privés en liste compacte, du plus récent au plus ancien, avec recherche de fil dans le +

## 3.7.0 — 2026-11-14
- Messages privés communs à tous les espaces (une seule discussion par paire)
- suppression d'une discussion privée entière

## 3.6.4 — 2026-11-14
- Étoile de représentation centrée sur le jour et posée sur la frise de la date (calendrier et frise du spectacle)

## 3.6.3 — 2026-11-14
- Invitation : si la session a expiré, elle est renouvelée automatiquement avant de réessayer (sinon message clair)

## 3.6.2 — 2026-11-14
- La liste des dates indique les jours de représentation ★ (ou leur absence)

## 3.6.1 — 2026-11-14
- Création d'un sous-salon ou d'un spectacle : plus d'erreur de sécurité à l'enregistrement

## 3.6.0 — 2026-11-14
- Photos dans les messages : bouton +, collage d'une image du presse-papier, jusqu'à 4 photos, agrandissement

## 3.5.1 — 2026-11-14
- Les jours de représentation saisis sont enregistrés même sans toucher « Ajouter ★ » et l'étoile est plus visible
- le #Date choisi reste dans le message sous forme de pastille

## 3.5.0 — 2026-11-14
- Bouton « i » : page d'aide qui explique toutes les fonctions
- textes et pastilles plus petits sur téléphone

## 3.4.0 — 2026-11-14
- Dates de tournée avec plage (début, fin) et dates de représentation ★
- calendrier mensuel avec frises par date
- frise hebdomadaire dans l'en-tête du spectacle
- « Salons » devient « Spectacles »
- migration 008 à exécuter

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
