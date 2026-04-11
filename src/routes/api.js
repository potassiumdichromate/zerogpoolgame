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
} = require('../middleware/validation');
const logger = require('../utils/logger');
const blockchainService = require('../utils/blockchain');

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

    const updatedUser = await UserData.findOneAndUpdate(
      { walletAddress: normalizedAddress },
      {
        $set: {
          ...userData,
          walletAddress: normalizedAddress,
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

    res.json({
      success: true,
      data: updatedUser,
      blockchain: blockchainResult, // NEW: Include blockchain result
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
      .select('walletAddress playerData.playerNames0 stats.totalBallsPocketed stats.totalGamesWonVsCPU stats.totalGamesWonVsHuman')
      .sort({ 'stats.totalBallsPocketed': -1 })
      .limit(100)
      .lean();

    const formattedLeaderboard = leaderboard.map((user, index) => ({
      rank: index + 1,
      walletAddress: user.walletAddress,
      playerName: user.playerData?.playerNames0 || 'Anonymous',
      totalBallsPocketed: user.stats?.totalBallsPocketed || 0,
      totalGamesWon: (user.stats?.totalGamesWonVsCPU || 0) + (user.stats?.totalGamesWonVsHuman || 0),
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

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    blockchain: {
      enabled: blockchainService.isReady(),
    },
  });
});

module.exports = router;