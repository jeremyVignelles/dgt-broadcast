# Plan de projet — DGT Broadcast

**Status**: Approved
**Created**: 2026-10-27
**Mode**: Local Linux, hors ligne

## 1. Project Overview

DGT Broadcast est une application locale Linux destinée à superviser et à projeter en lecture seule un nombre variable d'échiquiers électroniques DGT, de 1 à 32. Elle associe chaque échiquier à une table logique, suit les positions et les horloges, expose une projection responsive et permet l'administration locale d'une rencontre active.

L'application fonctionne sans dépendre d'Internet. La diffusion est abstraite dans le domaine afin de pouvoir utiliser un simulateur en MVP, puis Bluetooth via `rfcomm`, et ultérieurement USB ou un tunnel. Les exports de parties sont réalisés en PGN et JSON ; aucune base de parties n'est prévue.

## 2. Goals & Requirements

### Objectifs

- Découvrir les périphériques `DGT_BT_*` et gérer leur cycle de vie de façon robuste.
- Guider l'enrôlement séquentiel avec la position de référence du roi blanc en E4.
- Conserver l'association entre identifiant logique de table et échiquier physique, avec sélection manuelle comme solution de repli.
- Superviser 1 à 32 tables avec reconnexion, erreurs, batterie et états lisibles.
- Afficher une grille locale responsive de projection, en lecture seule, avec masquage par table.
- Fournir un simulateur par table et des tests unitaires, d'intégration et de flux simulés.
- Administrer une seule rencontre/événement actif, importer les joueurs par CSV (tri décroissant d'ELO prévu) ou manuellement, puis exporter en PGN/JSON.

### Contraintes et décisions

- Cible d'exécution : Linux local, localhost uniquement pour l'administration.
- Backend : Node.js et TypeScript, organisé en ports/adaptateurs.
- Transport : interface abstraite ; simulateur pour le MVP, Bluetooth `rfcomm` en premier adaptateur matériel, USB/tunnel futurs.
- Persistance : fichiers locaux versionnés par schéma pour la configuration et les associations ; pas de service cloud ni de base de données de parties.
- Authentification applicative : aucune pour l'usage local ; l'écoute réseau d'administration est limitée à localhost.
- Les données de projection sont éphémères en mémoire, tandis que configuration, association logique et exports sont conservés localement.

## 3. Architecture

### Style

Architecture hexagonale (ports et adaptateurs) en monoprocessus local :

1. **Domaine** — tables, parties, joueurs, rencontre, coups, horloges et états de santé, sans dépendance au matériel ni au framework HTTP.
2. **Cas d'utilisation** — découverte, enrôlement guidé, association, supervision, import, export, démarrage/arrêt de rencontre et masquage de tables.
3. **Ports** — transport DGT, découverte, horloge/temps, stockage local, projection et événements.
4. **Adaptateurs** — simulateur, Bluetooth `rfcomm`, futur USB/tunnel, fichiers JSON/CSV/PGN et serveur local HTTP/WebSocket.
5. **Interface** — API d'administration localhost et projection responsive consommant un flux d'état en lecture seule.

Les changements d'un échiquier sont normalisés en événements de domaine, réduits dans un état de rencontre, puis publiés vers la projection et les exports. Une erreur ou une déconnexion d'une table ne doit pas arrêter les autres tables.

### Cycle matériel

`discovered → enrolling → associated → connected → degraded/disconnected → reconnecting`, avec nettoyage explicite à l'arrêt. Chaque adaptateur porte un identifiant physique stable et ne décide pas de la table logique.

## 4. Services

| Service | Type | Responsabilité | Technologie prévue |
|---|---|---|---|
| Contrôleur DGT | Backend | Découverte `DGT_BT_*`, connexions, coups, position, horloge, batterie et reconnexion | Node.js/TypeScript, ports/adaptateurs |
| Simulateur | Backend | Un transport simulé indépendant par table, latence, coups, batterie, erreurs et déconnexions | TypeScript, même port que le matériel |
| Administration locale | Backend | Enrôlement, tables, rencontre active, joueurs, import et export | API HTTP + WebSocket localhost |
| Projection | Frontend | Grille responsive en lecture seule, masquage, dernière action et états | React + TypeScript |

### API et événements principaux

- `GET /api/health` : état local de l'application.
- `GET/PUT /api/config` : configuration locale et associations (administration localhost).
- `GET/POST /api/tables` : liste, découverte, enrôlement et sélection manuelle.
- `GET/POST /api/meeting` : rencontre active unique, joueurs et paramètres.
- `POST /api/players/import` : import CSV et tri descendant d'ELO prévu.
- `GET /api/export/{meetingId}.{pgn|json}` : export sans stockage de parties.
- `WS /api/stream` : état agrégé destiné à la projection et aux clients locaux.

La projection n'expose aucune commande d'écriture. Les contrats d'événements incluent `tableId`, position FEN, dernier coup, joueurs, horloge DGT, statut de connexion, batterie et horodatage.

## 5. Data & Storage

### Modèle métier

- **Meeting** : une rencontre active au maximum, paramètres et statut.
- **LogicalTable** : numéro 1–32, visibilité, nom/numéro affiché et association persistante.
- **PhysicalBoard** : identifiant découvert, transport, capacités et état de connexion.
- **Enrollment** : progression séquentielle, confirmation de la position de référence (roi blanc en E4), association et fallback manuel.
- **GameState** : FEN/position, dernier coup, joueurs, horloges, état et batterie.
- **Player** : nom, identifiant optionnel, ELO et couleur ; import CSV ou saisie manuelle.

### Persistance locale

- `config.json` (ou format équivalent versionné) : bornes, adaptateur choisi, tables logiques, identifiants physiques et préférences de projection.
- `meeting.json` : métadonnées et joueurs de la rencontre active, sans historique complet obligatoire.
- Répertoire d'exports : PGN et JSON nommés par rencontre/table/date.
- Écritures atomiques (fichier temporaire puis renommage), validation de schéma, sauvegarde avant migration et récupération d'une configuration corrompue.

Il n'y a ni PostgreSQL, ni Redis, ni stockage Azure, ni base de données de parties. Les positions nécessaires à la projection restent en mémoire ; PGN/JSON sont la sortie durable explicite.

## 6. Design System & UI

**Component Library**: Fluent UI v9

**Direction visuelle**: interface sombre, lisible à distance, contraste élevé, densité ajustable et états exprimés par texte, icône et couleur (jamais par la couleur seule).

**Écrans et composants**:

- **Projection** : grille CSS responsive de 1 à 32 cartes de table ; chaque carte contient échiquier, joueurs, horloges DGT, batterie, statut, dernier coup et position. Une table peut être masquée sans la désassocier.
- **Administration** : navigation vers découverte/enrôlement, tables, rencontre, joueurs, simulateur et exports ; actions locales distinctes de la projection.
- **Enrôlement** : assistant séquentiel indiquant la table logique attendue, l'échiquier découvert, la consigne « roi blanc en E4 », la confirmation et la sélection manuelle.
- **États** : chargement, vide, découverte, connecté, déconnecté, erreur, batterie faible et données obsolètes, avec horodatage et reprise explicite.

La mise en page privilégie le plein écran pour la projection, des contrôles tactiles suffisamment grands, une orientation d'échiquier stable et un rendu performant lorsque 32 cartes sont visibles. Les composants Fluent UI portent les interactions et les tokens ; les cases et pièces de l'échiquier sont des composants spécialisés au-dessus de cette bibliothèque.

## 7. Security & Configuration

- Écoute d'administration et WebSocket sur `127.0.0.1` uniquement ; aucun bind `0.0.0.0` par défaut.
- Validation stricte des chemins d'export, des CSV, des identifiants et des messages WebSocket.
- Aucune information sensible ou identifiant matériel inutile dans les logs ; rotation et niveau de journal configurables.
- Le transport matériel est isolé derrière un port afin de limiter les privilèges et l'impact d'une bibliothèque Bluetooth.
- Les actions d'administration sont séparées du flux de projection en lecture seule.
- Configuration et exports restent dans un répertoire local configurable, avec permissions utilisateur et avertissement avant écrasement.

## 8. Testing & Quality

- **Unitaires backend** : agrégats, transitions de connexion, bornes 1–32, enrôlement E4, association persistante, fallback manuel, tri ELO, validation et exports.
- **Unitaires frontend** : grille responsive, masquage, rendu de position/dernier coup, états de batterie/statut et reprise d'un flux obsolète.
- **Intégration** : API localhost, WebSocket, stockage atomique, import CSV, export PGN/JSON et adaptateur de transport.
- **Flux simulés** : plusieurs tables simultanées, coups, horloges, reconnexion, déconnexion, erreurs, latence, batterie faible, découverte `DGT_BT_*` et enrôlement séquentiel.
- **Contrats** : schémas des messages de projection et compatibilité simulateur/adaptateur Bluetooth.
- **Qualité** : TypeScript strict, lint, formatage, tests déterministes avec horloge injectée et seuil de couverture à définir avant implémentation.

## 9. Local Development & Operations

Le projet sera installable sur Linux avec une version LTS de Node.js, npm et les dépendances Bluetooth nécessaires à `rfcomm`. Le mode développeur démarre le backend, la projection et le simulateur sans matériel ; un profil matériel active l'adaptateur Bluetooth.

Commandes et scripts à prévoir :

- installation et vérification de l'environnement Linux ;
- démarrage local en mode simulateur ;
- démarrage de l'administration et de la projection sur localhost ;
- exécution des tests unitaires, d'intégration et des flux simulés ;
- découverte, enrôlement, export et arrêt propre.

Les logs indiquent la table logique, l'identifiant de transport et la transition d'état. Le démarrage doit rester utile sans Internet et sans échiquier connecté.

## 10. Implementation Sequence

1. Initialiser les packages TypeScript backend/frontend et les contrats partagés.
2. Implémenter le domaine, les ports, la configuration locale et les événements d'état.
3. Ajouter le transport simulé par table et les flux de tests.
4. Ajouter découverte, enrôlement E4, association persistante et sélection manuelle.
5. Implémenter l'adaptateur Bluetooth `rfcomm` avec reconnexion et isolation des erreurs.
6. Construire l'API localhost, le WebSocket et la projection React/Fluent UI.
7. Ajouter rencontre unique, joueurs, import CSV trié par ELO et saisie manuelle.
8. Ajouter export PGN/JSON et validation des scénarios complets.
9. Stabiliser les tests unitaires/intégration/simulés, la documentation Linux et les garde-fous localhost.

La mise en œuvre ne commence qu'après approbation explicite de ce plan ; ce document ne crée ni code applicatif ni infrastructure.
