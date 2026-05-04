'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateWebglManifestEntries, ROOT_HASH_HEX_RE } = require('../src/utils/webglManifestValidate');

const GOOD = `0x${'ab'.repeat(32)}`;

test('ROOT_HASH_HEX_RE accepts 66-char root', () => {
  assert.strictEqual(ROOT_HASH_HEX_RE.test(GOOD), true);
});

test('validateWebglManifestEntries accepts canonical entry', () => {
  const r = validateWebglManifestEntries([
    { relative_path: 'Build/Game.loader.js', root_hash: GOOD, size_bytes: 1 },
  ]);
  assert.strictEqual(r.valid, true);
});

test('validateWebglManifestEntries rejects short root_hash', () => {
  const r = validateWebglManifestEntries([{ relative_path: 'a', root_hash: '0x12' }]);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('root_hash')));
});

test('validateWebglManifestEntries rejects duplicate root_hash', () => {
  const r = validateWebglManifestEntries([
    { relative_path: 'a', root_hash: GOOD },
    { relative_path: 'b', root_hash: GOOD },
  ]);
  assert.strictEqual(r.valid, false);
});
