const WARZONE_API_BASE_URL = 'https://api.warzonewarriors.xyz/warzone';
const CROSS_GAME_REWARD_SECRET = 'warzone-gun-cross-game-reward-v1';

const MEDIUM_OR_HIGHER = new Set(['medium', 'hard']);

function isMediumOrHigher(difficulty) {
  return MEDIUM_OR_HIGHER.has(String(difficulty || '').toLowerCase());
}

async function grantWarzoneGunReward({ walletAddress, sourceGame, crossGame }) {
  if (!walletAddress || !isMediumOrHigher(crossGame?.difficulty)) {
    return { eligible: false, granted: false };
  }

  const response = await fetch(`${WARZONE_API_BASE_URL}/internal/cross-game/gun-reward`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cross-game-reward-secret': CROSS_GAME_REWARD_SECRET,
    },
    body: JSON.stringify({
      walletAddress,
      sourceGame,
      difficulty: crossGame.difficulty,
      metric: crossGame.metric,
      value: crossGame.value,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error || body?.message || `Warzone reward grant failed (${response.status})`);
  }

  return { eligible: true, granted: true, ...(body.reward ? { reward: body.reward } : {}) };
}

module.exports = { grantWarzoneGunReward, isMediumOrHigher };
