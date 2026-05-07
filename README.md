# ZeroGPool — Backend

ZeroGPool is a verifiable on-chain pool billiards game where every match result, score delta, and skill progression is proven through the 0G stack — not just stored off-chain.

Player data is dispersed to **0G DA** (BLS-signed), analyzed by **0G Compute** (TEE-verified inference), and the Unity WebGL build is served straight from **0G Storage** with Merkle root verification on every load.

---

## 0G Stack

| Layer | Service | What it proves |
|-------|---------|----------------|
| **Storage** | 0G Storage + CDN | Unity WebGL build — Merkle root recomputed client-side on every load, mismatch falls back to indexer |
| **DA** | 0G Data Availability | Match results, score deltas, skill snapshots — BLS-signed blobs, queryable by anyone |
| **Compute** | 0G Compute (TEE) | Post-match analysis, coaching tips, difficulty tuning, leaderboard AI — verifiable inference |
| **Anti-cheat** | 0G Compute (TEE) | Leaderboard submission validation with TEE-bound validationId |

---

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose
- Joi validation, Winston logging
- Helmet, compression, rate limiting, CORS
- Privy-compatible JWT auth (browser + embedded wallet)
- Blockchain session recorder (EVM session contract, optional)

---

## Quick Start

```bash
npm install
cp .env.example .env   # fill in required keys
npm run dev
```

Server defaults to `http://localhost:3000`.

---

## Environment Variables

See `.env.example` for the full list. Minimum required:

| Key | Purpose |
|-----|---------|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Token signing secret |
| `BROWSER_JWT_SECRET` | Shared secret for browser JWTs |
| `ZEROG_API_KEY` | 0G Compute key (from pc.0g.ai) |
| `ZEROG_BASE_URL` | `https://router-api.0g.ai/v1` |

Optional (degrade gracefully if unset):

| Key | Purpose |
|-----|---------|
| `ZEROG_DA_GATEWAY_URL` | DA gateway for event blobs |
| `ZEROG_DA_ENABLED` | `true` to enable DA submission |
| `BLOCKCHAIN_RPC_URL` | EVM RPC for session contract |
| `OPERATOR_PRIVATE_KEY` | Operator wallet for session recording |
| `CONTRACT_ADDRESS` | Deployed session contract address |
| `GAME_WEBGL_CDN_BASE_URL` | CDN origin for WebGL static files |

---

## Scripts

```bash
npm run dev   # nodemon hot-reload
npm start     # production
npm test      # node:test suite (manifest validation)
```

---

## API Routes

### Core

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | Root — service info + endpoint map |
| `GET` | `/api/health` | Backend health flags (DA, Compute, blockchain) |

### Auth

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/auth/login` | Wallet login → JWT |
| `POST` | `/api/v2/login` | Autologin with Privy JWT |

### Player

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/player/data` | Profile + player name |
| `POST` | `/api/player/name` | Update player name |
| `GET` | `/api/player/stats` | Raw stats object |
| `GET` | `/api/player/coaching?wallet=` | 3 coaching tips — 0G Compute TEE |
| `GET` | `/api/player/insight?wallet=&rank=` | Leaderboard performance insight — 0G Compute TEE |
| `GET` | `/api/player/difficulty?wallet=` | Difficulty recommendation — 0G Compute TEE |
| `POST` | `/api/player/match` | Record match result → DA + Compute analysis |

### Leaderboard

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/leaderboard` | Top 100 with skill badges |
| `GET` | `/api/leaderboard/ai-comment?wallet=` | AI trash-talk comment — 0G Compute TEE |

### 0G Proofs

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/0g/proof/:wallet` | DA proof + anti-cheat verdict |
| `GET` | `/api/0g/player-memory/:wallet` | Intelligence profile + skill DA event history |

### DA

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/da/health` | DA gateway health |
| `GET` | `/api/da/snapshot?wallet=` | Latest DA event + history |
| `GET` | `/api/da/status?wallet=` | Live DA status from gateway |
| `GET` | `/api/da/retrieve?wallet=` | Retrieve DA blob |

### Blockchain (optional)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/blockchain/session/:wallet` | Latest on-chain session |
| `GET` | `/api/blockchain/login-count/:wallet` | On-chain login count |
| `GET` | `/api/blockchain/stats` | Total users + sessions on-chain |

### WebGL / Storage

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/game/webgl-manifest` | 0G Storage manifest with indexer probe |
| `GET` | `/api/game/storage-indexer-health` | Compact indexer health |
| `GET` | `/zeroGpool-play/...` | Unity WebGL static files |

---

## Production Notes

- Never commit `.env` — keep all secrets in server environment variables.
- Keep `webgl-0g-manifest.json` and frontend `public/manifest.json` in sync after every 0G upload (`yarn sync:webgl-0g-manifest`).
- Set `CORS` origins to match deployed frontend domains.
- If using CDN for Unity bytes, set `GAME_WEBGL_CDN_BASE_URL` to the folder root (no trailing `index.html`).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Frontend login `ERR_CONNECTION_REFUSED` | Backend URL wrong or server down |
| WebGL stuck loading | Check CDN CORS headers and manifest `root_hash` values |
| Game manifest 503 `MANIFEST_UNAVAILABLE` | Ship `webgl-0g-manifest.json` on the API host or set `GAME_WEBGL_CDN_BASE_URL` |
| Stale game in browser | Bump manifest hashes after upload; clear IndexedDB `zerogpool-webgl-0g` |
| Auth appears stale after logout | Clear client localStorage + reload |
| DA events not submitting | Check `ZEROG_DA_GATEWAY_URL` is reachable from server egress |
| Compute returning null tips | Check `ZEROG_API_KEY` is valid; fallback to Cloudflare Workers AI kicks in automatically |
