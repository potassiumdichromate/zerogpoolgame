/**
 * Leaderboard-style commentary for ZeroGPool via 0G Compute.
 * TEE-verified inference — no external fallback.
 */

const { randomUUID } = require('crypto');
const logger = require("../utils/logger");
const { getZerogConfig, poolPlayerForAi } = require("./zerogComputeService");

const POOL_MODEL =
  process.env.ZEROG_POOL_MODEL ||
  process.env.ZEROG_MODEL ||
  "zai-org/GLM-5-FP8";
const POOL_MAX_TOKENS = Math.min(
  Math.max(Number(process.env.ZEROG_POOL_MAX_TOKENS || 150), 16),
  512,
);
const POOL_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.ZEROG_POOL_TIMEOUT_MS || 8000), 1000),
  120_000,
);

const buildMessages = ({ currentPlayer, topPlayer }) => [
  {
    role: "system",
    content:
      "You are a friendly pool-game commentator for ZeroGPool on 0G. " +
      "Given the current player's stats and the #1 leaderboard player's stats, " +
      "write one short, playful line about the gap (balls pocketed / wins). " +
      "If the current player IS the top player (same wallet or same rank context), hype them up. " +
      "NEVER use real names — say 'you' vs 'the leader'. Under 35 words. " +
      "Motivational, never rude. No markdown, hashtags, JSON, or emojis.",
  },
  {
    role: "user",
    content: JSON.stringify({ currentPlayer, topPlayer }),
  },
];

const normalizeUsage = (usage) =>
  usage && typeof usage === "object"
    ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      }
    : null;

const isValidComment = (text) => {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 8 || t.length > 2000) return false;
  const lower = t.slice(0, 32).toLowerCase();
  if (lower.startsWith("{") || lower.startsWith("[")) return false;
  return true;
};

const generateCommentZerog = async ({ currentPlayer, topPlayer }) => {
  const zg = getZerogConfig();
  if (!zg.apiKey) {
    return { ok: false, phase: "no_api_key" };
  }

  const messages = buildMessages({ currentPlayer, topPlayer });
  const requestId = randomUUID();
  const started = Date.now();
  try {
    const response = await fetch(`${zg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${zg.apiKey}`,
      },
      body: JSON.stringify({
        model: POOL_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: POOL_MAX_TOKENS,
        stream: false,
        verify_tee: true,
        provider: { sort: process.env.ZEROG_COMPUTE_ROUTING || 'latency' },
      }),
      signal: AbortSignal.timeout(POOL_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      logger.warn("[0g-pool-ai] request failed", {
        status: response.status,
        latencyMs,
        model: POOL_MODEL,
      });
      return { ok: false, phase: "http_error", latencyMs };
    }

    const payload = await response.json().catch(() => null);
    const trace = payload?.x_0g_trace || {};
    const teeVerified = trace.tee_verified === true;
    const providerAddress = trace.provider || null;

    const raw =
      typeof payload?.choices?.[0]?.message?.content === "string"
        ? payload.choices[0].message.content
        : null;
    const comment = raw?.trim() || null;
    const usage = normalizeUsage(payload?.usage);

    if (!comment || !isValidComment(comment)) {
      logger.warn("[0g-pool-ai] invalid_or_empty_output", {
        latencyMs,
        model: POOL_MODEL,
      });
      return { ok: false, phase: "invalid_output", latencyMs };
    }

    logger.info("[0g-pool-ai] inference_success", {
      model: POOL_MODEL,
      latencyMs,
      teeVerified,
      providerAddress,
      requestId,
      token_usage: usage,
    });

    return {
      ok: true,
      comment,
      latencyMs,
      usage,
      model: POOL_MODEL,
      teeVerified,
      providerAddress,
      requestId,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    logger.warn("[0g-pool-ai] error", {
      error: err.message,
      latencyMs,
      model: POOL_MODEL,
    });
    return { ok: false, phase: "exception", latencyMs };
  }
};

/**
 * @param {{ currentUserDoc: object, topUserDoc: object }}
 * @returns {{ comment: string|null, inferenceSource: '0g_compute'|null, teeVerified: boolean }}
 */
const generatePoolLeaderboardComment = async ({
  currentUserDoc,
  topUserDoc,
}) => {
  const currentPlayer = poolPlayerForAi(currentUserDoc);
  const topPlayer = poolPlayerForAi(topUserDoc);

  const zgResult = await generateCommentZerog({ currentPlayer, topPlayer });

  if (zgResult.ok && zgResult.comment) {
    return {
      comment: zgResult.comment,
      inferenceSource: "0g_compute",
      teeVerified: zgResult.teeVerified ?? false,
      providerAddress: zgResult.providerAddress ?? null,
    };
  }

  logger.warn("[0g-pool-ai] 0G Compute failed", {
    reason: zgResult.phase || "0g_failed",
  });
  return { comment: null, inferenceSource: null, teeVerified: false };
};

module.exports = {
  generatePoolLeaderboardComment,
  poolPlayerForAi,
};
