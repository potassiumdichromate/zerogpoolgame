/**
 * Lightweight 0G Storage indexer check (JSON-RPC) — no @0gfoundation SDK on the server.
 * Used to attach attestation metadata to GET /api/game/webgl-manifest for ops/reviewers.
 *
 * RPCs used (same as @0gfoundation/0g-ts-sdk Indexer):
 * - indexer_getFileLocations — per-root dataset locations
 * - indexer_getShardedNodes — cluster / trusted node snapshot (cached longer)
 */

const PROBE_SCHEMA_VERSION = 2;

const CACHE_OK_MS = 90_000;
const CACHE_ERR_MS = 20_000;
const CACHE_SHARDED_MS = 300_000;

/** @type {Map<string, { ts: number, val: object }>} */
const cache = new Map();

/** @type {Map<string, { ts: number, val: object }>} */
const shardedCache = new Map();

function cacheKey(indexerUrl, rootHash) {
  return `${String(indexerUrl).trim()}|${String(rootHash).trim()}`;
}

function getCached(indexerUrl, rootHash) {
  const k = cacheKey(indexerUrl, rootHash);
  const row = cache.get(k);
  if (!row) return null;
  const ttl = row.val.ok ? CACHE_OK_MS : CACHE_ERR_MS;
  if (Date.now() - row.ts > ttl) {
    cache.delete(k);
    return null;
  }
  return row.val;
}

function setCached(indexerUrl, rootHash, val) {
  cache.set(cacheKey(indexerUrl, rootHash), { ts: Date.now(), val });
}

function getShardedCached(indexerUrl) {
  const k = `${String(indexerUrl).trim()}|__sharded__`;
  const row = shardedCache.get(k);
  if (!row) return null;
  const ttl = row.val.ok ? CACHE_SHARDED_MS : 30_000;
  if (Date.now() - row.ts > ttl) {
    shardedCache.delete(k);
    return null;
  }
  return row.val;
}

function setShardedCached(indexerUrl, val) {
  const k = `${String(indexerUrl).trim()}|__sharded__`;
  shardedCache.set(k, { ts: Date.now(), val });
}

/**
 * @param {string} indexerUrl
 * @param {string} method
 * @param {unknown[]|undefined} params — omit for methods that take no args (matches TS SDK).
 * @param {number} timeoutMs
 */
async function jsonRpcPost(indexerUrl, method, params, timeoutMs) {
  const id = Math.floor((Date.now() + Math.random()) * 1e9) % 2147483647;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const rpcBody = { jsonrpc: '2.0', method, id };
    if (params !== undefined) rpcBody.params = params;
    const r = await fetch(String(indexerUrl).trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(rpcBody),
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`indexer_http_${r.status}`);
    }
    if (data.error) {
      throw new Error(data.error.message || `jsonrpc_${data.error.code || 'error'}`);
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} indexerUrl
 * @param {string} rootHash
 * @param {number} timeoutMs
 */
/**
 * Cluster-level indexer RPC (cheap; cached ~5m).
 * @param {string} indexerUrl
 * @param {number} timeoutMs
 */
async function probeShardedNodes(indexerUrl, timeoutMs) {
  const hit = getShardedCached(indexerUrl);
  if (hit) return { ...hit, cached: true };

  const t0 = Date.now();
  try {
    const result = await jsonRpcPost(indexerUrl, 'indexer_getShardedNodes', undefined, timeoutMs);
    let trustedCount = 0;
    let allCount = 0;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (Array.isArray(result.trusted)) trustedCount = result.trusted.length;
      if (Array.isArray(result.all)) allCount = result.all.length;
    }
    const val = {
      ok: true,
      trusted_node_count: trustedCount,
      all_node_count: allCount,
      latency_ms: Date.now() - t0,
      cached: false,
    };
    setShardedCached(indexerUrl, val);
    return val;
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : e.message || String(e);
    const val = {
      ok: false,
      error: msg,
      latency_ms: Date.now() - t0,
      cached: false,
    };
    setShardedCached(indexerUrl, val);
    return val;
  }
}

async function probeFileLocations(indexerUrl, rootHash, timeoutMs) {
  const hit = getCached(indexerUrl, rootHash);
  if (hit) return { ...hit, cached: true };

  const t0 = Date.now();
  try {
    const result = await jsonRpcPost(indexerUrl, 'indexer_getFileLocations', [rootHash], timeoutMs);
    const locationCount = Array.isArray(result) ? result.length : 0;
    const val = {
      ok: true,
      root_hash: rootHash,
      location_count: locationCount,
      latency_ms: Date.now() - t0,
      cached: false,
    };
    setCached(indexerUrl, rootHash, val);
    return val;
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : e.message || String(e);
    const val = {
      ok: false,
      root_hash: rootHash,
      error: msg,
      latency_ms: Date.now() - t0,
      cached: false,
    };
    setCached(indexerUrl, rootHash, val);
    return val;
  }
}

/**
 * Pick up to two representative roots (small loader + wasm) and probe in parallel.
 * @param {string} indexerUrl
 * @param {{ relative_path: string, root_hash: string, size_bytes?: number }[]} entries
 * @param {{ timeoutMs?: number, skip?: boolean }} opts
 */
async function probeManifestOnIndexer(indexerUrl, entries, opts = {}) {
  if (opts.skip || !indexerUrl || !Array.isArray(entries) || !entries.length) {
    return {
      enabled: false,
      reason: opts.skip ? 'query_skip' : 'no_entries',
      samples: [],
      indexer_reachable: null,
    };
  }

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 4500, 1500), 12_000);

  const loader = entries.find((e) => /Build\/Game\.loader\.js$/i.test(e.relative_path));
  const wasm = entries.find((e) => /Build\/Game\.wasm$/i.test(e.relative_path));
  const streaming = entries.find((e) => /^StreamingAssets\//i.test(e.relative_path));
  const roots = [];
  if (loader?.root_hash) roots.push({ path: loader.relative_path, root_hash: loader.root_hash });
  if (wasm?.root_hash && wasm.root_hash !== loader?.root_hash) {
    roots.push({ path: wasm.relative_path, root_hash: wasm.root_hash });
  }
  if (streaming?.root_hash && !roots.some((r) => r.root_hash === streaming.root_hash)) {
    roots.push({ path: streaming.relative_path, root_hash: streaming.root_hash });
  }
  if (!roots.length && entries[0]?.root_hash) {
    roots.push({ path: entries[0].relative_path, root_hash: entries[0].root_hash });
  }

  const clusterTimeout = Math.min(timeoutMs, 5000);
  const [cluster, ...sampleResults] = await Promise.all([
    probeShardedNodes(indexerUrl, clusterTimeout),
    ...roots.map(async ({ path, root_hash }) => {
      const p = await probeFileLocations(indexerUrl, root_hash, timeoutMs);
      return { relative_path: path, ...p };
    }),
  ]);

  const samples = sampleResults;
  const indexerReachable = Boolean(cluster?.ok) || samples.some((s) => s.ok);
  const allOk = samples.length > 0 && samples.every((s) => s.ok);

  return {
    enabled: true,
    probe_schema_version: PROBE_SCHEMA_VERSION,
    probed_at: new Date().toISOString(),
    indexer_url: indexerUrl,
    cluster,
    samples,
    indexer_reachable: indexerReachable,
    all_locations_known: allOk,
  };
}

module.exports = {
  probeManifestOnIndexer,
  PROBE_SCHEMA_VERSION,
};
