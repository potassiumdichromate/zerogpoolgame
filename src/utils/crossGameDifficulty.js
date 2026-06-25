const DIFFICULTY = Object.freeze({
  NONE: 'none',
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard',
});

const CROSS_GAME_THRESHOLDS = Object.freeze({
  zerogool: Object.freeze({
    label: 'Zerogool',
    metric: 'ballsPocketed',
    thresholds: Object.freeze({ easy: 10, medium: 22, hard: 33 }),
  }),
});

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function classifyAtLeast(value, thresholds) {
  const score = toFiniteNumber(value);
  if (score === null) return DIFFICULTY.NONE;
  if (score >= thresholds.hard) return DIFFICULTY.HARD;
  if (score >= thresholds.medium) return DIFFICULTY.MEDIUM;
  if (score >= thresholds.easy) return DIFFICULTY.EASY;
  return DIFFICULTY.NONE;
}

function classifyCrossGamePerformance(gameKey, value) {
  const config = CROSS_GAME_THRESHOLDS[gameKey];
  if (!config) {
    throw new Error(`Unknown cross-game key: ${gameKey}`);
  }

  return {
    gameKey,
    game: config.label,
    metric: config.metric,
    value: toFiniteNumber(value) ?? 0,
    difficulty: classifyAtLeast(value, config.thresholds),
    thresholds: config.thresholds,
  };
}

module.exports = {
  CROSS_GAME_THRESHOLDS,
  DIFFICULTY,
  classifyCrossGamePerformance,
};
