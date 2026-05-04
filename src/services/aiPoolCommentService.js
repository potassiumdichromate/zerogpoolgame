/**
 * Leaderboard-style commentary for ZeroGPool:
 * 0G Compute (OpenAI-compatible) first; Cloudflare Workers AI if 0G fails or returns junk.
 */

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

const getCfConfig = () => ({
  accountId: process.env.CF_ACCOUNT_ID,
  apiToken: process.env.CF_API_TOKEN,
  model: process.env.CF_LLM_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast",
  timeoutMs: Number(process.env.CF_TIMEOUT_MS || 6000),
});

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
      token_usage: usage,
    });

    return {
      ok: true,
      comment,
      latencyMs,
      usage,
      model: POOL_MODEL,
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

const generateCommentCloudflare = async ({ currentPlayer, topPlayer }) => {
  const cf = getCfConfig();
  if (!cf.accountId || !cf.apiToken) {
    logger.warn(
      "[0g-pool-ai] cloudflare_fallback skipped — missing CF_ACCOUNT_ID or CF_API_TOKEN",
    );
    return null;
  }

  const messages = buildMessages({ currentPlayer, topPlayer });
  const started = Date.now();
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/ai/v1/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cf.apiToken}`,
      },
      body: JSON.stringify({
        model: cf.model,
        messages,
        temperature: 0.7,
        max_tokens: 80,
        stream: false,
      }),
      signal: AbortSignal.timeout(cf.timeoutMs),
    });

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      logger.warn("[0g-pool-ai] cloudflare http_error", {
        status: response.status,
        latencyMs,
      });
      return null;
    }

    const payload = await response.json().catch(() => null);
    const raw =
      typeof payload?.choices?.[0]?.message?.content === "string"
        ? payload.choices[0].message.content
        : null;
    const comment = raw?.trim() || null;
    logger.info("[0g-pool-ai] cloudflare_fallback.success", {
      model: cf.model,
      latencyMs,
    });
    return comment || null;
  } catch (err) {
    logger.warn("[0g-pool-ai] cloudflare_fallback error", {
      error: err.message,
    });
    return null;
  }
};

/**
 * @param {{ currentUserDoc: object, topUserDoc: object }}
 * @returns {{ comment: string|null, inferenceSource: '0g_compute'|'cloudflare_fallback'|null }}
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
    };
  }

  logger.info("[0g-pool-ai] using cloudflare fallback", {
    reason: zgResult.phase || "0g_failed",
  });

  const cfComment = await generateCommentCloudflare({
    currentPlayer,
    topPlayer,
  });

  if (cfComment && isValidComment(cfComment)) {
    return {
      comment: cfComment.trim(),
      inferenceSource: "cloudflare_fallback",
    };
  }

  logger.warn("[0g-pool-ai] primary and fallback failed");
  return { comment: null, inferenceSource: null };
};

module.exports = {
  generatePoolLeaderboardComment,
  poolPlayerForAi,
};
