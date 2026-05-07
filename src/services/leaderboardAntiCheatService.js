'use strict';
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const { getZerogConfig } = require('./zerogComputeService');

const SUSPICIOUS_BALLS_DELTA = Math.max(
  Number(process.env.ZEROG_ANTICHEAT_SUSPICIOUS_DELTA || 500),
  100,
);
const HARD_CAP_BALLS = Math.max(
  Number(process.env.ZEROG_ANTICHEAT_HARD_CAP_BALLS || 2_000_000),
  10_000,
);
const MAX_STATS = 2_147_000_000;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function classifySuspicion(prevStats = {}, nextStats = {}) {
  const prevBalls = toNum(prevStats.totalBallsPocketed);
  const nextBalls = toNum(nextStats.totalBallsPocketed);
  const deltaBalls = nextBalls - prevBalls;
  const suspiciousReasons = [];
  if (nextBalls > HARD_CAP_BALLS) suspiciousReasons.push('hard_cap_exceeded');
  if (deltaBalls > SUSPICIOUS_BALLS_DELTA) suspiciousReasons.push('abrupt_balls_delta');

  const numericFields = [
    'totalTimePlayed',
    'totalGamesPlayedVsCPU',
    'totalGamesWonVsCPU',
    'totalGamesPlayedVsHuman',
    'totalGamesWonVsHuman',
    'totalBallsPocketed',
    'ttBestScore',
    'matrixBestScore',
  ];
  for (const key of numericFields) {
    const next = toNum(nextStats[key]);
    if (next < 0) suspiciousReasons.push(`negative_${key}`);
    if (next > MAX_STATS) suspiciousReasons.push(`overflow_${key}`);
  }

  return {
    suspicious: suspiciousReasons.length > 0,
    suspiciousReasons,
    deltaBalls,
  };
}

async function verifyWith0gCompute(payload) {
  const zg = getZerogConfig();
  if (!zg.apiKey) return { verdict: 'allow', source: 'rules_only', reason: 'missing_api_key' };

  // validationId binding — model must echo it back to prove it saw this exact payload.
  // Prevents result replay attacks (reusing a past CLEAN verdict for a different save).
  const validationId = randomUUID();

  const systemPrompt = [
    'You are an anti-cheat validator for a pool leaderboard on 0G blockchain.',
    `You MUST echo the validationId field exactly in your response: "${validationId}"`,
    'Return strict JSON only:',
    '{"validationId":"<echo validationId>","verdict":"allow"|"reject","confidence":0..1,"reason":"..."}',
    'Reject impossible or highly implausible stat jumps.',
  ].join('\n');

  const started = Date.now();
  try {
    const response = await fetch(`${zg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${zg.apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.ZEROG_ANTICHEAT_MODEL || zg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: JSON.stringify({ validationId, ...payload }) },
        ],
        temperature: 0.0,
        max_tokens: 150,
        stream: false,
        verify_tee: true,
        provider: { sort: process.env.ZEROG_COMPUTE_ROUTING || 'latency' },
      }),
      signal: AbortSignal.timeout(Number(process.env.ZEROG_ANTICHEAT_TIMEOUT_MS || 8000)),
    });

    if (!response.ok) {
      return { verdict: 'allow', source: '0g_compute_error', reason: `http_${response.status}` };
    }

    const body = await response.json().catch(() => null);
    const trace       = body?.x_0g_trace || {};
    const teeVerified = trace.tee_verified === true;
    const text        = body?.choices?.[0]?.message?.content;

    if (typeof text !== 'string') {
      return { verdict: 'allow', source: '0g_compute_error', reason: 'empty_output' };
    }

    const jsonStart = text.indexOf('{');
    const jsonEnd   = text.lastIndexOf('}');
    const parsed    =
      jsonStart >= 0 && jsonEnd > jsonStart
        ? JSON.parse(text.slice(jsonStart, jsonEnd + 1))
        : JSON.parse(text);

    // Binding check — reject if model didn't echo our validationId back
    if (parsed?.validationId !== validationId) {
      logger.warn('[0g-anti-cheat] validationId binding violation — response discarded', {
        expected: validationId,
        got: parsed?.validationId,
      });
      return { verdict: 'allow', source: '0g_compute_error', reason: 'binding_violation' };
    }

    const verdict    = parsed?.verdict === 'reject' ? 'reject' : 'allow';
    const confidence = Number(parsed?.confidence);

    logger.info('[0g-anti-cheat] tee_verified compute result', {
      verdict,
      teeVerified,
      providerAddress: trace.provider || null,
      latencyMs: Date.now() - started,
    });

    return {
      verdict,
      source:          '0g_compute',
      confidence:      Number.isFinite(confidence) ? confidence : null,
      reason:          typeof parsed?.reason === 'string' ? parsed.reason : 'n/a',
      teeVerified,
      providerAddress: trace.provider || null,
      latencyMs:       Date.now() - started,
    };
  } catch (err) {
    logger.warn(`[0g-anti-cheat] compute validation failed: ${err.message}`);
    return { verdict: 'allow', source: '0g_compute_error', reason: err.message };
  }
}

async function evaluateLeaderboardSubmission({ walletAddress, previousStats, nextStats }) {
  const heuristics = classifySuspicion(previousStats, nextStats);
  if (!heuristics.suspicious) {
    return { accepted: true, source: 'heuristics', details: heuristics };
  }
  const compute = await verifyWith0gCompute({
    walletAddress,
    previousStats,
    nextStats,
    heuristics,
  });
  const accepted = compute.verdict !== 'reject';
  return {
    accepted,
    source: compute.source,
    details: {
      ...heuristics,
      computeReason: compute.reason || null,
      confidence: compute.confidence ?? null,
      latencyMs: compute.latencyMs ?? null,
    },
  };
}

module.exports = { evaluateLeaderboardSubmission };
