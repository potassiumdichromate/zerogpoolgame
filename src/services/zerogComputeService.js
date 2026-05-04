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

module.exports = {
  getZerogConfig,
  poolPlayerForAi,
};
