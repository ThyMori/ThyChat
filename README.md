# ThyChat

Messagerie professionnelle pour les équipes de spectacle vivant : espaces (une production, une compagnie), spectacles et sous-salons (par métier), messages privés, notifications push. Accès sur invitation uniquement.

**Stack** : PWA statique (HTML / CSS / JavaScript, sans étape de build) hébergée sur GitHub Pages, avec [Supabase](https://supabase.com) pour l'authentification, la base Postgres et le temps réel.

## Structure

```
index.html              coquille de l'application (écrans : chargement, connexion, mot de passe, app)
css/style.css           thème (variables de couleur dans :root)
js/config.js            URL + clé publique Supabase (à renseigner)
js/supabase.js          client Supabase
js/app.js               authentification et routage des écrans
js/chat.js              interface de messagerie (espaces, spectacles, sous-salons, calendrier, messages privés, non lus, membres, invitations)
js/notify.js            silences (8 h, 1 semaine, toujours) et pastille de l'icône
js/push.js              abonnement aux notifications push de l'appareil
js/profile.js           photo, nom et e-mail du profil
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
supabase/functions/     fonctions serveur : invite-member (invitations) et send-push (notifications)
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

Les invitations se font **depuis ThyChat** (voir « Rôles et accès » et « Fonctions Supabase » plus bas) : **Espace et membres > Inviter quelqu'un…**. Une liste déroulante propose les personnes déjà présentes dans tes espaces (à ajouter en un clic) ; « Nouvelle personne » invite par e-mail. La personne reçoit un e-mail, clique, choisit son mot de passe, et arrive directement dans les espaces et spectacles qui lui sont assignés.

## Rôles et accès

| Rôle | Peut |
| --- | --- |
| **Administrateur général** (toi) | Créer des espaces, inviter n'importe qui dans n'importe quel espace (en administrateur ou en utilisateur), administrer tous les espaces. Ne lit jamais les messages privés des autres. |
| **Administrateur d'espace** | Dans SON espace : inviter, changer les rôles, retirer des personnes, créer / modifier / supprimer des spectacles et des sous-salons et choisir qui y a accès, changer la couleur. Voit tout dans l'espace. |
| **Utilisateur** | Lire et écrire dans les sous-salons auxquels il a accès, écrire en privé aux autres personnes de ses espaces, régler ses notifications et son profil. |

La hiérarchie : un **espace** (une production ou une compagnie) contient des **spectacles** (anciennement « salons »), qui contiennent des **sous-salons** (« Tous », « Technique », « Musiciens »…). Deux niveaux d'accès : un spectacle est ouvert à tous les utilisateurs de l'espace ou réservé aux personnes assignées ; dans un spectacle, chaque sous-salon est ouvert à tous ceux qui ont accès au spectacle ou réservé à certains d'entre eux (cadenas). Chaque nouveau spectacle démarre avec un sous-salon « Tous ». Les **messages privés** ne relient que deux personnes d'un même espace.

**Devenir administrateur général** (une seule fois, dans le SQL Editor de Supabase, avec ton adresse) :

```sql
update public.profiles set is_super_admin = true
where id = (select id from auth.users where email = 'TON@EMAIL');
```

Le numéro de téléphone n'est pas encore géré pour les invitations : cela demande un fournisseur de SMS payant (Twilio…) branché dans Supabase. L'invitation se fait par e-mail.

## Fonctions Supabase (invitations et notifications)

Deux petites fonctions serveur sont nécessaires : `invite-member` (inviter par e-mail depuis l'application) et `send-push` (envoyer les notifications). Elles se déploient depuis le tableau de bord, sans rien installer.

**1. Les fonctions.** Supabase > **Edge Functions** > **Deploy a new function** > **Via Editor**. Pour chacune : donne le nom exact (`invite-member`, puis `send-push`), colle le contenu du fichier `supabase/functions/<nom>/index.ts`, **Deploy**. Dans les réglages de la fonction, désactive **Enforce JWT Verification** (les fonctions vérifient elles-mêmes qui les appelle).

**2. Les clés des notifications.** Une paire de clés VAPID identifie ton serveur auprès des téléphones. La clé **publique** est déjà dans `js/config.js` ; la clé **privée** va dans **Edge Functions > Secrets** (jamais dans le dépôt), avec :

| Secret | Valeur |
| --- | --- |
| `VAPID_PUBLIC_KEY` | la clé publique (identique à celle de `js/config.js`) |
| `VAPID_PRIVATE_KEY` | la clé privée |
| `VAPID_SUBJECT` | `mailto:` suivi de ton e-mail |
| `PUSH_WEBHOOK_SECRET` | un mot de passe long de ton choix |

Pour recommencer avec de nouvelles clés : `npx web-push generate-vapid-keys` (puis mets la clé publique dans `js/config.js` ; chacun devra réactiver les notifications).

**3. Le déclencheur.** Le plus simple : colle `supabase/migrations/004_push_trigger.sql` dans le SQL Editor (Run), puis exécute ceci une fois, en mettant ton adresse de projet et le même mot de passe que `PUSH_WEBHOOK_SECRET` :

```sql
insert into public.app_settings (key, value) values
  ('push_url', 'https://ajhtjciomlnvynccjfbd.supabase.co/functions/v1/send-push'),
  ('push_secret', 'LE_MOT_DE_PASSE_CHOISI')
on conflict (key) do update set value = excluded.value;
```

(Variante en clics, si ton tableau de bord la propose : **Integrations > Database Webhooks** ou **Database > Webhooks**, table `public.messages`, évènement Insert, fonction `send-push`, en-tête `x-webhook-secret`. Ne fais pas les deux : les notifications seraient doublées.)

**4. Essayer.** Sur un téléphone, ouvre ThyChat, **Notifications > Activer sur cet appareil**, ferme l'application, puis écris depuis un autre compte : la notification arrive. Sur iPhone / iPad (iOS 16.4 ou plus), l'application doit d'abord être installée sur l'écran d'accueil.

Sans ces fonctions, ThyChat marche quand même : les pastilles de non lus fonctionnent, l'ajout d'un compte déjà existant aussi ; seuls l'invitation de nouvelles personnes et les notifications app fermée en dépendent.

## Notifications

Chacun règle ses notifications dans **Notifications** (barre latérale) ou avec la cloche du sous-salon : activer ou non sur l'appareil, puis par **espace**, par **spectacle** et par **sous-salon** : activées, silence 8 heures, silence 1 semaine, désactivées. Un espace, un spectacle ou un sous-salon en silence est atténué, marqué 🔕, sa pastille de non lus est grise et il ne compte pas dans la pastille de l'icône de l'application. La pastille d'icône (nombre de messages non lus) apparaît sur l'application installée, quand le navigateur le permet.

## Mettre à jour la base

Quand une version ajoute un fichier dans `supabase/migrations/`, colle son contenu dans **SQL Editor** puis **Run** (sans risque si exécuté deux fois). Une installation neuve n'a besoin que de `supabase/schema.sql`.

| Fichier | Apporte |
| --- | --- |
| `002_workspace_theme.sql` | la couleur de chaque espace (sans elle, la couleur est déduite de l'espace et ne peut pas être choisie) |
| `004_push_trigger.sql` | le déclencheur qui envoie les notifications push à chaque nouveau message |
| `014_document_notifications.sql` | notification push à toutes les personnes concernées quand un PDF est ajouté (document d'une date ou fiche technique) ; nécessite la migration 004 ; **redéployer `send-push`** |
| `013_room_sheets.sql` | fiche technique PDF de chaque spectacle, avec la date de sa version (**indispensable à la version 3.12** ; après la 012) |
| `012_tag_documents.sql` | documents PDF attachés aux dates de tournée : table `tag_documents` et stockage privé `tag-documents` (**indispensable à la version 3.10**) |
| `011_search_accents.sql` | recherche dans les messages sans tenir compte des accents (sans elle, la recherche ignore seulement les majuscules) |
| `010_private_messages_global.sql` | messages privés communs à tous les espaces (une seule discussion par paire, doublons fusionnés), suppression d'une discussion privée (**indispensable à la version 3.7** ; redéployer `send-push`) |
| `009_message_images.sql` | photos dans les messages : stockage privé `message-images`, message sans texte, contrôle du dossier (**indispensable à la version 3.6** ; redéployer `send-push` pour la notification « 📷 Photo ») |
| `007_strike_space_photo.sql` | messages rayés par leur auteur, photo de chaque espace (**à exécuter avant d'utiliser la version 3.3**) |
| `008_date_ranges.sql` | plage de dates (début, fin) et dates de représentation ★ pour chaque date de tournée (**indispensable à la version 3.4**) |
| `006_tags_replies.sql` | dates de tournée (étiquettes rattachées au spectacle), réponses à un message (**indispensable à la version 3.1** ; pas de fonction à redéployer) |
| `005_rooms.sql` | salons (spectacles) et sous-salons : les salons existants deviennent des spectacles avec un sous-salon « Tous » (**indispensable à la version 3** ; redéployer aussi les fonctions `invite-member` et `send-push`) |
| `003_roles_salons_push.sql` | administrateur général, salons par assignation, messages privés, non lus, silences, notifications push, photos de profil (**indispensable à la version 2**) |

## Dates de tournée, réponses et citations

- **Dates de tournée** : les administrateurs de l'espace créent des dates (un nom, un début et une fin, et les dates de représentation ★) dans **Gérer**, au-dessus de la conversation. Elles sont attachées au **spectacle** et servent dans tous ses sous-salons.
- Dans un message, taper **#** propose les dates du spectacle ; le choix ajoute une pastille au message (plusieurs possibles, facultatif).
- Le **filtre** « Dates » au-dessus de la conversation n'affiche que les messages portant les dates choisies ; « Toutes » l'efface.
- **Répondre** et **Citer** : toucher un message affiche ces deux actions. Répondre affiche le message d'origine au-dessus de la réponse (toucher la citation y mène) ; Citer copie un extrait dans le message en cours.

## Aide intégrée

Le bouton **i** en haut de la barre latérale ouvre une page qui explique toutes les fonctions. Quand tu ajoutes une fonction, mets-la aussi à jour dans `index.html` (`#dialog-help`).

## Calendrier

- **Calendrier** (barre latérale) : vue mensuelle avec une frise colorée pour chaque date de tournée des spectacles auxquels tu as accès, et une ★ sur chaque jour de représentation. Un menu choisit entre tous les spectacles de l'espace, tous tes espaces, ou un seul spectacle. Toucher un jour liste ce qu'il contient ; toucher une frise ouvre le spectacle filtré sur cette date.
- **Frise hebdomadaire** : dans l'en-tête d'un spectacle qui a des dates, la veille et les 6 jours suivants. La toucher ouvre le calendrier.
- Les couleurs des frises sont celles de l'espace.

## Messages rayés et photo d'espace

- **Rayer** : l'auteur d'un message le touche puis choisit « Rayer » ; le texte reste lisible mais barré et atténué pour tout le monde. « Rétablir » l'annule. On ne raye que ses propres messages.
- **Photo d'espace** : dans **Espace et membres**, les administrateurs de l'espace (production ou compagnie) peuvent changer ou retirer la photo ; elle remplace les initiales dans la barre latérale et la liste des espaces.

## Photos dans les messages

- Le bouton **+** de la zone de saisie ajoute une photo (galerie, ou appareil photo sur téléphone) ; on peut aussi **coller** une image du presse-papier. Jusqu'à 4 photos par message, avec ou sans texte.
- Chaque image est réduite (1600 px au plus) et convertie en JPEG avant l'envoi, puis rangée dans le stockage privé `message-images/<sous-salon>/…`. Les règles RLS du stockage n'autorisent la lecture et l'envoi qu'aux personnes qui ont accès au sous-salon ; l'affichage passe par des liens temporaires de 24 h.
- Supprimer un message supprime aussi ses photos.

## Messages privés

- Les messages privés ont des couleurs **neutres** (gris-bleu), indépendantes de la production ouverte : la liste du menu et la conversation ne changent pas de couleur avec l'espace.
- Une discussion privée entre deux personnes est unique : elle apparaît dans **tous** les espaces que les deux personnes ont en commun, quel que soit l'espace ouvert. Le silence d'un espace ne la concerne pas.
- La poubelle 🗑 de l'en-tête supprime toute la discussion (messages et photos) **pour les deux personnes**. Les administrateurs ne voient jamais les messages privés.

## Documents des dates

- Chaque date de tournée peut recevoir des PDF (feuilles de route, billets, livrets d'accueil…), ajoutés par les **administrateurs de l'espace** depuis le bouton **Documents** de la barre des dates. Tous les membres ayant accès au spectacle peuvent les ouvrir.
- Les fichiers (15 Mo au plus, PDF uniquement) sont dans le stockage privé `tag-documents/<spectacle>/<date>/…` ; la lecture passe par des liens temporaires d'une heure. Les règles RLS (table et stockage) réservent l'ajout et la suppression aux administrateurs. Supprimer une date ou un spectacle supprime ses documents.

- **Dates en cours** : quand une date est en cours (de **la veille du début au lendemain de la fin**, pour les trajets aller et retour), un bouton « Dates en cours » (point lumineux) apparaît dans le menu et dans l'en-tête de tous les écrans, y compris le calendrier. Il liste ces dates de tous tes spectacles, avec leurs documents, la mention « Veille : départ demain » ou « Lendemain : retour » selon le jour, la mention « Représentation aujourd'hui » et un accès direct au spectacle. Les documents sont aussi listés dans le détail d'un jour du calendrier.
- Les documents sont visibles par toutes les personnes qui ont accès au spectacle (règle RLS des tables et du stockage).

- **Fiche technique** : chaque spectacle a une fiche technique PDF (bouton « Fiche technique » de la barre des dates). Les administrateurs ajoutent chaque nouvelle version en précisant sa **date** ; la plus récente est mise en avant et les précédentes restent consultables. Elle est lisible par toutes les personnes qui ont accès au spectacle, et aussi depuis « Dates en cours ». Fichiers dans le stockage privé `tag-documents/<spectacle>/fiche/…`.

## Recherche et liste des messages privés

- La loupe 🔍 ouvre la recherche dans les messages, sans tenir compte des accents ni des majuscules (migration 011 ; au moins 2 caractères) : dans tout ce que tu peux lire, ou dans le sous-salon ouvert ; 50 résultats les plus récents. Un résultat ouvre le sous-salon sur le message (même ancien), y compris dans un autre espace. Les règles RLS limitent déjà la lecture aux messages auxquels tu as accès.
- Les messages privés sont en lignes compactes, classés du fil le plus récent au plus ancien. Le bouton + filtre les personnes et les fils par nom : un fil existant est rouvert, sinon il est créé.

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
- [x] Photos dans les messages (bouton +, collage)
- [ ] Envoi de fichiers (plans de feu, fiches techniques en PDF)
- [x] Messages privés, spectacles par assignation, rôles, invitations, profil avec photo
- [x] Notifications push, silences par espace / spectacle / sous-salon, pastilles de non lus
- [ ] Invitation par numéro de téléphone (fournisseur de SMS)

## Dépannage

**L'écran reste sur « Chargement… »** : après 8 secondes, l'application affiche un bandeau avec le détail de l'erreur et un bouton **Réinitialiser et recharger**. Il supprime le service worker et les caches (la session de connexion est conservée). Si le bandeau n'apparaît pas, faire un rechargement forcé (Ctrl/Cmd + Maj + R) ou vider les données du site dans le navigateur.
