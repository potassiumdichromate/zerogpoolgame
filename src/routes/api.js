const express = require('express');
const router = express.Router();
const UserData = require('../models/UserData');
const authenticate = require('../middleware/auth');
const { decodeBrowserJwtOptional } = require('../middleware/browserJwt');
const { generateToken } = require('../utils/jwt');
const {
  validateWalletAddress,
  validateUserData,
  validateLogin,
  validatePlayerName,
  validateStatsFilter,
  validateLeaderboardAiCommentQuery,
} = require('../middleware/validation');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const blockchainService = require('../utils/blockchain');

const computeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ZEROG_COMPUTE_RATE_LIMIT || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many compute requests — try again in 15 minutes.' },
});

const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ZEROG_COMMENT_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many comment requests — try again shortly.' },
});
const zerogDAService = require('../services/zerogDAService');
const { generatePoolLeaderboardComment } = require('../services/aiPoolCommentService');
const { getPoolShotCoaching, getPoolPerformanceInsight, getMatchAnalysis, getDifficultyTuning } = require('../services/poolComputeAnalysis');
const { evaluateLeaderboardSubmission } = require('../services/leaderboardAntiCheatService');
const { derivePlayerIntelligence } = require('../services/playerIntelligenceService');

router.use('/game', require('./gameWebglManifest'));

// 0G DA: fire-and-forget — never blocks the API response.
const queueDA = (trigger, eventType, userId, walletAddress, submitFn) => {
  setImmediate(async () => {
    try {
      const result = await submitFn();
      if (!result?.eventId) return;
      const entry = {
        eventId:     result.eventId,
        eventType,
        daStatus:    'submitted',
        submittedAt: new Date(),
        trigger,
      };
      if (userId) {
        await UserData.findByIdAndUpdate(userId, {
          $set:  { daSnapshot: { ...entry, snapshotAt: new Date() } },
          $push: { daEvents: { $each: [entry], $slice: -50 } },
        });
      }
      logger.info(`[0g-da] queued | event=${eventType} trigger=${trigger} wallet=${walletAddress} eventId=${result.eventId}`);
    } catch (err) {
      logger.warn(`[0g-da] background error | trigger=${trigger}: ${err.message}`);
    }
  });
};

// REFERRAL CONTROLLER
const referralController = require("../controllers/referralController");

// ==================== PUBLIC ENDPOINTS ====================

// POST /api/auth/login - Login and get JWT token + Record session on blockchain
// POST /api/v2/login - V2 Login with JWT support (autologin)
router.post('/auth/login', validateLogin, async (req, res, next) => {
  try {
    const { walletAddress } = req.body;
    const normalizedAddress = walletAddress.toLowerCase();

    // Find or create user
    let userData = await UserData.findOne({ walletAddress: normalizedAddress });

    if (!userData) {
      // Create new user if doesn't exist
      userData = new UserData({ walletAddress: normalizedAddress });
      await userData.save();
      logger.info(`New user created during login: ${normalizedAddress}`);
    }

    // --------------------------------------
    // 🔥 REFERRAL AUTO-CLAIM INSERTED HERE
    // --------------------------------------
    const refCode = req.query.ref;

    if (refCode && !userData.referral?.referredBy) {
      const inviter = await UserData.findOne({
        "referral.referralCode": refCode,
      });

      if (inviter && inviter.walletAddress !== normalizedAddress) {
        try {
          // assign referral to new user
          userData.referral = userData.referral || {};
          userData.referral.referredBy = refCode;
          await userData.save();

          // increase inviter count
          inviter.referral = inviter.referral || {};
          inviter.referral.referralCount = (inviter.referral.referralCount || 0) + 1;
          await inviter.save();

          logger.info(`Referral claimed: ${normalizedAddress} referred by ${inviter.walletAddress}`);
        } catch (err) {
          logger.error("Referral auto-claim error:", err);
        }
      }
    }

    // Generate JWT token
    const token = generateToken(normalizedAddress, userData._id);

    logger.info(`User logged in: ${normalizedAddress}`);

    // Fire-and-forget — never block login on a chain write
    if (blockchainService.isReady()) {
      const statsSnap = userData.stats ? { ...userData.stats } : {};
      setImmediate(() => {
        blockchainService.recordSession(normalizedAddress, statsSnap)
          .catch(err => logger.warn(`[blockchain] recordSession wallet=${normalizedAddress}: ${err.message}`));
      });
    }
    const blockchainResult = blockchainService.isReady() ? { queued: true, blockchainEnabled: true } : null;

    const loginUserId = userData._id;

    queueDA('login.auth', 'session.login', loginUserId, normalizedAddress,
      () => zerogDAService.submitLoginEvent(normalizedAddress, userData),
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        walletAddress: normalizedAddress,
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
      },
      blockchain: blockchainResult, // NOW AT ROOT LEVEL WITH TX HASH!
    });
  } catch (error) {
    next(error);
  }
});

// V2 Login endpoint with JWT support for autologin
router.post('/v2/login', decodeBrowserJwtOptional, async (req, res, next) => {
  try {
    let walletAddress = req.body?.walletAddress;
    const jwt = req.body?.jwt;
    const source = req.body?.source;

    // Use wallet from JWT if available, otherwise use provided wallet address
    if (req.walletFromJwt) {
      walletAddress = req.walletFromJwt;
    }

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        message: 'walletAddress is required',
      });
    }

    const normalizedAddress = walletAddress.toLowerCase();

    // Find or create user
    let userData = await UserData.findOne({ walletAddress: normalizedAddress });

    if (!userData) {
      // Create new user if doesn't exist
      userData = new UserData({ walletAddress: normalizedAddress });
      await userData.save();
      logger.info(`New user created during v2 login: ${normalizedAddress}`);
    }

    // Generate JWT token
    const token = generateToken(normalizedAddress, userData._id);

    logger.info(`User logged in via v2: ${normalizedAddress} (source: ${source || 'unknown'})`);

    // Fire-and-forget — never block login on a chain write
    if (blockchainService.isReady()) {
      const statsSnap = userData.stats ? { ...userData.stats } : {};
      setImmediate(() => {
        blockchainService.recordSession(normalizedAddress, statsSnap)
          .catch(err => logger.warn(`[blockchain] recordSession wallet=${normalizedAddress}: ${err.message}`));
      });
    }
    const blockchainResult = blockchainService.isReady() ? { queued: true, blockchainEnabled: true } : null;

    const v2UserId = userData._id;

    queueDA('login.v2', 'session.login', v2UserId, normalizedAddress,
      () => zerogDAService.submitLoginEvent(normalizedAddress, userData),
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        walletAddress: normalizedAddress,
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
      },
      blockchain: blockchainResult,
    });
  } catch (error) {
    next(error);
  }
});


// ==================== REFERRAL ROUTES ADDED ====================

router.post("/referral/generate", referralController.generateReferralCode);

router.post("/referral/claim", referralController.claimReferral);

router.get("/referral/stats", authenticate, async (req, res) => {
  const user = await UserData.findOne({ walletAddress: req.walletAddress })
    .select("referral");

  if (!user) {
    return res.status(404).json({ success: false, error: "User not found" });
  }

  res.json({
    success: true,
    referralCode: user.referral?.referralCode || null,
    referralCount: user.referral?.referralCount || 0,
    referredBy: user.referral?.referredBy || null,
  });
});


// ==================== PUBLIC USER ENDPOINTS ====================

// GET /api/user - Get or create user data (kept for backward compatibility)
router.get('/user', 
  authenticate, validateWalletAddress, 
  async (req, res, next) => {
  try {
    const { walletAddress } = req.query;
    const normalizedAddress = walletAddress.toLowerCase();

    let userData = await UserData.findOne({ walletAddress: normalizedAddress });

    if (!userData) {
      userData = new UserData({ walletAddress: normalizedAddress });
      await userData.save();
      logger.info(`New user created: ${normalizedAddress}`);
    }

    res.json({
      success: true,
      data: userData,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/user - Save user data (kept for backward compatibility)
router.post('/user',
  authenticate, validateWalletAddress, validateUserData,
  async (req, res, next) => {
  try {
    const { walletAddress: bodyWallet, ...userData } = req.body;
    // Always use the JWT-authenticated wallet — prevents saving to a mismatched address
    const normalizedAddress = (req.walletAddress || bodyWallet).toLowerCase();
    const existingUser = await UserData.findOne({ walletAddress: normalizedAddress }).select('stats');
    const antiCheat = await evaluateLeaderboardSubmission({
      walletAddress: normalizedAddress,
      previousStats: existingUser?.stats || {},
      nextStats: userData?.stats || {},
    });
    if (!antiCheat.accepted) {
      logger.warn(`[0g-anti-cheat] rejected leaderboard submission wallet=${normalizedAddress}`, antiCheat.details);
      return res.status(422).json({
        success: false,
        error: 'SCORE_REJECTED_BY_ANTICHEAT',
        antiCheat: antiCheat.details,
      });
    }

    const updatedUser = await UserData.findOneAndUpdate(
      { walletAddress: normalizedAddress },
      {
        $set: {
          ...userData,
          walletAddress: normalizedAddress,
          antiCheatSnapshot: {
            accepted: true,
            source: antiCheat.source,
            reasons: antiCheat.details?.suspiciousReasons || [],
            checkedAt: new Date(),
          },
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    logger.info(`User data saved: ${normalizedAddress}`);

    // Fire-and-forget — never block save response on a chain write
    if (blockchainService.isReady() && updatedUser.stats) {
      const statsSnap = { ...updatedUser.stats };
      setImmediate(() => {
        blockchainService.recordSession(normalizedAddress, statsSnap)
          .catch(err => logger.warn(`[blockchain] recordSession wallet=${normalizedAddress}: ${err.message}`));
      });
    }
    const blockchainResult = blockchainService.isReady() ? { queued: true } : null;

    const daExtras = {};
    if (typeof req.body?.accuracy === 'number') daExtras.accuracy = req.body.accuracy;
    if (typeof req.body?.latency === 'number') daExtras.latency = req.body.latency;
    if (typeof req.body?.mode === 'string') daExtras.mode = req.body.mode;

    queueDA('user.save', 'stats.update', updatedUser._id, normalizedAddress,
      () => zerogDAService.submitStatsUpdate(normalizedAddress, updatedUser, daExtras));
    queueDA('user.save', 'player.save', updatedUser._id, normalizedAddress,
      async () => {
        const r = await zerogDAService.submitPlayerSave(normalizedAddress, updatedUser, 'user.save');
        if (r?.eventId) {
          await UserData.findByIdAndUpdate(updatedUser._id, {
            $set: {
              playerSaveSnapshot: {
                eventId: r.eventId,
                submittedAt: new Date(),
                trigger: 'user.save',
              },
            },
          });
        }
        return r;
      });

    res.json({
      success: true,
      data: updatedUser,
      blockchain: blockchainResult,
      antiCheat: {
        accepted: true,
        source: antiCheat.source,
        suspiciousReasons: antiCheat.details?.suspiciousReasons || [],
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/leaderboard
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const leaderboard = await UserData
      .find()
      .select('walletAddress playerData.playerNames0 stats antiCheatSnapshot playerSaveSnapshot')
      .sort({ 'stats.totalBallsPocketed': -1 })
      .limit(100)
      .lean();

    const formattedLeaderboard = leaderboard.map((user, index) => {
      const stats = user.stats || {};
      const intel = derivePlayerIntelligence(stats);
      return {
        rank: index + 1,
        walletAddress: user.walletAddress,
        playerName: user.playerData?.playerNames0 || 'Anonymous',
        totalBallsPocketed: stats.totalBallsPocketed || 0,
        totalGamesWon: (stats.totalGamesWonVsCPU || 0) + (stats.totalGamesWonVsHuman || 0),
        trust: {
          antiCheatSource: user.antiCheatSnapshot?.source || null,
          antiCheatCheckedAt: user.antiCheatSnapshot?.checkedAt || null,
          saveBackedBy0g: Boolean(user.playerSaveSnapshot?.eventId),
        },
        intelligence: { skillLevel: intel.skillLevel },
      };
    });

    res.json({
      success: true,
      data: formattedLeaderboard,
      count: formattedLeaderboard.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/leaderboard/ai-comment?wallet=0x…
router.get(
  '/leaderboard/ai-comment',
  commentLimiter,
  authenticate,
  validateLeaderboardAiCommentQuery,
  async (req, res, next) => {
    try {
      const normalizedAddress = req.query.wallet.toLowerCase().trim();

      const currentUser = await UserData.findOne({
        walletAddress: normalizedAddress,
      });
      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: 'Player not found for this wallet',
        });
      }

      const [topUser] = await UserData.find()
        .sort({ 'stats.totalBallsPocketed': -1 })
        .limit(1);

      if (!topUser) {
        return res.json({
          success: true,
          comment: null,
          _meta: { source: null, reason: 'no_players' },
        });
      }

      const { comment, inferenceSource, teeVerified, providerAddress } = await generatePoolLeaderboardComment({
        currentUserDoc: currentUser,
        topUserDoc: topUser,
      });

      res.json({
        success: true,
        comment,
        _meta: {
          source: inferenceSource ?? null,
          teeVerified: teeVerified ?? false,
          providerAddress: providerAddress ?? null,
        },
      });
    } catch (error) {
      logger.error('Leaderboard AI comment error:', error);
      res.json({
        success: true,
        comment: null,
        _meta: { source: null },
      });
    }
  },
);


// ==================== PROTECTED ENDPOINTS (Require JWT) ====================

// GET /api/player/data
router.get('/player/data', authenticate, async (req, res, next) => {
  try {
    const userData = await UserData.findOne({ 
      walletAddress: req.walletAddress 
    }).select('playerData stats');

    if (!userData) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      data: userData.playerData,
      intelligence: derivePlayerIntelligence(userData.stats || {}),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/player/name
router.post('/player/name', authenticate, validatePlayerName, async (req, res, next) => {
  try {
    const { playerNames0 } = req.body;

    const updatedUser = await UserData.findOneAndUpdate(
      { walletAddress: req.walletAddress },
      {
        $set: {
          'playerData.playerNames0': playerNames0,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    logger.info(`Player name updated for ${req.walletAddress}: ${playerNames0}`);

    queueDA('player.name', 'player.name', updatedUser._id, req.walletAddress,
      () => zerogDAService.submitNameUpdate(req.walletAddress, playerNames0));
    queueDA('player.name', 'player.save', updatedUser._id, req.walletAddress,
      async () => {
        const r = await zerogDAService.submitPlayerSave(req.walletAddress, updatedUser, 'player.name');
        if (r?.eventId) {
          await UserData.findByIdAndUpdate(updatedUser._id, {
            $set: {
              playerSaveSnapshot: {
                eventId: r.eventId,
                submittedAt: new Date(),
                trigger: 'player.name',
              },
            },
          });
        }
        return r;
      });

    res.json({
      success: true,
      message: 'Player name updated successfully',
      data: {
        playerNames0: updatedUser.playerData.playerNames0,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/player/stats
router.get('/player/stats', authenticate, validateStatsFilter, async (req, res, next) => {
  try {
    const { statType } = req.query;

    const userData = await UserData.findOne({ 
      walletAddress: req.walletAddress 
    }).select('stats');

    if (!userData) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    if (statType) {
      res.json({
        success: true,
        data: {
          [statType]: userData.stats[statType],
        },
      });
    } else {
      res.json({
        success: true,
        data: userData.stats,
      });
    }
  } catch (error) {
    next(error);
  }
});


// ==================== BLOCKCHAIN ENDPOINTS ====================

router.get('/blockchain/session/:walletAddress', authenticate, async (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    const normalizedAddress = walletAddress.toLowerCase();

    if (!blockchainService.isReady()) {
      return res.status(503).json({
        success: false,
        error: 'Blockchain service not available',
      });
    }

    const session = await blockchainService.getLatestSession(normalizedAddress);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'No blockchain sessions found for this wallet',
      });
    }

    res.json({
      success: true,
      data: session,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/blockchain/login-count/:walletAddress', authenticate, async (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    const normalizedAddress = walletAddress.toLowerCase();

    if (!blockchainService.isReady()) {
      return res.status(503).json({
        success: false,
        error: 'Blockchain service not available',
      });
    }

    const loginCount = await blockchainService.getUserLoginCount(normalizedAddress);

    res.json({
      success: true,
      data: {
        walletAddress: normalizedAddress,
        onChainLoginCount: loginCount || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/blockchain/stats', authenticate, async (req, res, next) => {
  try {
    if (!blockchainService.isReady()) {
      return res.status(503).json({
        success: false,
        error: 'Blockchain service not available',
      });
    }

    const stats = await blockchainService.getBlockchainStats();

    res.json({
      success: true,
      data: stats || { totalUsers: 0, totalSessions: 0 },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/blockchain/history/:walletAddress', authenticate, async (req, res, next) => {
  try {
    const normalizedAddress = req.params.walletAddress.toLowerCase();
    if (!blockchainService.isReady()) {
      return res.status(503).json({ success: false, error: 'Blockchain service not available' });
    }
    const history = await blockchainService.getSessionHistory(normalizedAddress);
    res.json({ success: true, data: history, count: history.length });
  } catch (error) {
    next(error);
  }
});

// ==================== 0G DA (login session blobs) ====================

router.get('/da/snapshot', authenticate, async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Missing 'wallet' query parameter",
      });
    }
    const normalizedAddress = wallet.toLowerCase().trim();
    const user = await UserData.findOne({ walletAddress: normalizedAddress }).select(
      'daSnapshot daEvents walletAddress'
    );
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const snap = user.daSnapshot;
    if (!snap?.eventId) {
      return res.json({
        success: true,
        snapshot: null,
        message: 'No DA event submitted yet for this wallet',
      });
    }

    res.json({
      success: true,
      snapshot: {
        eventId:          snap.eventId,
        eventType:        snap.eventType || null,
        daStatus:         snap.daStatus,
        daReference:      snap.daReference || null,
        daBlobInfo:       snap.daBlobInfo || null,
        snapshotAt:       snap.snapshotAt,
        trigger:          snap.trigger,
        gatewayStatusUrl: `${zerogDAService.getGatewayBaseUrl()}/v1/da/status/${snap.eventId}`,
      },
      history: (user.daEvents || []).slice().reverse().map((e) => ({
        eventId:     e.eventId,
        eventType:   e.eventType,
        daStatus:    e.daStatus,
        submittedAt: e.submittedAt,
        trigger:     e.trigger,
        statusUrl:   `${zerogDAService.getGatewayBaseUrl()}/v1/da/status/${e.eventId}`,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/da/status', authenticate, async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Missing 'wallet' query parameter",
      });
    }
    const normalizedAddress = wallet.toLowerCase().trim();
    const user = await UserData.findOne({ walletAddress: normalizedAddress }).select(
      'daSnapshot'
    );
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const eventId = user.daSnapshot?.eventId;
    if (!eventId) {
      return res.json({
        success: true,
        found: false,
        message: 'No DA event submitted yet for this wallet',
      });
    }

    const status = await zerogDAService.getEventStatus(eventId);
    const st = String(status?.daStatus || '').toLowerCase();
    if (
      status?.daBlobInfo &&
      (st === 'confirmed' || st === 'finalized')
    ) {
      await UserData.findByIdAndUpdate(user._id, {
        'daSnapshot.daStatus': status.daStatus,
        'daSnapshot.daReference': status.daReference,
        'daSnapshot.daBlobInfo': status.daBlobInfo,
      });
    }

    res.json({ success: true, eventId, ...status });
  } catch (error) {
    next(error);
  }
});

router.get('/da/retrieve', authenticate, async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Missing 'wallet' query parameter",
      });
    }
    const normalizedAddress = wallet.toLowerCase().trim();
    const user = await UserData.findOne({ walletAddress: normalizedAddress }).select(
      'daSnapshot'
    );
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const eventId = user.daSnapshot?.eventId;
    if (!eventId) {
      return res.json({
        success: true,
        retrieved: false,
        message: 'No DA event for this wallet',
      });
    }

    const result = await zerogDAService.retrievePlayerEvent(eventId);

    if (result.retrieved) {
      await UserData.findOneAndUpdate(
        { walletAddress: normalizedAddress },
        { $set: { 'daSnapshot.daStatus': 'retrieved' } },
      );
    }

    res.json({ success: true, eventId, ...result });
  } catch (error) {
    next(error);
  }
});

router.get('/da/health', authenticate, async (req, res, next) => {
  try {
    const da = await zerogDAService.healthCheck();
    res.json({ success: true, da });
  } catch (error) {
    next(error);
  }
});


// ==================== 0G COMPUTE ANALYSIS ====================

// GET /api/player/coaching?wallet=0x…
// 3 pool shot coaching tips generated via 0G Compute (TEE-verified).
router.get('/player/coaching', computeLimiter, authenticate, async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({ success: false, error: "Missing 'wallet' query parameter" });
    }
    const normalizedAddress = wallet.toLowerCase().trim();
    const user = await UserData.findOne({ walletAddress: normalizedAddress }).select('stats');
    if (!user) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }

    const result = await getPoolShotCoaching(user.stats || {});
    if (!result.ok) {
      return res.json({ success: true, tips: null, _meta: { reason: result.reason } });
    }

    res.json({
      success: true,
      tips: result.tips,
      _meta: {
        provider: result.provider,
        teeVerified: result.teeVerified,
        providerAddress: result.providerAddress ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/player/insight?wallet=0x…&rank=5
// One-sentence leaderboard performance insight via 0G Compute (TEE-verified).
router.get('/player/insight', computeLimiter, authenticate, async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({ success: false, error: "Missing 'wallet' query parameter" });
    }
    const rank = Math.max(1, Number(req.query.rank) || 1);
    const normalizedAddress = wallet.toLowerCase().trim();
    const user = await UserData.findOne({ walletAddress: normalizedAddress }).select('stats');
    if (!user) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }

    const result = await getPoolPerformanceInsight(user.stats || {}, rank);
    if (!result.ok) {
      return res.json({ success: true, insight: null, _meta: { reason: result.reason } });
    }

    res.json({
      success: true,
      insight: result.insight,
      _meta: {
        provider: result.provider,
        teeVerified: result.teeVerified,
        providerAddress: result.providerAddress ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ==================== MATCH + 0G PROOF ENDPOINTS ====================

// POST /api/player/match
// Game client calls this after every match. Submits pool.match.completed to 0G DA,
// runs TEE-verified post-match analysis via 0G Compute, updates playerMemory.
router.post('/player/match', computeLimiter, authenticate, async (req, res, next) => {
  try {
    const { score, accuracy, mode, won, opponent, duration, latency, matchId } = req.body;
    const wallet = req.walletAddress;

    const user = await UserData.findOne({ walletAddress: wallet }).select('stats playerMemory _id');
    if (!user) return res.status(404).json({ success: false, error: 'Player not found' });

    const intelligence = derivePlayerIntelligence(user.stats || {});

    // Persist updated playerMemory
    await UserData.findByIdAndUpdate(user._id, {
      $set: {
        playerMemory: { ...intelligence, updatedAt: new Date() },
      },
    });

    const matchData = { score, accuracy, mode, won, opponent, duration, latency, matchId };

    // Fire DA events non-blocking
    queueDA('match.completed', 'pool.match.completed', user._id, wallet,
      () => zerogDAService.submitMatchCompleted(wallet, matchData));

    queueDA('match.completed', 'pool.score.updated', user._id, wallet,
      () => zerogDAService.submitScoreUpdate(wallet, {
        totalBallsPocketed: user.stats?.totalBallsPocketed,
        ttBestScore:        user.stats?.ttBestScore,
        matrixBestScore:    user.stats?.matrixBestScore,
        delta:              score ?? null,
      }));

    queueDA('match.completed', 'pool.skill.updated', user._id, wallet,
      () => zerogDAService.submitSkillUpdate(wallet, intelligence));

    // 0G Compute: post-match analysis (non-blocking, returned in response if fast enough)
    let analysis = null;
    try {
      const r = await getMatchAnalysis(matchData, user.stats || {});
      if (r.ok) analysis = r;
    } catch (_) {}

    res.json({
      success: true,
      intelligence,
      analysis: analysis
        ? {
            feedback:       analysis.feedback,
            strength:       analysis.strength,
            weakness:       analysis.weakness,
            nextDifficulty: analysis.nextDifficulty,
            teeVerified:    analysis.teeVerified,
          }
        : null,
      _meta: { provider: '0g_compute', daEvents: ['pool.match.completed', 'pool.score.updated', 'pool.skill.updated'] },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/0g/proof/:wallet
// Returns the full cross-layer 0G proof for a wallet:
// DA event → on-chain anchor → stats hash. Verifiable by anyone.
router.get('/0g/proof/:wallet', async (req, res, next) => {
  try {
    const wallet = req.params.wallet?.toLowerCase().trim();
    if (!wallet) return res.status(400).json({ success: false, error: 'Missing wallet' });

    const user = await UserData.findOne({ walletAddress: wallet })
      .select('daSnapshot antiCheatSnapshot stats playerMemory');
    if (!user) return res.status(404).json({ success: false, error: 'Player not found' });

    const da = user.daSnapshot;

    res.json({
      success: true,
      wallet,
      proof: {
        layer1_da: da?.eventId
          ? {
              eventId:     da.eventId,
              eventType:   da.eventType,
              daStatus:    da.daStatus,
              verifyUrl:   `${zerogDAService.getGatewayBaseUrl()}/v1/da/status/${da.eventId}`,
              submittedAt: da.snapshotAt,
            }
          : null,
        layer2_anticheat: {
          accepted:  user.antiCheatSnapshot?.accepted  ?? null,
          source:    user.antiCheatSnapshot?.source    ?? null,
          checkedAt: user.antiCheatSnapshot?.checkedAt ?? null,
        },
      },
      description: 'DA blob (BLS-signed) → TEE anti-cheat verdict',
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/0g/player-memory/:wallet
// Returns player intelligence profile + skill evolution stored on 0G DA.
router.get('/0g/player-memory/:wallet', async (req, res, next) => {
  try {
    const wallet = req.params.wallet?.toLowerCase().trim();
    if (!wallet) return res.status(400).json({ success: false, error: 'Missing wallet' });

    const user = await UserData.findOne({ walletAddress: wallet })
      .select('stats playerMemory daEvents playerData');
    if (!user) return res.status(404).json({ success: false, error: 'Player not found' });

    // Always return a fresh intelligence reading alongside the stored snapshot
    const fresh = derivePlayerIntelligence(user.stats || {});

    // Pull only skill/match DA events from history
    const skillEvents = (user.daEvents || [])
      .filter(e => ['pool.skill.updated', 'pool.match.completed', 'pool.score.updated'].includes(e.eventType))
      .slice(-20)
      .map(e => ({ eventId: e.eventId, eventType: e.eventType, daStatus: e.daStatus, submittedAt: e.submittedAt }));

    res.json({
      success: true,
      wallet,
      playerName: user.playerData?.playerNames0 || 'Anonymous',
      intelligence: {
        current: fresh,
        snapshot: user.playerMemory?.updatedAt ? user.playerMemory : null,
      },
      skillEvents,
      _meta: { provider: '0g_da', eventsReturned: skillEvents.length },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/player/difficulty?wallet=0x…
// TEE-verified difficulty recommendation based on career profile.
router.get('/player/difficulty', computeLimiter, authenticate, async (req, res, next) => {
  try {
    const wallet = (req.query.wallet || req.walletAddress)?.toLowerCase().trim();
    const user = await UserData.findOne({ walletAddress: wallet }).select('stats');
    if (!user) return res.status(404).json({ success: false, error: 'Player not found' });

    const result = await getDifficultyTuning(user.stats || {});
    if (!result.ok) return res.json({ success: true, recommendation: null, _meta: { reason: result.reason } });

    res.json({
      success: true,
      recommendation: {
        difficulty:        result.recommendedDifficulty,
        cpuSkillLevel:     result.cpuSkillLevel,
        reasoning:         result.reasoning,
        shouldIntroducePvP: result.shouldIntroducePvP,
      },
      _meta: { provider: result.provider, teeVerified: result.teeVerified, providerAddress: result.providerAddress ?? null },
    });
  } catch (error) {
    next(error);
  }
});

// Health check endpoint
router.get('/health', authenticate, (req, res) => {
  const zgKey =
    process.env.ZEROG_API_KEY ||
    process.env.ZERO_G_API_KEY ||
    process.env.ZEROG_COMPUTE_API_KEY;
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    blockchain: {
      enabled: blockchainService.isReady(),
    },
    zerog: {
      daEnabled: process.env.ZEROG_DA_ENABLED !== 'false',
      computeConfigured: Boolean(zgKey),
      teeVerification: true,
    },
  });
});

module.exports = router;