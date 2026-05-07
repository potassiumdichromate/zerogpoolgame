'use strict';
const test   = require('node:test');
const assert = require('node:assert');

let _fetchImpl = null;
global.fetch = (...args) => _fetchImpl(...args);

process.env.ZEROG_API_KEY  = 'test-key';
process.env.ZEROG_BASE_URL = 'https://compute.test/v1';

const { evaluateLeaderboardSubmission } = require('../src/services/leaderboardAntiCheatService');

const cleanStats  = { totalBallsPocketed: 100, totalGamesPlayedVsCPU: 10, totalGamesWonVsCPU: 5,
                      totalGamesPlayedVsHuman: 5, totalGamesWonVsHuman: 2,
                      totalTimePlayed: 3600, ttBestScore: 0, matrixBestScore: 0 };
const suspiciousStats = { ...cleanStats, totalBallsPocketed: 999_999 };

// ── heuristic path (no compute needed) ───────────────────────────────────────
test('evaluateLeaderboardSubmission accepts clean stats without compute', async () => {
  _fetchImpl = async () => { throw new Error('should not call compute'); };
  const result = await evaluateLeaderboardSubmission({
    walletAddress: '0xabc',
    previousStats: cleanStats,
    nextStats:     { ...cleanStats, totalBallsPocketed: 105 },
  });
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(result.source, 'heuristics');
});

test('evaluateLeaderboardSubmission rejects hard cap breach via heuristics', async () => {
  // hard_cap_exceeded triggers compute; mock compute to reject
  let computeCalled = false;
  _fetchImpl = async (_url, opts) => {
    computeCalled = true;
    const body = JSON.parse(opts.body);
    const msgs = body.messages;
    // Extract validationId from user message to echo it back
    const userContent = JSON.parse(msgs.find(m => m.role === 'user').content);
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          validationId: userContent.validationId,
          verdict: 'reject', confidence: 0.97, reason: 'hard_cap_exceeded',
        }) } }],
        x_0g_trace: { tee_verified: true, provider: '0xProv' },
      }),
    };
  };

  const result = await evaluateLeaderboardSubmission({
    walletAddress: '0xabc',
    previousStats: cleanStats,
    nextStats:     suspiciousStats,
  });
  assert.strictEqual(computeCalled, true);
  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.source, '0g_compute');
});

// ── TEE + validationId binding ────────────────────────────────────────────────
test('verifyWith0gCompute discards result on validationId mismatch', async () => {
  _fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        validationId: 'wrong-id',   // ← binding violation
        verdict: 'reject', confidence: 0.99, reason: 'cheat',
      }) } }],
      x_0g_trace: { tee_verified: true },
    }),
  });

  // Force compute path via suspicious delta
  const result = await evaluateLeaderboardSubmission({
    walletAddress: '0xabc',
    previousStats: cleanStats,
    nextStats:     suspiciousStats,
  });
  // Binding violation → verdict treated as allow (safe default)
  assert.strictEqual(result.accepted, true);
  assert.ok(result.source.includes('compute'));
});

// ── negative / overflow fields ────────────────────────────────────────────────
test('evaluateLeaderboardSubmission flags negative stat field', async () => {
  _fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const userContent = JSON.parse(body.messages.find(m => m.role === 'user').content);
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          validationId: userContent.validationId,
          verdict: 'allow', confidence: 0.5, reason: 'edge case',
        }) } }],
        x_0g_trace: { tee_verified: false },
      }),
    };
  };
  const result = await evaluateLeaderboardSubmission({
    walletAddress: '0xabc',
    previousStats: cleanStats,
    nextStats:     { ...cleanStats, totalGamesWonVsCPU: -1 },
  });
  assert.ok(result.details?.suspiciousReasons?.includes('negative_totalGamesWonVsCPU'));
});
