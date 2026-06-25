const UserData = require('../models/UserData');
const { classifyCrossGamePerformance } = require('../utils/crossGameDifficulty');

const CROSS_GAME_BACKENDS = Object.freeze({
  zeroDash: 'https://zerodashbackend.onrender.com',
  zeroGpool: 'https://zerogpoolgame.onrender.com/api',
  guessTheAi: 'https://guesstheai.xyz/backend/api',
  highwayHustle: 'https://highway-hustle-backend.onrender.com/api',
});

function normalizeWallet(value) {
  return String(value || '').trim().toLowerCase();
}

function localUrl(baseUrl, walletAddress) {
  return `${baseUrl.replace(/\/+$/, '')}/cross-game/local?walletAddress=${encodeURIComponent(walletAddress)}`;
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    }
    return body?.data || body;
  } finally {
    clearTimeout(timeout);
  }
}

async function getLocalCrossGame(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) {
    const err = new Error('walletAddress is required');
    err.statusCode = 400;
    throw err;
  }

  const user = await UserData.findOne({ walletAddress: wallet }).select('walletAddress stats.totalBallsPocketed').lean();
  const ballsPocketed = Number(user?.stats?.totalBallsPocketed || 0);
  return {
    gameKey: 'zerogool',
    game: 'Zerogool',
    walletAddress: wallet,
    available: Boolean(user),
    metrics: { ballsPocketed },
    crossGame: classifyCrossGamePerformance('zerogool', ballsPocketed),
  };
}

async function getCrossGameProgress(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) {
    const err = new Error('walletAddress is required');
    err.statusCode = 400;
    throw err;
  }

  const games = await Promise.all(
    Object.entries(CROSS_GAME_BACKENDS).map(async ([gameKey, baseUrl]) => {
      try {
        return await fetchJsonWithTimeout(localUrl(baseUrl, wallet));
      } catch (error) {
        return {
          gameKey,
          walletAddress: wallet,
          available: false,
          error: error?.message || 'Cross-game backend unavailable',
        };
      }
    }),
  );

  return { walletAddress: wallet, games };
}

module.exports = {
  CROSS_GAME_BACKENDS,
  getCrossGameProgress,
  getLocalCrossGame,
};
