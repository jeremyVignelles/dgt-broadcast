# Agents

Le projet est local et hors-ligne. Voir [README.md](../../README.md) pour l'architecture, les pages et les variables d'environnement.

## Règles

- Conserver l'écoute sur `127.0.0.1` uniquement et l'isolation du transport Bluetooth (pas de shell : `execFile`/`spawn` avec arguments séparés, noms d'appareils validés par `DGT_NAME`).
- Deux pages distinctes : `/` (affichage épuré, aucun bouton ni barre d'outils, grille plein écran) et `/admin` (configuration, découverte, simulateur). Ne pas ajouter de contrôles à la page d'affichage.
- Node.js 26 exécute le TypeScript en « strip-only » : pas d'`enum`, de `namespace` ni de propriétés de paramètres de constructeur. Le frontend est en JavaScript natif (modules ES, pas de bundler).
- Toute logique pure du frontend (grille, FEN, horloges) va dans `services/web/layout.js` ou `board.js` et doit être testée.
- Le code qui parle à `bluetoothctl` ou `rfcomm` prend un exécuteur injectable (`CommandRunner`) pour être testable sans matériel.
- VS Code utilise l'extension Oxc comme formateur par défaut et formate à la sauvegarde.

## Validation

`npm run check` (Oxfmt, TypeScript, Oxlint, Vitest) doit passer avant de conclure. Pour une vérification visuelle, lancer `npm run dev` et piloter les états via le simulateur de `/admin`.
