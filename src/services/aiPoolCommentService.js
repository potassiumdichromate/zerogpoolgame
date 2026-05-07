/**
 * Leaderboard-style commentary for ZeroGPool via 0G Compute.
 * TEE-verified inference — no external fallback.
 */

const { randomUUID } = require('crypto');
const logger = require("../utils/logger");
const { callCompute, poolPlayerForAi } = require("./zerogComputeService");

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
  const messages = buildMessages({ currentPlayer, topPlayer });
  const requestId = randomUUID();

  const result = await callCompute(messages, {
    model:     POOL_MODEL,
    temperature: 0.7,
    maxTokens: POOL_MAX_TOKENS,
    timeoutMs: POOL_TIMEOUT_MS,
  });

  if (!result.ok) {
    logger.warn("[0g-pool-ai] compute failed", { reason: result.reason, model: POOL_MODEL });
    return { ok: false, phase: result.reason || "compute_error", latencyMs: result.latencyMs };
  }

  const comment = result.text?.trim() || null;
  const usage = normalizeUsage(result.usage);

  if (!comment || !isValidComment(comment)) {
    logger.warn("[0g-pool-ai] invalid_or_empty_output", { latencyMs: result.latencyMs, model: POOL_MODEL });
    return { ok: false, phase: "invalid_output", latencyMs: result.latencyMs };
  }

  logger.info("[0g-pool-ai] inference_success", {
    model: POOL_MODEL,
    latencyMs: result.latencyMs,
    teeVerified: result.teeVerified,
    providerAddress: result.providerAddress,
    requestId,
    token_usage: usage,
  });

  return {
    ok: true,
    comment,
    latencyMs:       result.latencyMs,
    usage,
    model:           POOL_MODEL,
    teeVerified:     result.teeVerified,
    providerAddress: result.providerAddress,
    requestId,
  };
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
