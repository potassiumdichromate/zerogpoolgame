'use strict';
const test   = require('node:test');
const assert = require('node:assert');

// ── stub fetch before requiring the service ──────────────────────────────────
let _fetchImpl = null;
global.fetch = (...args) => _fetchImpl(...args);

const svc = require('../src/services/zerogDAService');

function mockFetch(status, body) {
  _fetchImpl = async () => ({
    ok:   status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

// ── submitEvent ───────────────────────────────────────────────────────────────
test('submitLoginEvent returns eventId on 200', async () => {
  process.env.ZEROG_DA_ENABLED = 'true';
  process.env.ZEROG_DA_GATEWAY_URL = 'https://da.test';
  mockFetch(200, { accepted: true });

  const result = await svc.submitLoginEvent('0xabc', { stats: {}, playerData: {} });
  assert.ok(result?.eventId, 'expected eventId in result');
});

test('submitLoginEvent returns null on gateway error', async () => {
  mockFetch(500, { error: 'internal' });
  const result = await svc.submitLoginEvent('0xabc', { stats: {} });
  assert.strictEqual(result, null);
});

test('submitLoginEvent returns null when DA disabled', async () => {
  process.env.ZEROG_DA_ENABLED = 'false';
  const result = await svc.submitLoginEvent('0xabc', { stats: {} });
  assert.strictEqual(result, null);
  process.env.ZEROG_DA_ENABLED = 'true';
});

// ── getEventStatus ────────────────────────────────────────────────────────────
test('getEventStatus returns found:true on 200', async () => {
  mockFetch(200, { eventId: 'ev-1', status: 'finalized', daReference: 'ref' });
  const status = await svc.getEventStatus('ev-1');
  assert.strictEqual(status.found, true);
  assert.strictEqual(status.status, 'finalized');
});

test('getEventStatus returns found:false on 404', async () => {
  mockFetch(404, {});
  const status = await svc.getEventStatus('missing');
  assert.strictEqual(status.found, false);
});

// ── retrievePlayerEvent ───────────────────────────────────────────────────────
test('retrievePlayerEvent decodes base64 data on 200', async () => {
  const payload = { hello: 'world' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  mockFetch(200, { retrieved: { dataBase64: b64 }, eventId: 'ev-1', daBlobInfo: {} });
  const r = await svc.retrievePlayerEvent('ev-1');
  assert.strictEqual(r.retrieved, true);
  assert.deepStrictEqual(r.data, payload);
});

test('retrievePlayerEvent returns not_finalized_yet on 409', async () => {
  mockFetch(409, { daStatus: 'processing' });
  const r = await svc.retrievePlayerEvent('ev-1');
  assert.strictEqual(r.retrieved, false);
  assert.strictEqual(r.reason, 'not_finalized_yet');
});

test('retrievePlayerEvent handles missing eventId', async () => {
  const r = await svc.retrievePlayerEvent(null);
  assert.strictEqual(r.retrieved, false);
  assert.strictEqual(r.reason, 'no_event_id');
});

// ── healthCheck ───────────────────────────────────────────────────────────────
test('healthCheck marks online:true when gateway responds ready', async () => {
  mockFetch(200, { ready: true });
  const h = await svc.healthCheck();
  assert.strictEqual(h.online, true);
});

test('healthCheck marks online:false on fetch error', async () => {
  _fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const h = await svc.healthCheck();
  assert.strictEqual(h.online, false);
});
