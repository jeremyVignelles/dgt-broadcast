# DGT Broadcast

MVP local hors-ligne pour projeter les états de 1 à 32 échiquiers DGT. Le domaine est indépendant du transport : le simulateur est actif par défaut, la découverte Bluetooth utilise `bluetoothctl` (BlueZ) et `RfcommTransport` isole l'adaptateur de liaison série (`rfcomm`, sans shell).

## Démarrage (Node.js 26)

```bash
npm install
npm run dev
```

Deux pages, servies par le même serveur (`http://127.0.0.1:8787`) :

| Page     | URL      | Rôle                                                                                                                             |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Affichage | `/`      | Grille épurée sans bouton, à projeter en plein écran (double-clic ou `F`). Elle occupe tout l'écran : 4 échiquiers = 2×2.        |
| Admin    | `/admin` | Scan Bluetooth, association échiquier ↔ table, affichage/masquage des tables, pilotage du simulateur.                           |

La page d'affichage montre pour chaque table : position, dernier coup surligné, joueurs, horloges, statut de connexion (échiquier grisé + message si déconnecté, contour orange si instable) et batterie (en rouge sous 20 %). Les détails (ELO, batterie normale) disparaissent quand les cellules deviennent petites.

### Découverte Bluetooth

Le bouton « Scanner les échiquiers » de `/admin` lance `bluetoothctl --timeout 8 scan on` puis `bluetoothctl devices` et ne retient les appareils nommés `DGT_BT_*`. Prérequis : paquet `bluez`, adaptateur Bluetooth allumé. L'association se fait ensuite en choisissant la table de chaque échiquier ; elle est persistée. Un échiquier déjà associé à une autre table est déplacé, jamais dupliqué.

Pas encore implémenté : la liaison série `rfcomm` + lecture des positions avec `dgtchess`, et donc l'enrôlement guidé par le roi blanc en E4. Les échiquiers réels sont découverts et associés, mais seul le simulateur alimente aujourd'hui l'affichage.

### API

Le serveur écoute uniquement localhost. `GET /api/health`, `/api/config`, `/api/tables` ; `POST /api/discovery/scan`, `/api/tables/associate`, `/api/tables/dissociate`, `/api/tables/enroll`, `/api/tables/visibility`, `/api/simulator/move`, `/api/simulator/status`, `/api/players/import` ; export `/api/export/1.pgn` ou `.json`. Le flux temps réel est `WS /api/stream`.

### Variables d'environnement

| Variable        | Défaut | Effet                                                              |
| --------------- | ------ | ------------------------------------------------------------------ |
| `PORT`          | `8787` | Port HTTP.                                                         |
| `TABLES`        | `4`    | Nombre de tables (1 à 32).                                         |
| `DGT_DATA_DIR`  | `data` | Dossier de `config.json` (écrit atomiquement).                     |
| `DGT_SIMULATOR` | actif  | `off` désactive les échiquiers simulés.                            |
| `DGT_BLUETOOTH` | actif  | `off` désactive le scan Bluetooth (utile sans adaptateur).         |

## Qualité

```bash
npm test
npm run format
npm run format:check
npm run lint
npm run check
```

Le formatage est assuré par Oxfmt. `npm run format` réécrit les fichiers applicatifs ; `npm run format:check` vérifie le formatage sans modifier les fichiers.

Dans VS Code, installez l'extension Oxc (`oxc.oxc-vscode`) : la configuration du workspace utilise Oxfmt comme formateur par défaut et active le formatage à la sauvegarde pour JavaScript, TypeScript, JSON, CSS et HTML.

Node.js 26 exécute directement les fichiers TypeScript en mode « strip-only » : pas de transpilation, donc pas d'`enum`, de `namespace` ni de propriétés de paramètres de constructeur (`constructor(private x)`).

## Architecture

`src/domain` contient les agrégats et invariants, `src/adapters` les ports/adaptateurs (stockage, simulateur, export, bluetooth, rfcomm), et `src/server.ts` le transport HTTP/WebSocket. `services/web` contient les deux pages (`display.*`, `admin.*`) et deux modules purs testés (`layout.js` : choix de la grille, `board.js` : FEN, dernier coup, horloges). Aucune dépendance Azure/cloud.
