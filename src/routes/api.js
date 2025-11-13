const express = require('express');
const router = express.Router();
const UserData = require('../models/UserData');
const authenticate = require('../middleware/auth');
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

// ==================== PUBLIC ENDPOINTS ====================

// POST /api/auth/login - Login and get JWT token + Record session on blockchain
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

    // Generate JWT token
    const token = generateToken(normalizedAddress, userData._id);

    logger.info(`User logged in: ${normalizedAddress}`);

    // 🔗 BLOCKCHAIN INTEGRATION: Record session on-chain (non-blocking)
    let blockchainResult = null;
    if (blockchainService.isReady()) {
      // Record session asynchronously - don't wait for it
      blockchainService.recordSession(normalizedAddress, userData.stats)
        .then(result => {
          if (result && result.success) {
            logger.info(`Blockchain session recorded for ${normalizedAddress}: ${result.transactionHash}`);
          }
        })
        .catch(error => {
          logger.error(`Failed to record blockchain session for ${normalizedAddress}:`, error);
        });
      
      // Optionally, get current login count from blockchain
      try {
        const loginCount = await blockchainService.getUserLoginCount(normalizedAddress);
        if (loginCount !== null) {
          blockchainResult = {
            onChainLoginCount: loginCount,
            blockchainEnabled: true,
          };
        }
      } catch (error) {
        logger.error('Failed to get blockchain login count:', error);
      }
    }

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        walletAddress: normalizedAddress,
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
        ...(blockchainResult && { blockchain: blockchainResult }),
      },
    });
  } catch (error) {
    next(error);
  }
});

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

    res.json({
      success: true,
      data: updatedUser,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/leaderboard - Get top 100 players by total balls pocketed
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

// GET /api/player/data - Get player data
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

// POST /api/player/name - Update player name (playerNames0)
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

// GET /api/player/stats - Get user stats with optional filter
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

    // If specific stat type requested, return only that stat
    if (statType) {
      res.json({
        success: true,
        data: {
          [statType]: userData.stats[statType],
        },
      });
    } else {
      // Return all stats
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

// GET /api/blockchain/session/:walletAddress - Get user's latest blockchain session
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

// GET /api/blockchain/login-count/:walletAddress - Get user's on-chain login count
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

// GET /api/blockchain/stats - Get blockchain contract statistics
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
