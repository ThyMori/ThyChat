# Journal des versions

Numérotation `MAJEUR.FONCTION.ESTHÉTIQUE`, affichée en bas de l'application :

- **MAJEUR** : changement majeur (refonte, rupture, action requise pour les utilisateurs). Remet les deux autres chiffres à 0.
- **FONCTION** : nouvelle fonction. Remet le dernier chiffre à 0.
- **ESTHÉTIQUE** : correction esthétique, retouche visuelle ou petit correctif sans nouvelle fonction.

Quand une livraison mélange plusieurs types de changements, le plus haut niveau l'emporte.

## 3.48.0 — 2026-11-15
- Demande d'inscription depuis l'écran de connexion : formulaire (nom, e-mail, spectacle/production/Cie) avec explication de la procédure Supabase, e-mail envoyé à contact@thierry-morin.com

## 3.47.0 — 2026-11-15
- Mes notes reprend les dates du spectacle (barre de dates, filtre, # et date en cours proposée à la rédaction), comme les sous-salons

## 3.46.2 — 2026-11-15
- Mes notes : spectacles classés par date la plus proche (en cours, à venir, puis passés), avec la date affichée

## 3.46.1 — 2026-11-15
- Calendrier, To-Do et Mes notes réduits sur une seule ligne pour laisser plus de place aux spectacles

## 3.46.0 — 2026-11-15
- Mes notes : un salon personnel par spectacle (messages, photos, Post-it, To-Do), visible par toi seul même des administrateurs, limité à 25 Mo de photos et 2 000 notes, sans notification
- bouton Mes notes avec recherche de spectacle

## 3.45.1 — 2026-11-15
- Un fil s'ouvre toujours sur ses derniers messages, même avec un message épinglé

## 3.45.0 — 2026-11-15
- Au lancement ou après une mise à jour, l'application s'ouvre sur le calendrier de tous les espaces (une notification ouvre toujours son fil)

## 3.44.1 — 2026-11-15
- Calendrier : la vue de base est « Tous mes espaces »

## 3.44.0 — 2026-11-15
- Mises à jour : l'application vérifie seule qu'une nouvelle version existe et affiche un bandeau « Nouvelle version disponible » pour recharger

## 3.43.2 — 2026-11-15
- Un appui à l'extérieur d'une fenêtre (To-Do, Post-it, etc.) la ferme, comme « Retour »

## 3.43.1 — 2026-11-15
- To-Do : plus aucune confirmation des coches (option retirée)
- seule la case coche ou décoche, pas la ligne

## 3.43.0 — 2026-11-15
- To-Do : option pour couper la confirmation des coches (seule la case coche alors, pas la ligne)
- la To-Do terminée ne disparaît qu'à la fermeture de la feuille

## 3.42.7 — 2026-11-15
- Téléphone : texte de l'interface agrandi de 20 % au total

## 3.42.6 — 2026-11-15
- Téléphone : texte de l'interface agrandi de 10 % (proche de WhatsApp)

## 3.42.5 — 2026-11-15
- Notifications : message clair quand le navigateur n'a pas de service de notifications (téléphone sans services Google)

## 3.42.4 — 2026-11-15
- Le fichier principal s'appelle messagerie.js : certains navigateurs (Murena) bloquaient chat.js et l'application ne démarrait pas

## 3.42.3 — 2026-11-15
- Écran d'erreur au démarrage : indique l'étape atteinte et le module qui ne se charge pas

## 3.42.2 — 2026-11-15
- Écran d'erreur au démarrage : affiche le navigateur et indique si le serveur jsDelivr est joignable

## 3.42.1 — 2026-11-15
- Le partage de l'application ne se déclenche plus par un appui parasite après l'ouverture de l'aide

## 3.42.0 — 2026-11-15
- Épingler un message ou une photo en haut du fil (24 h, 7 jours ou 30 jours, 3 au plus) avec bandeau d'accès au message

## 3.41.1 — 2026-11-15
- Dates en cours : « Ouvrir le spectacle » ouvre le fil sans filtre de date

## 3.41.0 — 2026-11-15
- Info : bouton Partager en haut de la fenêtre (adresse thychat.thierry-morin.com)

## 3.40.0 — 2026-11-15
- Tirer l'écran vers le bas ne recharge plus l'application
- bouton à double flèche (à côté de la roue crantée) pour la recharger et la mettre à jour

## 3.39.0 — 2026-11-15
- Menu : « Messages privés » repliable (›), replié par défaut, avec le total des non lus

## 3.38.5 — 2026-11-15
- Menu (téléphone) : la liste des spectacles s'adapte à leur nombre, plus de vide avant les messages privés

## 3.38.4 — 2026-11-15
- Menu : l'en-tête (logo, boutons, espace courant) reste toujours visible quand la liste défile

## 3.38.3 — 2026-11-15
- Aide : rubriques repliées par titre, avec un › pour déplier ou replier

## 3.38.2 — 2026-11-15
- Dates en cours : « Veille : début demain » au lieu de « départ demain »

## 3.38.1 — 2026-11-15
- Retour désélectionne le message sélectionné

## 3.38.0 — 2026-11-15
- Message : glisser vers la gauche le fait suivre le doigt avec surbrillance
- actions en petites icônes sobres

## 3.37.0 — 2026-11-15
- Hors-ligne : derniers messages, Post-it et To-Do gardés sur l'appareil et lisibles sans réseau, démarrage sans connexion, messages écrits sans réseau mis en file d'attente et envoyés dans l'ordre au retour du réseau

## 3.36.0 — 2026-11-15
- Post-it : une personne qui arrive dans un fil ne voit que les Post-it posés après son arrivée
- bouton « Vider la poubelle » dans Post-it jetés

## 3.35.0 — 2026-11-15
- To-Do : la personne qui coche une case la signe de son nom (visible aussi dans les To-Do terminées)

## 3.34.1 — 2026-11-15
- To-Do : confirmation à chaque case cochée ou décochée

## 3.34.0 — 2026-11-15
- To-Do : feuille de carnet à spirale avec cases à cocher partagées, qui disparaît quand tout est coché (consultable dans Post-it jetés)
- bouton To-Do sous Calendrier, classé par spectacle

## 3.33.0 — 2026-11-15
- Post-it : retoucher un Post-it ouvert le laisse collé (plus de bouton Garder), jeter avec une icône poubelle, l'auteur peut le modifier avec le crayon

## 3.32.1 — 2026-11-15
- Post-it du haut du fil beaucoup plus petits (ils s'agrandissent toujours au toucher)

## 3.32.0 — 2026-11-15
- Post-it : petits mots jaunes manuscrits collés en haut d'un fil (animations coller, décoller, froisser), à jeter par chacun
- menu ⋮ « Post-it jetés » pour les relire ou les jeter définitivement

## 3.31.1 — 2026-11-15
- Les options d'un message passent à la ligne au lieu de dépasser de l'écran sur téléphone

## 3.31.0 — 2026-11-15
- Galerie médias filtrable par date de tournée (#)
- modifier un message déjà écrit (texte et dates #) dans n'importe quel fil, avec la mention « modifié »

## 3.30.0 — 2026-11-15
- Menu ⋮ : Médias du fil (toutes les photos du fil, la plus récente d'abord)
- la date en cours du spectacle est proposée d'office en badge # dans chaque nouveau message

## 3.29.0 — 2026-11-15
- Nettoyage automatique : les documents d'une date de tournée sont effacés 10 jours après qu'elle est passée (fonction purge-documents + tâche nocturne)

## 3.28.0 — 2026-11-15
- Sélection multiple : rayer et déplacer en plus de supprimer, transférer et copier
- mise en forme des messages (*gras*, _italique_, ~barré~) avec boutons G, I, S

## 3.27.0 — 2026-11-15
- Option Copier pour un ou plusieurs messages
- sourdine rapide d'un seul fil depuis le menu ⋮

## 3.26.0 — 2026-11-15
- Fils de discussion : sélection de plusieurs messages par appui long (suppression par lot), balayage vers la gauche pour les options d'un message, nouvelle option Transférer

## 3.25.0 — 2026-11-14
- Documents et fiches techniques : PDF, images ou liens web
- une fiche technique réunit plusieurs fichiers (plan son, plan lumière…)

## 3.24.2 — 2026-11-14
- Le salon racine d'un spectacle (Général) affiche une maison ⌂ au lieu du G

## 3.24.1 — 2026-11-14
- Fenêtre des dates de tournée : le formulaire n'apparaît plus qu'avec le bouton + Ajouter une date (ou en modifiant une date)

## 3.24.0 — 2026-11-14
- Dates de tournée : choix des jours en touchant début puis fin (ou en glissant) dans un mini-calendrier
- représentations ajoutées d'un appui, avec plusieurs par jour possibles (ajouter ou retirer)

## 3.23.0 — 2026-11-14
- Barre des dates : seule la fiche technique reste affichée
- la flèche › devant « Dates » déplie la liste, chaque date a son badge documents

## 3.22.1 — 2026-11-14
- Déplacer un message : les photos sont réellement déplacées dans le stockage (migration 016)

## 3.22.0 — 2026-11-14
- Un administrateur peut déplacer un message vers un autre sous-salon ou spectacle (bouton Déplacer)

## 3.21.0 — 2026-11-14
- Chaque spectacle a un salon « Général » (racine, créé tout seul, caché de la liste) ouvert par le nom du spectacle
- la flèche déplie / replie les autres sous-salons

## 3.20.4 — 2026-11-14
- Téléphone : le bouton Retour ne quitte plus l'application par erreur (entrée d'historique reposée à chaque geste
- Retour agit même sur une entrée protégée)

## 3.20.3 — 2026-11-14
- Suppression d'une date : la confirmation précise que ses PDF sont aussi supprimés

## 3.20.2 — 2026-11-14
- Liste des dates de tournée en badges (nom + jours de début et de fin), boutons ✎ et × compacts

## 3.20.1 — 2026-11-14
- Dates rayées seulement le surlendemain du dernier jour (trajet retour)
- précision que les jours de transport ne se comptent pas à la création

## 3.20.0 — 2026-11-14
- Dates de tournée : classées par ordre chronologique, dates passées rayées en fin de liste, première représentation affichée
- champ du nom à taille normale

## 3.19.0 — 2026-11-14
- Gérer les dates de tournée passe dans le menu ⋮ de l'en-tête (le bouton « Gérer » de la barre des dates disparaît)

## 3.18.1 — 2026-11-14
- Création d'un spectacle : plus d'erreur de sécurité (même correctif que pour les sous-salons)

## 3.18.0 — 2026-11-14
- Notification push à toutes les personnes concernées quand un PDF est ajouté (document d'une date ou fiche technique)

## 3.17.1 — 2026-11-14
- Changer d'espace rouvre le dernier fil de cet espace (jamais un message privé)
- page vide s'il n'y en a aucun

## 3.17.0 — 2026-11-14
- Menu : espace et membres, notifications, installation et déconnexion regroupés dans une roue crantée à côté du profil

## 3.16.1 — 2026-11-14
- Menu : fond plus saturé (même teinte que l'espace) pour le distinguer du fil de discussion

## 3.16.0 — 2026-11-14
- Glisser vers la droite dans un fil ouvre le menu
- bandeau jaune de rappel quand les notifications sont inactives

## 3.15.0 — 2026-11-14
- Menu ⋮ : liste des personnes du sous-salon, un appui ouvre le message privé avec elles

## 3.14.1 — 2026-11-14
- Téléphone : « Retour » sur la liste demande confirmation avant de quitter l'appli (plus d'écran noir)

## 3.14.0 — 2026-11-14
- Téléphone : titre lisible, les boutons de l'en-tête sont rangés dans un menu ⋮

## 3.13.1 — 2026-11-14
- Téléphone : la liste des spectacles est plus grande, les messages privés passent dessous (la colonne défile)

## 3.13.0 — 2026-11-14
- Téléphone : glisser pour fermer le menu et pour changer de mois dans le calendrier
- listes plus compactes

## 3.12.4 — 2026-11-14
- Téléphone : la barre des dates n'a plus de textes qui se chevauchent

## 3.12.3 — 2026-11-14
- Téléphone : le bas de la liste (version, déconnexion) reste visible

## 3.12.2 — 2026-11-14
- Bouton Retour du téléphone depuis le calendrier : on revient au sous-salon au lieu d'un écran noir

## 3.12.1 — 2026-11-14
- PDF : de vrais liens (plus de page blanche sur téléphone)

## 3.12.0 — 2026-11-14
- Fiche technique PDF par spectacle, avec la date de chaque version, lisible par les personnes concernées

## 3.11.3 — 2026-11-14
- Messages privés : couleurs neutres, indépendantes de la production ouverte

## 3.11.2 — 2026-11-14
- Dates en cours : pastilles et cartes à la couleur de la production concernée

## 3.11.1 — 2026-11-14
- Dates en cours : de la veille du début au lendemain de la fin (trajets aller et retour)

## 3.11.0 — 2026-11-14
- Dates en cours : accès rapide (menu et en-tête de tous les écrans) aux documents et au spectacle
- documents aussi dans le détail du calendrier

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
