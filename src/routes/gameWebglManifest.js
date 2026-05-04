/**
 * WebGL 0G build manifest: served from disk, with optional Cloudflare (CDN) base URL,
 * and fallback fetch of manifest.json from CDN when the local file is missing.
 */
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const router = express.Router();
const logger = require('../utils/logger');
const { probeManifestOnIndexer } = require('../utils/indexerStorageProbe');
const { validateWebglManifestEntries } = require('../utils/webglManifestValidate');

const DEFAULT_INDEXER = 'https://indexer-storage-turbo.0g.ai';

function defaultManifestPath() {
  return path.join(__dirname, '..', '..', 'public', 'zeroGpool-play', 'webgl-0g-manifest.json');
}

/**
 * @returns {Promise<{ body: any, source: 'disk'|'cloudflare'|'none', envCdn: string, manifestContentSha256: string | null }>}
 */
async function loadWebglManifestJson() {
  const envCdn = String(process.env.GAME_WEBGL_CDN_BASE_URL || '').trim().replace(/\/+$/, '');
  const manifestPath = String(process.env.GAME_WEBGL_0G_MANIFEST_PATH || '').trim() || defaultManifestPath();

  let body = null;
  let source = 'none';
  let manifestContentSha256 = null;

  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    body = JSON.parse(raw);
    manifestContentSha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    source = 'disk';
  } catch (e) {
    logger.warn(`[game-manifest] disk read failed (${manifestPath}): ${e.message}`);
  }

  if (!body?.entries?.length && envCdn) {
    const url = `${envCdn}/manifest.json`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const text = await r.text();
        body = JSON.parse(text);
        manifestContentSha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        source = 'cloudflare';
        logger.info(`[game-manifest] loaded from CDN fallback ${url}`);
      } else {
        logger.warn(`[game-manifest] CDN manifest HTTP ${r.status} ${url}`);
      }
    } catch (e) {
      logger.warn(`[game-manifest] CDN manifest fetch failed: ${e.message}`);
    }
  }

  return { body, source, envCdn, manifestContentSha256 };
}

function indexerProbeOptions(req) {
  const skipProbe =
    String(req.query.probe || '1') === '0' || process.env.GAME_WEBGL_INDEXER_PROBE === 'false';
  return {
    skipProbe,
    timeoutMs: Number(process.env.GAME_WEBGL_INDEXER_PROBE_TIMEOUT_MS || 4500),
  };
}

/** Lightweight JSON for uptime / readiness dashboards (no large `entries` array). */
router.get('/storage-indexer-health', async (req, res, next) => {
  try {
    const { body, source, envCdn, manifestContentSha256 } = await loadWebglManifestJson();
    if (!body?.entries?.length) {
      return res.status(200).json({
        ok: false,
        reason: 'MANIFEST_UNAVAILABLE',
        manifestSource: source,
        hint: 'Place webgl-0g-manifest.json or set GAME_WEBGL_CDN_BASE_URL',
      });
    }

    const entryCheck = validateWebglManifestEntries(body.entries);
    if (!entryCheck.valid) {
      logger.warn(`[game-manifest] health: invalid entries — ${entryCheck.errors.join('; ')}`);
      return res.status(200).json({
        ok: false,
        reason: 'MANIFEST_INVALID',
        errors: entryCheck.errors,
        manifestSource: source,
        manifestContentSha256,
      });
    }

    const indexerUrl = body.indexerUrl || DEFAULT_INDEXER;
    const { skipProbe, timeoutMs } = indexerProbeOptions(req);

    let storageIndexerProbe;
    if (!skipProbe) {
      try {
        storageIndexerProbe = await probeManifestOnIndexer(indexerUrl, body.entries, {
          skip: false,
          timeoutMs,
        });
      } catch (e) {
        logger.warn(`[0g-storage] health probe error: ${e.message}`);
        storageIndexerProbe = {
          enabled: true,
          indexer_url: indexerUrl,
          indexer_reachable: false,
          error: e.message || String(e),
          samples: [],
        };
      }
    }

    const healthy = skipProbe ? null : Boolean(storageIndexerProbe?.indexer_reachable);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: skipProbe ? true : healthy,
      skipped_probe: skipProbe,
      manifestSource: source,
      indexerUrl,
      entry_count: body.entries.length,
      cdn_configured: Boolean(envCdn || body.cdnBaseUrl),
      ...(manifestContentSha256 ? { manifestContentSha256 } : {}),
      ...(storageIndexerProbe ? { storageIndexerProbe } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/webgl-manifest', async (req, res, next) => {
  try {
    const { body, source, envCdn, manifestContentSha256 } = await loadWebglManifestJson();

    if (!body?.entries?.length) {
      return res.status(503).json({
        success: false,
        error: 'MANIFEST_UNAVAILABLE',
        hint: 'Place webgl-0g-manifest.json under public/zeroGpool-play/ or set GAME_WEBGL_CDN_BASE_URL',
      });
    }

    const entryCheck = validateWebglManifestEntries(body.entries);
    if (!entryCheck.valid) {
      logger.warn(`[game-manifest] invalid entries — ${entryCheck.errors.join('; ')}`);
      return res.status(503).json({
        success: false,
        error: 'MANIFEST_INVALID',
        errors: entryCheck.errors,
        ...(manifestContentSha256 ? { manifestContentSha256 } : {}),
      });
    }

    const fileCdn = body.cdnBaseUrl != null ? String(body.cdnBaseUrl).trim().replace(/\/+$/, '') : '';
    const cdnBaseUrl = envCdn || fileCdn || null;
    const indexerUrl = body.indexerUrl || DEFAULT_INDEXER;

    const { skipProbe, timeoutMs } = indexerProbeOptions(req);

    let storageIndexerProbe;
    if (!skipProbe) {
      try {
        storageIndexerProbe = await probeManifestOnIndexer(indexerUrl, body.entries, {
          skip: false,
          timeoutMs,
        });
        if (storageIndexerProbe?.enabled) {
          const cOk = storageIndexerProbe.cluster?.ok;
          logger.info(
            `[0g-storage] manifest probe indexer_reachable=${storageIndexerProbe.indexer_reachable} cluster=${cOk} samples=${storageIndexerProbe.samples?.length || 0}`,
          );
        }
      } catch (e) {
        logger.warn(`[0g-storage] manifest probe error: ${e.message}`);
        storageIndexerProbe = {
          enabled: true,
          probe_schema_version: 2,
          indexer_url: indexerUrl,
          indexer_reachable: false,
          error: e.message || String(e),
          samples: [],
        };
      }
    }

    const payload = {
      indexerUrl,
      entries: body.entries,
      manifestSource: source,
      ...(cdnBaseUrl ? { cdnBaseUrl } : {}),
      ...(manifestContentSha256 ? { manifestContentSha256 } : {}),
      ...(storageIndexerProbe ? { storageIndexerProbe } : {}),
    };

    logger.info(
      `[game-manifest] OK source=${source} entries=${payload.entries.length} cdn=${Boolean(cdnBaseUrl)}`,
    );
    res.set('Cache-Control', 'public, max-age=120');
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
