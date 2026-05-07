/**
 * Player intelligence — deterministic heuristics derived ONLY from existing
 * `stats` fields. No external calls, no LLM. Safe to compute on every request.
 *
 * Output shape (stable contract for UI + DA):
 *   {
 *     skillLevel: 'Beginner' | 'Intermediate' | 'Advanced' | 'Pro',
 *     playStyle:  'aggressive' | 'balanced' | 'defensive',
 *     reactionSpeed: 'slow' | 'average' | 'fast'
 *   }
 */

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function classifySkillLevel({ totalGamesPlayed, winRatio, totalBallsPocketed }) {
  if (totalGamesPlayed >= 50 && winRatio >= 0.65 && totalBallsPocketed >= 500) return 'Pro';
  if (totalGamesPlayed >= 20 && winRatio >= 0.5 && totalBallsPocketed >= 200) return 'Advanced';
  if (totalGamesPlayed >= 5 && (winRatio >= 0.35 || totalBallsPocketed >= 50)) return 'Intermediate';
  return 'Beginner';
}

function classifyPlayStyle({ ballsPerGame, winRatio }) {
  if (!Number.isFinite(ballsPerGame) || ballsPerGame <= 0) return 'balanced';
  if (ballsPerGame >= 6 && winRatio >= 0.45) return 'aggressive';
  if (ballsPerGame <= 3 && winRatio >= 0.45) return 'defensive';
  return 'balanced';
}

function classifyReactionSpeed({ totalGamesPlayed, totalTimePlayed }) {
  if (totalGamesPlayed <= 0 || totalTimePlayed <= 0) return 'average';
  const gamesPerMinute = totalGamesPlayed / Math.max(totalTimePlayed, 1);
  if (gamesPerMinute >= 0.25) return 'fast';
  if (gamesPerMinute <= 0.05) return 'slow';
  return 'average';
}

function calcConsistency({ totalGamesPlayed, winRatio }) {
  if (totalGamesPlayed < 3) return 50;
  // Scale win ratio to 0-100; boost for high game count (proven sample)
  const base = Math.round(winRatio * 100);
  const sampleBonus = Math.min(10, Math.floor(totalGamesPlayed / 10));
  return Math.min(100, Math.max(0, base + sampleBonus));
}

/**
 * @param {object} stats raw user `stats` sub-document (or plain object)
 * @returns {{ skillLevel, playStyle, reactionSpeed, consistency }}
 */
function derivePlayerIntelligence(stats = {}) {
  const wonCpu = toNum(stats.totalGamesWonVsCPU);
  const wonHuman = toNum(stats.totalGamesWonVsHuman);
  const playedCpu = toNum(stats.totalGamesPlayedVsCPU);
  const playedHuman = toNum(stats.totalGamesPlayedVsHuman);
  const totalGamesWon = wonCpu + wonHuman;
  const totalGamesPlayed = playedCpu + playedHuman;
  const totalBallsPocketed = toNum(stats.totalBallsPocketed);
  const totalTimePlayed = toNum(stats.totalTimePlayed);
  const winRatio = totalGamesPlayed > 0 ? totalGamesWon / totalGamesPlayed : 0;
  const ballsPerGame = totalGamesPlayed > 0 ? totalBallsPocketed / totalGamesPlayed : 0;

  return {
    skillLevel:    classifySkillLevel({ totalGamesPlayed, winRatio, totalBallsPocketed }),
    playStyle:     classifyPlayStyle({ ballsPerGame, winRatio }),
    reactionSpeed: classifyReactionSpeed({ totalGamesPlayed, totalTimePlayed }),
    consistency:   calcConsistency({ totalGamesPlayed, winRatio }),
  };
}

module.exports = { derivePlayerIntelligence };
