/**
 * WebGL 0G manifest entry validation (Node).
 * Keep rules aligned with `zerogpool-frontend/src/lib/zeroGManifestSchema.ts`.
 */

const ROOT_HASH_HEX_RE = /^0x[a-fA-F0-9]{64}$/;

/**
 * @param {unknown} entries
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateWebglManifestEntries(entries) {
  const errors = [];
  if (!Array.isArray(entries)) {
    return { valid: false, errors: ['entries must be an array'] };
  }
  if (entries.length === 0) {
    return { valid: false, errors: ['entries must be non-empty'] };
  }
  const seen = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== 'object') {
      errors.push(`entries[${i}]: not an object`);
      continue;
    }
    const rp = /** @type {Record<string, unknown>} */ (e).relative_path;
    const rh = /** @type {Record<string, unknown>} */ (e).root_hash;
    const rpStr = typeof rp === 'string' ? rp.trim() : String(rp ?? '').trim();
    const rhStr = typeof rh === 'string' ? rh.trim() : String(rh ?? '').trim();
    if (!rpStr) {
      errors.push(`entries[${i}]: missing relative_path`);
    }
    if (!ROOT_HASH_HEX_RE.test(rhStr)) {
      errors.push(`entries[${i}]: invalid root_hash (expected 0x + 64 hex)`);
    }
    if (e.size_bytes !== undefined && e.size_bytes !== null) {
      const n = Number(e.size_bytes);
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`entries[${i}]: size_bytes must be a non-negative number`);
      }
    }
    if (ROOT_HASH_HEX_RE.test(rhStr)) {
      const key = rhStr.toLowerCase();
      if (seen.has(key)) {
        errors.push(`entries[${i}]: duplicate root_hash ${key.slice(0, 14)}…`);
      }
      seen.add(key);
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

module.exports = { validateWebglManifestEntries, ROOT_HASH_HEX_RE };
