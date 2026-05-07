'use strict';
const test   = require('node:test');
const assert = require('node:assert');

let _fetchImpl = null;
global.fetch = (...args) => _fetchImpl(...args);

process.env.ZEROG_API_KEY      = 'test-key';
process.env.ZEROG_BASE_URL     = 'https://compute.test/v1';
process.env.ZEROG_ANALYSIS_TIMEOUT_MS = '5000';

const { getPoolShotCoaching, getPoolPerformanceInsight } = require('../src/services/poolComputeAnalysis');

function mockCompute(status, content, teeVerified = true) {
  _fetchImpl = async () => ({
    ok:     status >= 200 && status < 300,
    status,
    json:   async () => ({
      choices:     [{ message: { content } }],
      x_0g_trace:  { tee_verified: teeVerified, provider: '0xProviderAddr' },
    }),
  });
}

// ── getPoolShotCoaching ───────────────────────────────────────────────────────
test('getPoolShotCoaching returns 3 tips from 0G Compute', async () => {
  mockCompute(200, '{"tips":["Aim for clusters","Use follow shot","Control cue ball"]}');
  const result = await getPoolShotCoaching({ totalBallsPocketed: 50, totalGamesPlayedVsCPU: 10 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tips.length, 3);
  assert.strictEqual(result.provider, '0g_compute');
});

test('getPoolShotCoaching marks teeVerified correctly', async () => {
  mockCompute(200, '{"tips":["tip1","tip2","tip3"]}', true);
  const result = await getPoolShotCoaching({});
  assert.strictEqual(result.teeVerified, true);
  assert.strictEqual(result.providerAddress, '0xProviderAddr');
});

test('getPoolShotCoaching returns ok:false on empty tips', async () => {
  mockCompute(200, '{"tips":[]}');
  const result = await getPoolShotCoaching({});
  assert.strictEqual(result.ok, false);
});

test('getPoolShotCoaching returns ok:false on 0G Compute error', async () => {
  mockCompute(500, '');
  const result = await getPoolShotCoaching({});
  assert.strictEqual(result.ok, false);
});

test('getPoolShotCoaching returns ok:false when api key missing', async () => {
  const saved = process.env.ZEROG_API_KEY;
  delete process.env.ZEROG_API_KEY;
  const result = await getPoolShotCoaching({});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'missing_api_key');
  process.env.ZEROG_API_KEY = saved;
});

// ── getPoolPerformanceInsight ─────────────────────────────────────────────────
test('getPoolPerformanceInsight returns insight string', async () => {
  mockCompute(200, '{"insight":"You are 12 balls behind the leader — focus on break shots."}');
  const result = await getPoolPerformanceInsight({ totalBallsPocketed: 88 }, 5);
  assert.strictEqual(result.ok, true);
  assert.ok(typeof result.insight === 'string' && result.insight.length > 0);
});

test('getPoolPerformanceInsight returns ok:false on invalid JSON', async () => {
  mockCompute(200, 'not json at all');
  const result = await getPoolPerformanceInsight({}, 1);
  assert.strictEqual(result.ok, false);
});
