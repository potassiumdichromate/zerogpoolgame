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

  /** Latest 0G DA submission — updated on every event for quick lookup */
  daSnapshot: {
    eventId:     { type: String, default: null },
    eventType:   { type: String, default: null },
    daStatus:    { type: String, default: null },
    daReference: { type: mongoose.Schema.Types.Mixed, default: null },
    daBlobInfo:  { type: mongoose.Schema.Types.Mixed, default: null },
    snapshotAt:  { type: Date, default: null },
    trigger:     { type: String, default: null },
  },

  /** Full 0G DA event history — all events submitted for this wallet (latest 50) */
  daEvents: [{
    eventId:     { type: String },
    eventType:   { type: String },   // session.login | stats.update | player.name
    daStatus:    { type: String, default: 'submitted' },
    daReference: { type: mongoose.Schema.Types.Mixed, default: null },
    daBlobInfo:  { type: mongoose.Schema.Types.Mixed, default: null },
    submittedAt: { type: Date },
    trigger:     { type: String },
  }],

  /** Latest 0G player-save mirror event (explicit profile/settings backup). */
  playerSaveSnapshot: {
    eventId: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    trigger: { type: String, default: null },
  },

  /** Latest anti-cheat result attached to stat update writes. */
  antiCheatSnapshot: {
    accepted:  { type: Boolean, default: true },
    source:    { type: String, default: null },
    reasons:   [{ type: String }],
    checkedAt: { type: Date, default: null },
  },


  /**
   * Player intelligence profile — derived from stats, updated on every match.
   * Stored so it can be served without re-computing and submitted to 0G DA
   * as a pool.skill.updated event showing skill progression over time.
   */
  playerMemory: {
    skillLevel:    { type: String, default: null },
    playStyle:     { type: String, default: null },
    reactionSpeed: { type: String, default: null },
    consistency:   { type: Number, default: null },
    updatedAt:     { type: Date,   default: null },
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