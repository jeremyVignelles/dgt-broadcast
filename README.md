# DGT Broadcast

MVP local hors-ligne pour projeter les états de 1 à 32 échiquiers DGT. Le domaine est indépendant du transport : le simulateur est actif par défaut, la découverte Bluetooth utilise `bluetoothctl` (BlueZ) et les liaisons série sont créées avec `rfcomm bind`.

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

Les adresses Bluetooth trouvées sont mémorisées dans `config.json` pour pouvoir lier les échiquiers après un redémarrage de l'application.

### Liaison série (`rfcomm`) et droits

L'application tourne avec l'utilisateur normal, **jamais en root**. Seule la création des périphériques `/dev/rfcommN` (`rfcomm bind`) demande des droits administrateur :

1. « Connecter les échiquiers » (`/admin`) appaire d'abord les échiquiers associés qui ne le sont pas encore (voir ci-dessous), puis lit les liaisons existantes avec `rfcomm` (sans droits) et réutilise celles qui pointent déjà vers le bon échiquier.
2. Les liaisons manquantes sont créées en **un seul** appel `pkexec /bin/sh scripts/rfcomm-bind.sh N ADRESSE …`, donc un seul mot de passe (fenêtre polkit). Il faut une session graphique : en SSH, aucune fenêtre ne s'affiche. Le script revalide ses arguments et n'exécute que `rfcomm bind N ADRESSE 1`.
3. udev donne aux périphériques `root:dialout` en mode `660`. L'utilisateur doit appartenir au groupe `dialout` (`id -nG` pour vérifier, sinon `sudo usermod -aG dialout $USER` puis se reconnecter). L'application ne modifie jamais les permissions des fichiers.
4. Les liaisons restent en place jusqu'au redémarrage de la machine ; l'application ne les libère pas à l'arrêt (`sudo rfcomm release N` pour le faire à la main).

#### Appairage

Les échiquiers doivent être **appairés** avec le PC : sans appairage, l'ouverture de `/dev/rfcommN` échoue avec `ENOMEM` (connexion Bluetooth refusée), même avec les bons droits. L'appairage ne demande pas de droits root. Pour chaque échiquier associé et non appairé (`bluetoothctl info`), l'application fait un scan pour que BlueZ voie l'échiquier. Elle pilote ensuite une session `bluetoothctl` interactive : `agent KeyboardDisplay`, `default-agent`, `pair`, réponse `yes` à la confirmation du code (les échiquiers DGT n'ont pas d'écran, c'est un appairage « Just Works », sans PIN), puis `trust`. Un échec d'appairage est signalé dans `/admin` sans bloquer les autres échiquiers. Pour désappairer : `bluetoothctl remove ADRESSE`.

#### Lecture de position

Après l'appairage et la liaison, l'application ouvre `/dev/rfcommN` avec [`dgtchess`](https://github.com/fnogatz/dgtchess). Au démarrage, elle lit le dump complet, puis décode les trames brutes de mises à jour case par case de sa version Node.js. Les changements sont regroupés sur une courte période de stabilité ; les coups légaux sont déduits des positions successives avec `chess.js`, puis publiés en direct par WebSocket. Si aucune réponse ne vient du plateau sous 10 secondes, la table passe à « Déconnecté » et l'erreur est affichée dans `/admin`. `dgtchess` n'exposant pas de méthode de fermeture du port, redémarrez le serveur avant de retenter une connexion qui a expiré ou pour remplacer l'échiquier lié à une table. `dgtchess` est distribué sous licence AGPL-3.0-or-later ; vérifiez les obligations de cette licence avant de distribuer l'application.

La bibliothèque fournit les pièces et cases, mais pas les horloges ni la batterie : les horloges réelles restent à zéro et la batterie apparaît « ? » (aucune valeur fictive n'est affichée). Depuis la position initiale standard, les coups légaux fournissent le trait, les droits de roque et le dernier coup. Pour une position installée manuellement qui ne correspond pas au coup légal attendu, l'affichage conserve la position, mais initialise le trait à blanc et ne connaît pas les droits de roque. L'enrôlement guidé par le roi blanc en E4 reste à faire.

### API

Le serveur écoute uniquement localhost. `GET /api/health`, `/api/config`, `/api/tables` ; `POST /api/discovery/scan`, `/api/bluetooth/connect`, `/api/tables/associate`, `/api/tables/dissociate`, `/api/tables/enroll`, `/api/tables/visibility`, `/api/simulator/move`, `/api/simulator/status`, `/api/players/import` ; export `/api/export/1.pgn` ou `.json`. Le flux temps réel est `WS /api/stream`.

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

`src/domain` contient les agrégats et invariants, `src/adapters` les ports/adaptateurs (stockage, simulateur, export, Bluetooth, RFCOMM et lecture `dgtchess`), `scripts/rfcomm-bind.sh` le seul code exécuté en root, et `src/server.ts` le transport HTTP/WebSocket. `services/web` contient les deux pages (`display.*`, `admin.*`) et deux modules purs testés (`layout.js` : choix de la grille, `board.js` : FEN, dernier coup, horloges). Aucune dépendance Azure/cloud.
