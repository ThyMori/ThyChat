# ThyChat — consignes pour Claude

Messagerie professionnelle pour les équipes de spectacle vivant de Thierry. Application web installable (PWA) statique, publiée par GitHub Pages sur `thychat.thierry-morin.com`, avec Supabase (authentification, base Postgres, temps réel). Build par `scripts/build.mjs` (esbuild, **sans regroupement** : mêmes noms de fichiers `js/xxx.js`, donc la liste `SHELL` de `sw.js` ne change pas) ; GitHub Actions vérifie, teste, construit `dist/` puis publie. Le code est en cours de passage à TypeScript, fichier par fichier.

## Versions (à faire à chaque livraison)

Le numéro est affiché en petit en bas de l'application. Format `MAJEUR.FONCTION.ESTHÉTIQUE` :

| Chiffre | Quand l'incrémenter | Commande |
| --- | --- | --- |
| 1er (MAJEUR) | changement majeur : refonte, rupture, action requise des utilisateurs | `node scripts/bump-version.mjs major "…"` |
| 2e (FONCTION) | nouvelle fonction | `node scripts/bump-version.mjs feature "…"` |
| 3e (ESTHÉTIQUE) | correction esthétique ou petit correctif sans nouvelle fonction | `node scripts/bump-version.mjs fix "…"` |

- Lancer la commande **avant** le commit : elle met à jour `js/version.js`, `sw.js` et `CHANGELOG.md` ensemble. `node scripts/bump-version.mjs --check` vérifie qu'ils sont d'accord.
- Une livraison (un push) = une version. Si elle mêle plusieurs types de changements, le plus haut niveau l'emporte.
- La description va dans le journal : une phrase courte en français, séparer plusieurs points par `;`.
- Ne jamais modifier les numéros à la main.

## Conventions

- Textes de l'interface en français, tutoiement.
- Jamais d'`innerHTML` avec du texte venant des utilisateurs : utiliser `textContent`.
- Base de données : tout changement passe par un fichier numéroté dans `supabase/migrations/` **et** par `supabase/schema.sql` (qui doit rester rejouable), puis relancer `npm run types:db` pour régénérer `js/database.types.ts` (le workflow refuse de publier si ce fichier n'est pas à jour). Dire à Thierry de coller le SQL dans Supabase.
- Ne jamais mettre de clé secrète (`service_role` / `secret`) dans le dépôt ; seule la clé publique est dans `js/config.js`.
- Les couleurs de l'interface dérivent de `--h` (teinte de l'espace courant) : ne pas coder de couleur en dur dans la zone `#screen-app`.
- Service worker : ajouter tout nouveau fichier JS/CSS à la liste `SHELL` de `sw.js`.
- vocabulaire : « espace » (une production ou une compagnie), « spectacle » (ex-« salon » ; un spectacle en particulier), « sous-salon » (là où on discute : Tous, Technique…), « date » (une date de tournée, ex-« tag »), « message privé » ; rôles « administrateur » et « utilisateur ».
- Fonctions Supabase (`supabase/functions/*/index.ts`) : Thierry les colle dans le tableau de bord ; elles lisent leurs clés dans les secrets (`SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`…), jamais dans le dépôt. Seule la clé VAPID publique est dans `js/config.js`.
- Aide : toute nouvelle fonction est décrite dans la page d'aide (`#dialog-help` dans `index.html`, bouton « i »).
- Droits d'accès : toujours dans le SQL (RLS), jamais seulement dans l'interface.
- Noms de fichiers : éviter ceux que les bloqueurs de publicité filtrent (`chat.js`, `ads.js`, `track*.js`…) : le navigateur de Murena bloquait `js/chat.js` et l'application ne démarrait pas (renommé en `messagerie.js`).

## Build et tests

- `npm run check` avant chaque livraison : types puis tests (34 fichiers, sur `dist/`). Les tests sont dans `tests/` ; tout nouveau test y est ajouté (`*.test.mjs`).
- Un nouveau fichier de code peut être `js/xxx.ts` : le build le publie en `js/xxx.js`. Dans les `import`, toujours écrire `./xxx.js`.
- Ne jamais pousser si `npm run check` échoue : le workflow ne publierait rien.
