/**
 * 0G Compute — pool-specific player analysis.
 * Provides shot coaching and performance insights powered by TEE-verified inference.
 */

const logger = require('../utils/logger');
const { getZerogConfig } = require('./zerogComputeService');

const ANALYSIS_TIMEOUT_MS = Number(process.env.ZEROG_ANALYSIS_TIMEOUT_MS || 20_000);
const ANALYSIS_MODEL =
  process.env.ZEROG_ANALYSIS_MODEL ||
  process.env.ZEROG_MODEL ||
  'zai-org/GLM-5-FP8';

async function callCompute(messages, maxTokens = 256) {
  const cfg = getZerogConfig();
  if (!cfg.apiKey) return { ok: false, reason: 'missing_api_key' };

  const started = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: false,
        verify_tee: true,
        provider: { sort: process.env.ZEROG_COMPUTE_ROUTING || 'latency' },
      }),
      signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - started;

    if (!res.ok) {
      logger.warn('[0g-pool-analysis] http_error', { status: res.status, latencyMs });
      return { ok: false, reason: `http_${res.status}`, latencyMs };
    }

    const payload = await res.json().catch(() => null);
    const trace = payload?.x_0g_trace || {};
    const text = payload?.choices?.[0]?.message?.content || '';

    return {
      ok: true,
      text,
      teeVerified: trace.tee_verified === true,
      providerAddress: trace.provider || null,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    logger.warn('[0g-pool-analysis] error', { error: err.message, latencyMs });
    return { ok: false, reason: err.message, latencyMs };
  }
}

function parseJson(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : text);
  } catch {
    return null;
  }
}

/**
 * Get 3 actionable shot coaching tips for a pool player.
 */
async function getPoolShotCoaching(playerStats) {
  const messages = [
    {
      role: 'system',
      content: 'Output only strict JSON. No markdown.',
    },
    {
      role: 'user',
      content: `You are a coach for ZeroGPool, an 8-ball pool game on 0G blockchain.

Analyze this player profile and give 3 short, actionable coaching tips:
${JSON.stringify({
  totalBallsPocketed: playerStats.totalBallsPocketed || 0,
  totalGamesPlayedVsCPU: playerStats.totalGamesPlayedVsCPU || 0,
  totalGamesWonVsCPU: playerStats.totalGamesWonVsCPU || 0,
  totalGamesPlayedVsHuman: playerStats.totalGamesPlayedVsHuman || 0,
  totalGamesWonVsHuman: playerStats.totalGamesWonVsHuman || 0,
  ttBestScore: playerStats.ttBestScore || 0,
  matrixBestScore: playerStats.matrixBestScore || 0,
}, null, 2)}

Return JSON: {"tips": ["tip1", "tip2", "tip3"]}
Tips must be pool-specific (shot selection, positioning, bank shots, break strategies).`,
    },
  ];

  const result = await callCompute(messages, 256);
  if (!result.ok) return { ok: false, reason: result.reason };

  const parsed = parseJson(result.text);
  const tips = Array.isArray(parsed?.tips) ? parsed.tips.slice(0, 3) : [];

  if (tips.length === 0) {
    logger.warn('[0g-pool-analysis] coaching tips empty or invalid');
    return { ok: false, reason: 'invalid_output' };
  }

  logger.info('[0g-pool-analysis] coaching_success', {
    teeVerified: result.teeVerified,
    latencyMs: result.latencyMs,
  });

  return {
    ok: true,
    tips,
    provider: '0g_compute',
    teeVerified: result.teeVerified,
    providerAddress: result.providerAddress,
  };
}

/**
 * Generate a performance insight comparing player to their leaderboard rank.
 */
async function getPoolPerformanceInsight(playerStats, leaderboardRank) {
  const totalGames =
    (playerStats.totalGamesPlayedVsCPU || 0) +
    (playerStats.totalGamesPlayedVsHuman || 0);
  const totalWins =
    (playerStats.totalGamesWonVsCPU || 0) +
    (playerStats.totalGamesWonVsHuman || 0);

  const messages = [
    {
      role: 'system',
      content: 'Output only strict JSON. No markdown.',
    },
    {
      role: 'user',
      content: `You are an AI analyst for ZeroGPool leaderboard on 0G.

Player stats:
- Balls pocketed: ${playerStats.totalBallsPocketed || 0}
- Leaderboard rank: ${leaderboardRank}
- Total games: ${totalGames}
- Total wins: ${totalWins}
- Time trial best: ${playerStats.ttBestScore || 0}
- Matrix best: ${playerStats.matrixBestScore || 0}

Give a ONE-SENTENCE insight about their standing and one concrete path to move up.
Return JSON: {"insight": "your sentence"}`,
    },
  ];

  const result = await callCompute(messages, 150);
  if (!result.ok) return { ok: false, reason: result.reason };

  const parsed = parseJson(result.text);
  const insight = typeof parsed?.insight === 'string' ? parsed.insight.trim() : null;

  if (!insight) {
    logger.warn('[0g-pool-analysis] insight empty or invalid');
    return { ok: false, reason: 'invalid_output' };
  }

  logger.info('[0g-pool-analysis] insight_success', {
    teeVerified: result.teeVerified,
    latencyMs: result.latencyMs,
  });

  return {
    ok: true,
    insight,
    provider: '0g_compute',
    teeVerified: result.teeVerified,
    providerAddress: result.providerAddress,
  };
}

module.exports = { getPoolShotCoaching, getPoolPerformanceInsight };
