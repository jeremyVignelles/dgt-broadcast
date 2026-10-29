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

#### Lecture du protocole

`dgtchess` a été remplacé par notre propre implémentation du protocole e-Board 8×8. Le transport série utilise `serialport` en 9600 bauds, 8N1, sans contrôle de flux ; USB et Bluetooth classique RFCOMM utilisent le même décodeur. Les plateaux de dames, BLE, le mode bus et les commandes de modification de la pendule ne sont pas pris en charge.

Une seule boucle de décodage traite les réponses aux commandes et les événements spontanés, y compris les trames fragmentées ou regroupées. Le pilote active `UPDATE_NICE`, demande la position complète, puis lit identité, pendule et batterie. Les changements de cases (`0x8e`, et non `0x86`, réservé au dump) sont regroupés après 350 ms de stabilité. Une lecture complète contrôle la liaison toutes les 10 secondes. Les lectures de position bénéficient de deux tentatives au maximum (3 secondes chacune, 6 secondes pour la position initiale). Les autres mesures sont demandées une fois par passage, puis retentées périodiquement plutôt qu'en rafale. Les écritures échouées ne sont pas répétées et l'historique n'est pas relancé automatiquement.

Une absence de réponse ne ferme pas la liaison et ne remplace jamais une mesure par zéro ou une position vide. Même si la position initiale tarde, le pilote reste ouvert et poursuit les demandes ; l'état est dégradé jusqu'au premier instantané. Une position de contrôle manquante dégrade l'état si aucun octet n'a été reçu depuis 30 secondes, ou si aucune position complète n'est encore connue. Les erreurs série et la fermeture du port restent des déconnexions explicites. Les délais de requête sont comptabilisés et enregistrés comme diagnostics, pas comme erreurs matérielles. Les réponses tardives restent traitées, y compris identité et batterie après expiration de la requête.

La pendule est principalement suivie par ses messages spontanés. Une demande explicite est envoyée au premier contrôle suivant 15 secondes sans mesure de pendule ; une relecture manuelle peut toujours la forcer. Le dernier horodatage de réception est exposé dans les diagnostics.

La batterie est retentée lors du premier contrôle suivant une minute depuis la dernière tentative, **même après une absence de réponse**. L'identification manquante est également retentée périodiquement. Les diagnostics distinguent les délais dépassés, les relances, la dernière tentative batterie et la dernière mesure reçue. Une ancienne valeur peut rester visible après un échec : consulter son horodatage et l'état « sans réponse » avant de la considérer à jour. Le bouton « Relire les données » force position, pendule, batterie et identité manquante sans reconnexion ; les demandes manuelles simultanées sont regroupées. Le démarrage d'une capture force également cette relecture.

La position physique reste affichable même si elle est illégale ou incomplète. Les coups légaux sont reconstruits avec `chess.js` depuis une position initiale reconnue, normale ou retournée. Une manipulation intermédiaire ne détruit pas le dernier contexte légal. `positionStatus: "unresolved"` indique que la FEN n'est qu'un support d'affichage : son trait à blanc et ses autres champs ne constituent pas un état de partie connu. L'enrôlement guidé par le roi blanc en E4 reste à faire.

Les pendules exposent les temps **gauche/droite**, le côté actif, le balancier, les drapeaux et la batterie faible. Pour l'installation physique utilisée, **gauche = blancs, droite = noirs** systématiquement, indépendamment du premier temps démarré ou de la position des pièces, sans réglage dans l'interface ou l'API. Sans pendule, les temps par couleur restent `null` (`--:--` à l'écran). Le décodage du côté actif tient compte de l'inversion des indicateurs de trait constatée sur les captures matérielles : `0x10` désigne le décompte gauche, `0x08` le décompte droit. L'exactitude de la lecture est à la seconde, avec le retard matériel du protocole ; aucun décompte extrapolé n'est présenté comme une mesure.

Les pièces spéciales `0x0d`, `0x0e`, `0x0f` sont conservées comme observations de résultat (nulle, victoire blanche, victoire noire), pas comme pièces d'échecs. Le résultat est affiché tant que ces pièces sont présentes ; des résultats contradictoires sont signalés dans l'administration. Les exports incluent le résultat.

Les rois ordinaires permettent aussi d'annoncer un résultat côté logiciel : **e4-d5 = gain blanc**, **d4-e5 = gain noir**, **e4-e5 ou d4-d5 = nulle**. La détection utilise la position stabilisée et son orientation, exige exactement un roi de chaque couleur et ne dépend pas de leur ordre sur les deux cases. Les autres pièces peuvent rester sur le plateau. Le résultat est conservé après retrait des pièces, retour à la position initiale et reconnexion ; le serveur le sauvegarde dans sa configuration. Une nouvelle déclaration contradictoire signale un résultat ambigu jusqu'à la remise à zéro explicite.

Le bouton « Nouvelle partie » (`POST /api/dgt/new-game`, `{ tableId }`) efface le résultat et réinitialise la reconstruction des coups. Retirer préalablement toute disposition ou pièce de résultat. Aucun redémarrage automatique de partie n'est déduit de la pendule ou de la position initiale pour le moment. Le firmware n'a pas besoin d'émettre un code spécial pour la convention des rois.

Le suivi du dernier coup ne gère pas encore un véritable historique d'annulation : après une reprise ou des coups illégaux, la position physique reste affichée mais le dernier coup et la reconstruction légale peuvent devenir non résolus. Une nouvelle position initiale réinitialise ce contexte, sans effacer le résultat.

Lors d'un téléchargement d'une mémoire circulaire pleine (7936 octets), le premier octet peut être le numéro de case d'une entrée dont le début a été écrasé. Ce cas est décodé en ignorant cet octet uniquement au début d'un tampon plein, avec un avertissement explicite et conservation de tous les octets dans le champ `raw` du JSON. Un transfert sans en-tête ou tronqué reste une erreur : il faut retenter le téléchargement, sans considérer les octets reçus comme un historique complet.

Les ports se ferment à la déconnexion ; il est possible de réessayer sans redémarrer Node.js. Dans `/admin`, on peut ajouter des tables jusqu'à 32, lire l'historique et ouvrir un port USB ou RFCOMM explicitement. Les identifiants USB dérivés du chemin sont provisoires : utiliser un chemin `/dev/serial/by-id/…` stable de préférence.

### Captures guidées, rejeu et stabilité

Dans `/admin`, démarrer une session **avant** les essais ou la connexion des plateaux. Télécharger d'abord l'historique interne de chaque plateau : il s'agit d'une mémoire circulaire de changements et de temps, **pas d'un PGN garanti**. Le téléchargement est décodé en tags, changements de cases (pièces spéciales comprises) et temps gauche/droite ; il ne reconstruit pas encore une partie historique.

Le parcours guidé propose position initiale, démarrage de pendule, coups, captures, roque, promotion, prise en passant, pièces spéciales et déconnexions. Marquer le début de l'étape, effectuer l'action, puis passer à la suivante ; les étapes indisponibles peuvent être sautées. Les marqueurs sont manuels, pas une validation automatique de l'action.

Pour valider l'historique matériel : démarrer une capture, connecter le plateau et cliquer « Historique » sur sa table. Le JSON téléchargé doit contenir `kind: "history"`, des entrées décodées et un dernier tag `eof`. Le parseur rejette une entrée tronquée ou une fin absente. Pour vérifier le contenu, installer une position initiale puis jouer lentement quelques coups connus avant le téléchargement ; comparer les changements de cases aux coups effectués, et les temps aux bascules de la pendule si elle est branchée. Les événements peuvent être compactés et les données anciennes écrasées : ne pas exiger une correspondance un-pour-un avec les événements temps réel. La capture brute doit contenir une commande `49` et une réponse `8f` complète, vérifiable avec le rejeu. Ce test n'établit pas à lui seul une reconstruction PGN.

Les fichiers JSONL sont stockés sous `DGT_DATA_DIR/recordings/`, exclus de Git pour le dossier `data` par défaut. Ils contiennent les octets RX/TX exacts avec les limites des lectures, l'identifiant de table, les horodatages relatifs monotones, les marqueurs, les erreurs et les diagnostics. Une erreur de stockage arrête la capture et apparaît dans l'administration. Arrêter la session avant de télécharger le fichier pour obtenir une capture complète.

```bash
# Décoder à nouveau les chunks RX, sans matériel, avec un décodeur par table.
npm run dgt:replay -- data/recordings/IDENTIFIANT.jsonl

# Test matériel borné, capture automatique, sans régler ni déclencher la pendule.
# Ne pas ouvrir les mêmes ports simultanément dans le serveur.
npm run dgt:probe -- --seconds 60 --history /dev/rfcomm0 /dev/rfcomm1
```

Le rejeu utilise le vrai parseur et le vrai décodeur ; il ne simule pas encore l'écoulement du temps ni les requêtes applicatives. `ProtocolSimulator` répond, lui, aux commandes au niveau octet et permet des injections de trames fragmentées, de pannes et de changements physiques pour les tests. Le simulateur métier existant reste destiné à l'interface.

Pour tester huit plateaux : les allumer, scanner, ajouter huit tables, associer et connecter les huit plateaux, puis laisser une capture ouverte. Le panneau de stabilité affiche les réponses aux contrôles de position, octets/messages, délais dépassés, erreurs et délais de réponse dernier/maximum. Une fenêtre courte ou huit connexions simulées ne valide pas huit connexions matérielles durables. Bluetooth classique limite généralement une piconet à sept périphériques actifs : **ne pas garantir huit plateaux sur un adaptateur** ; prévoir un deuxième adaptateur ou de l'USB si nécessaire. L'affectation explicite de plusieurs adaptateurs Bluetooth reste hors périmètre.

### API

Le serveur écoute uniquement localhost. `GET /api/health`, `/api/config`, `/api/tables` ; `POST /api/discovery/scan`, `/api/bluetooth/connect`, `/api/tables/count` (`count`, ajout sans suppression), `/api/tables/associate`, `/api/tables/dissociate`, `/api/tables/enroll`, `/api/tables/visibility`, `/api/simulator/move`, `/api/simulator/status`, `/api/players/import` ; export `/api/export/1.pgn` ou `.json`. Le flux temps réel est `WS /api/stream`.

API matérielle :

| Méthode | Route | Entrée / sortie |
|---|---|---|
| GET | `/api/dgt/diagnostics` | Diagnostics par liaison et état de l'enregistrement. |
| GET | `/api/dgt/serial/ports` | Ports série connus du système. |
| POST | `/api/dgt/serial/connect` | `{ tableId, path, physicalId? }`, identifiant `DGT_USB_…` par défaut. |
| POST | `/api/dgt/disconnect` | `{ tableId }`. |
| POST | `/api/dgt/history` | `{ tableId }` → `{ kind: "history", entries }`. |
| POST | `/api/dgt/refresh` | `{ tableId }` → diagnostics après relecture de position, pendule, batterie et identité manquante. |
| GET | `/api/dgt/recordings` | État, identifiants de sessions, étapes guidées. |
| POST | `/api/dgt/recordings/start` | Démarre une capture de toutes les liaisons et relit les états connectés. |
| POST | `/api/dgt/recordings/mark` | `{ label }`. |
| POST | `/api/dgt/recordings/stop` | Termine la capture et attend l'écriture. |
| GET | `/api/dgt/recordings/:id.jsonl` | Téléchargement local de la capture. |

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

`src/dgt/protocol.ts` contient le protocole pur (aucun import applicatif ou série), `client.ts` le multiplexage des messages sur l'interface `ByteTransport`, `serial.ts` l'unique dépendance à `serialport`, `simulator.ts` le simulateur protocolaire, et `recording.ts` les captures/rejeux. Cet ensemble ne dépend ni du domaine, ni de HTTP, ni de `chess.js`, pour permettre son extraction ultérieure.

`src/domain` contient les agrégats et invariants, `src/adapters/dgt.ts` traduit les observations matérielles en état de projection et reconstruit les coups. Les autres adaptateurs couvrent stockage, simulateur métier, export, Bluetooth et RFCOMM. `scripts/rfcomm-bind.sh` est le seul code exécuté en root, et `src/server.ts` porte HTTP/WebSocket. `services/web` contient les deux pages et les modules purs testés. Aucune dépendance Azure/cloud.
