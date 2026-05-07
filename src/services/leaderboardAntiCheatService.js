'use strict';
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const { callCompute } = require('./zerogComputeService');

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

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: JSON.stringify({ validationId, ...payload }) },
  ];

  const result = await callCompute(messages, {
    model:     process.env.ZEROG_ANTICHEAT_MODEL,
    temperature: 0.0,
    maxTokens: 150,
    timeoutMs: Number(process.env.ZEROG_ANTICHEAT_TIMEOUT_MS || 8000),
  });

  if (!result.ok) {
    return { verdict: 'allow', source: '0g_compute_error', reason: result.reason };
  }

  const text = result.text;
  if (!text) return { verdict: 'allow', source: '0g_compute_error', reason: 'empty_output' };

  let parsed;
  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd   = text.lastIndexOf('}');
    parsed = jsonStart >= 0 && jsonEnd > jsonStart
      ? JSON.parse(text.slice(jsonStart, jsonEnd + 1))
      : JSON.parse(text);
  } catch {
    return { verdict: 'allow', source: '0g_compute_error', reason: 'parse_error' };
  }

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
    teeVerified: result.teeVerified,
    providerAddress: result.providerAddress,
    latencyMs: result.latencyMs,
  });

  return {
    verdict,
    source:          '0g_compute',
    confidence:      Number.isFinite(confidence) ? confidence : null,
    reason:          typeof parsed?.reason === 'string' ? parsed.reason : 'n/a',
    teeVerified:     result.teeVerified,
    providerAddress: result.providerAddress,
    latencyMs:       result.latencyMs,
  };
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
