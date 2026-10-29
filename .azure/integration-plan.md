# Integration hand-off — DGT Broadcast

- Backend: repository root; `npm run dev`; `127.0.0.1:8787`; health `GET /api/health`.
- Frontend: `services/web`; static projection served by backend; dev command `npm run dev`; no mock client (simulator is backend transport).
- API routes: `GET /api/health`, `GET /api/config`, `GET /api/tables`, `POST /api/tables/discover`, `POST /api/tables/enroll`, `POST /api/tables/visibility`, `POST /api/meeting`, `POST /api/players/import`, `GET /api/export/{tableId}.{pgn|json}`, `POST /api/simulator/move`, `POST /api/simulator/status`, `WS /api/stream`.
- Database: local versioned JSON (`data/config.json`), `JsonStore` atomic temp + rename; no SQL database and no seed data.
- Shared types: `src/domain/types.ts`.
- Services: domain/controller (Essential), simulator (Essential MVP), HTTP/WebSocket projection (Essential), rfcomm adapter (Enhancement hardware), CSV/PGN/JSON adapters (Essential).
