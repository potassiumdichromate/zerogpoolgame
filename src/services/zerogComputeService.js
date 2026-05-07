/**
 * 0G Compute — shared config + ZeroGPool player snapshots for inference.
 * Aligns env vars with Highway Hustle (`ZEROG_API_KEY`, `ZEROG_BASE_URL`, …).
 */

const DEFAULT_ZEROG_BASE_URL =
  "https://compute-network-1.integratenetwork.work/v1/proxy";
const DEFAULT_ZEROG_MODEL = "zai-org/GLM-5-FP8";

const toPlain = (value) => {
  if (!value) return {};
  return value.toObject ? value.toObject() : { ...value };
};

/** Minimal player doc for AI (current user from Mongo). */
const poolPlayerForAi = (doc) => {
  const plain = toPlain(doc);
  return {
    id: plain._id ? String(plain._id) : undefined,
    walletAddress: plain.walletAddress,
    playerName: plain.playerData?.playerNames0 || "Anonymous",
    stats: {
      totalBallsPocketed: Number(plain.stats?.totalBallsPocketed || 0),
      totalGamesWon:
        Number(plain.stats?.totalGamesWonVsCPU || 0) +
        Number(plain.stats?.totalGamesWonVsHuman || 0),
      totalTimePlayed: Number(plain.stats?.totalTimePlayed || 0),
      ttBestScore: Number(plain.stats?.ttBestScore || 0),
      matrixBestScore: Number(plain.stats?.matrixBestScore || 0),
    },
  };
};

const getZerogConfig = () => ({
  apiKey:
    process.env.ZEROG_API_KEY ||
    process.env.ZERO_G_API_KEY ||
    process.env.ZEROG_COMPUTE_API_KEY,
  baseUrl: (process.env.ZEROG_BASE_URL || DEFAULT_ZEROG_BASE_URL).replace(
    /\/+$/,
    "",
  ),
  model: process.env.ZEROG_MODEL || DEFAULT_ZEROG_MODEL,
  timeoutMs: Number(process.env.ZEROG_TIMEOUT_MS || 8000),
});

/**
 * Shared 0G Compute client — single place for fetch + trace extraction.
 * @param {Array} messages
 * @param {{ model?: string, temperature?: number, maxTokens?: number, timeoutMs?: number, routing?: string }} opts
 */
async function callCompute(messages, opts = {}) {
  const cfg = getZerogConfig();
  if (!cfg.apiKey) return { ok: false, reason: 'missing_api_key' };

  const model = opts.model || cfg.model;
  const temperature = opts.temperature ?? 0.3;
  const maxTokens = opts.maxTokens || 256;
  const timeoutMs = opts.timeoutMs || cfg.timeoutMs || 8000;
  const started = Date.now();

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        verify_tee: true,
        provider: { sort: opts.routing || process.env.ZEROG_COMPUTE_ROUTING || 'latency' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, latencyMs };

    const payload = await res.json().catch(() => null);
    const trace = payload?.x_0g_trace || {};
    const text = typeof payload?.choices?.[0]?.message?.content === 'string'
      ? payload.choices[0].message.content
      : '';

    return {
      ok: true,
      text,
      teeVerified: trace.tee_verified === true,
      providerAddress: trace.provider || null,
      usage: payload?.usage || null,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    return { ok: false, reason: err.message, latencyMs };
  }
}

module.exports = {
  getZerogConfig,
  callCompute,
  poolPlayerForAi,
};
