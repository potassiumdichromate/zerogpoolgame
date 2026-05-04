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
const logger = require('../utils/logger');
const blockchainService = require('../utils/blockchain');
const zerogDAService = require('../services/zerogDAService');
const { generatePoolLeaderboardComment } = require('../services/aiPoolCommentService');
const { evaluateLeaderboardSubmission } = require('../services/leaderboardAntiCheatService');

router.use('/game', require('./gameWebglManifest'));

// 0G DA: fire-and-forget — never blocks the API response.
// submitFn must return Promise<{ eventId } | null>
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

    // 🔗 BLOCKCHAIN INTEGRATION: Record session on-chain (UPDATED - NOW AWAITS!)
    let blockchainResult = null;
    if (blockchainService.isReady()) {
      try {
        // AWAIT the blockchain transaction to get the txHash
        const sessionResult = await blockchainService.recordSession(normalizedAddress, userData.stats);
        
        if (sessionResult && sessionResult.success) {
          logger.info(`✅ Blockchain session recorded: ${sessionResult.transactionHash}`);
          
          blockchainResult = {
            success: true,
            txHash: sessionResult.transactionHash,
            blockNumber: sessionResult.blockNumber,
            gasUsed: sessionResult.gasUsed,
            blockchainEnabled: true,
          };
        } else {
          logger.warn(`⚠️ Blockchain session recording failed for ${normalizedAddress}`);
          blockchainResult = {
            success: false,
            error: sessionResult?.error || 'Unknown error',
            blockchainEnabled: true,
          };
        }

        // Also get login count
        const loginCount = await blockchainService.getUserLoginCount(normalizedAddress);
        if (loginCount !== null) {
          blockchainResult.onChainLoginCount = loginCount;
        }
      } catch (error) {
        logger.error(`❌ Failed to record blockchain session for ${normalizedAddress}:`, error);
        blockchainResult = {
          success: false,
          error: error.message,
          blockchainEnabled: true,
        };
      }
    }

    queueDA('login.auth', 'session.login', userData._id, normalizedAddress,
      () => zerogDAService.submitLoginEvent(normalizedAddress, userData));

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

    // 🔗 BLOCKCHAIN INTEGRATION: Record session on-chain
    let blockchainResult = null;
    if (blockchainService.isReady()) {
      try {
        const sessionResult = await blockchainService.recordSession(normalizedAddress, userData.stats);
        
        if (sessionResult && sessionResult.success) {
          logger.info(`✅ Blockchain session recorded: ${sessionResult.transactionHash}`);
          
          blockchainResult = {
            success: true,
            txHash: sessionResult.transactionHash,
            blockNumber: sessionResult.blockNumber,
            gasUsed: sessionResult.gasUsed,
            blockchainEnabled: true,
          };
        }

        const loginCount = await blockchainService.getUserLoginCount(normalizedAddress);
        if (loginCount !== null) {
          blockchainResult.onChainLoginCount = loginCount;
        }
      } catch (error) {
        logger.error(`❌ Failed to record blockchain session for ${normalizedAddress}:`, error);
        blockchainResult = {
          success: false,
          error: error.message,
          blockchainEnabled: true,
        };
      }
    }

    queueDA('login.v2', 'session.login', userData._id, normalizedAddress,
      () => zerogDAService.submitLoginEvent(normalizedAddress, userData));

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
router.get('/user', validateWalletAddress, async (req, res, next) => {
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
router.post('/user', validateWalletAddress, validateUserData, async (req, res, next) => {
  try {
    const { walletAddress, ...userData } = req.body;
    const normalizedAddress = walletAddress.toLowerCase();
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

    // NEW: Record blockchain session when user data is saved
    let blockchainResult = null;
    if (blockchainService.isReady() && updatedUser.stats) {
      try {
        const sessionResult = await blockchainService.recordSession(
          normalizedAddress, 
          updatedUser.stats
        );
        
        if (sessionResult && sessionResult.success) {
          blockchainResult = {
            success: true,
            txHash: sessionResult.transactionHash,
            blockNumber: sessionResult.blockNumber,
            gasUsed: sessionResult.gasUsed,
          };
          logger.info(`✅ User data save - Blockchain session: ${sessionResult.transactionHash}`);
        }
      } catch (error) {
        logger.error('Blockchain recording error during user save:', error);
        blockchainResult = {
          success: false,
          error: error.message,
        };
      }
    }

    queueDA('user.save', 'stats.update', updatedUser._id, normalizedAddress,
      () => zerogDAService.submitStatsUpdate(normalizedAddress, updatedUser));
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
router.get('/leaderboard', async (req, res, next) => {
  try {
    const leaderboard = await UserData
      .find()
      .select('walletAddress playerData.playerNames0 stats.totalBallsPocketed stats.totalGamesWonVsCPU stats.totalGamesWonVsHuman antiCheatSnapshot playerSaveSnapshot')
      .sort({ 'stats.totalBallsPocketed': -1 })
      .limit(100)
      .lean();

    const formattedLeaderboard = leaderboard.map((user, index) => ({
      rank: index + 1,
      walletAddress: user.walletAddress,
      playerName: user.playerData?.playerNames0 || 'Anonymous',
      totalBallsPocketed: user.stats?.totalBallsPocketed || 0,
      totalGamesWon: (user.stats?.totalGamesWonVsCPU || 0) + (user.stats?.totalGamesWonVsHuman || 0),
      trust: {
        antiCheatSource: user.antiCheatSnapshot?.source || null,
        antiCheatCheckedAt: user.antiCheatSnapshot?.checkedAt || null,
        saveBackedBy0g: Boolean(user.playerSaveSnapshot?.eventId),
      },
    }));

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
// 0G Compute (primary) + Cloudflare Workers AI fallback — same pattern as Highway Hustle.
router.get(
  '/leaderboard/ai-comment',
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

      const { comment, inferenceSource } = await generatePoolLeaderboardComment({
        currentUserDoc: currentUser,
        topUserDoc: topUser,
      });

      res.json({
        success: true,
        comment,
        _meta: {
          source: inferenceSource ?? null,
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
    }).select('playerData');

    if (!userData) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      data: userData.playerData,
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

router.get('/blockchain/session/:walletAddress', async (req, res, next) => {
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

router.get('/blockchain/login-count/:walletAddress', async (req, res, next) => {
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

router.get('/blockchain/stats', async (req, res, next) => {
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

// ==================== 0G DA (login session blobs) ====================

router.get('/da/snapshot', async (req, res, next) => {
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

router.get('/da/status', async (req, res, next) => {
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

router.get('/da/retrieve', async (req, res, next) => {
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
    res.json({ success: true, eventId, ...result });
  } catch (error) {
    next(error);
  }
});

router.get('/da/health', async (req, res, next) => {
  try {
    const da = await zerogDAService.healthCheck();
    res.json({ success: true, da });
  } catch (error) {
    next(error);
  }
});

// Health check endpoint
router.get('/health', (req, res) => {
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
      cloudflareFallbackConfigured: Boolean(
        process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN,
      ),
    },
  });
});

module.exports = router;