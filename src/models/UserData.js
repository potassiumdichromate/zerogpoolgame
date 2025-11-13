const mongoose = require('mongoose');

const userDataSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    index: true,
    lowercase: true,
    trim: true,
  },

  referral: {
  referralCode: { type: String, unique: true, sparse: true },
  referralCount: { type: Number, default: 0 },
  referredBy: { type: String, default: null }
},


  playerData: {
    playerNames0: { type: String, default: '' },
    playerNames1: { type: String, default: '0g-Panda' },
    chosenAvatar0: { type: Number, default: 0 },
    chosenAvatar1: { type: Number, default: 7 },
    selectedCue0: { type: Number, default: 1 },
    selectedCue1: { type: Number, default: 1 },
  },
  controlSettings: {
    controlMode0: { type: Number, default: 2 },
    controlMode1: { type: Number, default: 2 },
    handMode0: { type: Number, default: 0 },
    handMode1: { type: Number, default: 0 },
  },
  gameSettings: {
    soundEnabled: { type: Boolean, default: true },
    musicVolVal: { type: Number, default: 0.75 },
    musicVolMultiplierInGame: { type: Number, default: 0.5 },
    sensitivityValue: { type: Number, default: 1.0 },
    guideType: { type: Number, default: 2 },
    selectedTable: { type: Number, default: 0 },
    selectedPattern: { type: Number, default: 0 },
    roomEnabled: { type: Boolean, default: true },
    diamondsEnabled: { type: Boolean, default: false },
    redGuideEnabled: { type: Boolean, default: true },
    pinchZoomEnabled: { type: Boolean, default: true },
    dontGoToTopBallInHand: { type: Boolean, default: true },
    tapToAimEnabled: { type: Boolean, default: true },
    autoAimEnabled: { type: Boolean, default: true },
  },
  stats: {
    totalTimePlayed: { type: Number, default: 0 },
    totalGamesPlayedVsCPU: { type: Number, default: 0 },
    totalGamesWonVsCPU: { type: Number, default: 0 },
    totalGamesPlayedVsHuman: { type: Number, default: 0 },
    totalGamesWonVsHuman: { type: Number, default: 0 },
    totalBallsPocketed: { type: Number, default: 0, index: true }, // Indexed for leaderboard
    ttBestScore: { type: Number, default: 0 },
    matrixBestScore: { type: Number, default: 0 },
  },
  misc: {
    startupCounter: { type: Number, default: 0 },
    userSelControlDone: { type: Boolean, default: false },
    adsRemoved: { type: Boolean, default: true },
    useAvatarSet2: { type: Boolean, default: true },
  },
}, {
  timestamps: true,
  versionKey: false,
});

// Index for leaderboard queries
userDataSchema.index({ 'stats.totalBallsPocketed': -1 });

// Method to get public leaderboard data
userDataSchema.methods.getLeaderboardData = function() {
  return {
    walletAddress: this.walletAddress,
    playerName: this.playerData.playerNames0 || 'Anonymous',
    totalBallsPocketed: this.stats.totalBallsPocketed,
    totalGamesWon: this.stats.totalGamesWonVsCPU + this.stats.totalGamesWonVsHuman,
  };
};

module.exports = mongoose.model('UserData', userDataSchema);