# ZeroGPool Backend

ZeroGPool is a Web3 game powered by 0G, where gameplay, player progress, and performance are verifiable, stored, and enhanced through decentralized infrastructure.

This service is the Node/Express backend for ZeroGPool. It serves:

- gameplay/profile APIs on `/api`
- Unity WebGL static files on `/zeroGpool-play`
- 0G-backed game integration (manifest routes, DA event submission, optional compute usage)

For full 0G architecture and deep operational notes, see `0G_INTEGRATION.md`.

## Tech Stack

- Node.js + Express
- Mongoose data layer
- Joi request validation
- Winston logging
- Helmet, rate limiting, CORS
- Optional blockchain session recorder + 0G DA gateway integration

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Server defaults to `http://localhost:3000`.

## Environment

Use `.env.example` as source of truth. Common keys:

- `PORT`, `NODE_ENV`
- `MONGODB_URI`
- `JWT_SECRET`, `JWT_EXPIRES_IN`, `BROWSER_JWT_SECRET`
- `ALLOWED_ORIGINS`
- `ZEROG_DA_GATEWAY_URL`, `ZEROG_DA_API_KEY`, `ZEROG_DA_ENABLED`
- `BLOCKCHAIN_RPC_URL`, `OPERATOR_PRIVATE_KEY`, `CONTRACT_ADDRESS` (optional)
- `GAME_WEBGL_CDN_BASE_URL`, `GAME_WEBGL_0G_MANIFEST_PATH`
- `GAME_WEBGL_INDEXER_PROBE`, `GAME_WEBGL_INDEXER_PROBE_TIMEOUT_MS`

## Scripts

```bash
npm run dev      # nodemon
npm start        # production start
npm test         # node:test suite
```

## Main Routes

### Health

- `GET /` basic API + endpoint map
- `GET /api/health` backend health flags

### Auth & Player

- `POST /api/auth/login`
- `POST /api/v2/login`
- `GET /api/user?walletAddress=...`
- `POST /api/user`
- `GET /api/player/data`
- `POST /api/player/name`
- `GET /api/player/stats`

### Leaderboard

- `GET /api/leaderboard`
- `GET /api/leaderboard/ai-comment?wallet=...`

### 0G / WebGL Manifest

- `GET /api/game/webgl-manifest`
- `GET /api/game/storage-indexer-health`

### DA / Blockchain

- `GET /api/da/health`
- `GET /api/da/snapshot?wallet=...`
- `GET /api/da/status?wallet=...`
- `GET /api/da/retrieve?wallet=...`
- `GET /api/blockchain/session/:walletAddress`
- `GET /api/blockchain/login-count/:walletAddress`
- `GET /api/blockchain/stats`

### Static Unity Build

- `GET /zeroGpool-play/...` serves files from `public/zeroGpool-play`

## Notes For Production

- Keep secrets only in server env vars; never commit real `.env`.
- Keep `webgl-0g-manifest.json` and frontend manifest in sync after uploads.
- If CDN is used for bytes, set `GAME_WEBGL_CDN_BASE_URL` correctly (folder base, no `index.html` suffix).
- Keep CORS origins aligned with deployed frontend domains.

## Troubleshooting

- **Frontend login `ERR_CONNECTION_REFUSED`**: backend URL is wrong/down.
- **Game manifest lacks `cdnBaseUrl`**: set `GAME_WEBGL_CDN_BASE_URL` on backend.
- **WebGL stuck on network error**: verify CDN file paths/CORS and manifest roots.
- **Auth appears stale after logout**: clear client storage + refresh frontend session.

## Repository Hygiene

- Commit:
  - `src/`, `public/zeroGpool-play/`, `test/`, docs, lockfile
- Do not commit:
  - `.env`, `node_modules`, temp files