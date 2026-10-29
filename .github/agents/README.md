# Agents

Le projet est local et hors-ligne. Voir [README.md](../../README.md) pour l'architecture, les pages et les variables d'environnement.

## Règles

- Conserver l'écoute sur `127.0.0.1` uniquement et l'isolation du transport Bluetooth (pas de shell : `execFile`/`spawn` avec arguments séparés, noms d'appareils validés par `DGT_NAME`).
- Deux pages distinctes : `/` (affichage épuré, aucun bouton ni barre d'outils, grille plein écran) et `/admin` (configuration, découverte, simulateur). Ne pas ajouter de contrôles à la page d'affichage.
- Node.js 26 exécute le TypeScript en « strip-only » : pas d'`enum`, de `namespace` ni de propriétés de paramètres de constructeur. Le frontend est en JavaScript natif (modules ES, pas de bundler).
- Toute logique pure du frontend (grille, FEN, horloges) va dans `services/web/layout.js` ou `board.js` et doit être testée.
- Le code qui parle à `bluetoothctl` ou `rfcomm` prend un exécuteur injectable (`CommandRunner`) pour être testable sans matériel.
- La lecture des plateaux passe par `DgtTransport` et `dgtchess`; conserver une fabrique de plateau injectable et tester les mises à jour avec des positions simulées. Ne pas inventer de télémétrie de batterie ou d'horloge absente du protocole exposé.
- L'application ne tourne jamais en root et ne modifie jamais les permissions de fichiers (pas de `chmod`/`chown`). Seul `rfcomm bind` est élevé, via un unique `pkexec /bin/sh scripts/rfcomm-bind.sh` pour tous les échiquiers ; ce script doit rester minimal et revalider ses arguments. Les liaisons ne sont pas libérées à l'arrêt. L'appairage (`pairBoard`, session `bluetoothctl` interactive via `InteractiveSpawner` injectable) se fait sans root ; chaque étape ne doit se déclencher qu'une fois car `bluetoothctl` répète certains messages. Demander à l'utilisateur avant toute autre opération privilégiée.
- VS Code utilise l'extension Oxc comme formateur par défaut et formate à la sauvegarde.

## Validation

`npm run check` (Oxfmt, TypeScript, Oxlint, Vitest) doit passer avant de conclure. Pour une vérification visuelle, lancer `npm run dev` et piloter les états via le simulateur de `/admin`.
