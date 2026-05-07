const { ethers } = require('ethers');
const logger = require('./logger');

class BlockchainService {
  constructor() {
    this.provider = null;
    this.wallet = null;
    this.contract = null;
    this.isInitialized = false;
  }

 
  async initialize() {
    try {
      // Check if required env variables are set
      if (!process.env.BLOCKCHAIN_RPC_URL) {
        logger.warn('BLOCKCHAIN_RPC_URL not set. Blockchain integration disabled.');
        return;
      }

      if (!process.env.OPERATOR_PRIVATE_KEY) {
        logger.warn('OPERATOR_PRIVATE_KEY not set. Blockchain integration disabled.');
        return;
      }

      if (!process.env.CONTRACT_ADDRESS) {
        logger.warn('CONTRACT_ADDRESS not set. Blockchain integration disabled.');
        return;
      }

      // Initialize provider
      this.provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
      
      // Initialize wallet
      this.wallet = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, this.provider);
      
      // Contract ABI (only the functions we need)
      const contractABI = [
        'function recordSession(address _user, tuple(uint256 totalTimePlayed, uint256 totalGamesPlayedVsCPU, uint256 totalGamesWonVsCPU, uint256 totalGamesPlayedVsHuman, uint256 totalGamesWonVsHuman, uint256 totalBallsPocketed, uint256 ttBestScore, uint256 matrixBestScore) _stats) external',
        'function getUserLoginCount(address _user) external view returns (uint256)',
        'function getLatestSession(address _user) external view returns (tuple(address walletAddress, uint256 loginCount, uint256 timestamp, tuple(uint256 totalTimePlayed, uint256 totalGamesPlayedVsCPU, uint256 totalGamesWonVsCPU, uint256 totalGamesPlayedVsHuman, uint256 totalGamesWonVsHuman, uint256 totalBallsPocketed, uint256 ttBestScore, uint256 matrixBestScore) stats))',
        'function getTotalUsers() external view returns (uint256)',
        'function totalSessions() external view returns (uint256)',
        'event SessionRecorded(address indexed user, uint256 indexed loginCount, uint256 timestamp, uint256 totalBallsPocketed)',
      ];

      // Initialize contract
      this.contract = new ethers.Contract(
        process.env.CONTRACT_ADDRESS,
        contractABI,
        this.wallet
      );

      // Test connection
      const network = await this.provider.getNetwork();
      logger.info(`Connected to blockchain network: ${network.name} (chainId: ${network.chainId})`);
      
      this.isInitialized = true;
      logger.info('Blockchain service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize blockchain service:', error);
      this.isInitialized = false;
    }
  }

  async recordSession(walletAddress, stats) {
    if (!this.isInitialized) {
      logger.warn('Blockchain service not initialized. Skipping session recording.');
      return null;
    }

    try {
      logger.info(`Recording session for ${walletAddress} on blockchain...`);

      // Prepare stats tuple for the contract
      const statsTuple = {
        totalTimePlayed: stats.totalTimePlayed || 0,
        totalGamesPlayedVsCPU: stats.totalGamesPlayedVsCPU || 0,
        totalGamesWonVsCPU: stats.totalGamesWonVsCPU || 0,
        totalGamesPlayedVsHuman: stats.totalGamesPlayedVsHuman || 0,
        totalGamesWonVsHuman: stats.totalGamesWonVsHuman || 0,
        totalBallsPocketed: stats.totalBallsPocketed || 0,
        ttBestScore: stats.ttBestScore || 0,
        matrixBestScore: stats.matrixBestScore || 0,
      };

      // Send transaction
      const tx = await this.contract.recordSession(walletAddress, statsTuple);

      logger.info(`Transaction sent: ${tx.hash}`);

      const receipt = await tx.wait();

      // Decode the SessionRecorded event from receipt logs to get on-chain loginCount
      let onChainLoginCount = null;
      try {
        for (const log of receipt.logs) {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed?.name === 'SessionRecorded') {
            onChainLoginCount = Number(parsed.args.loginCount);
            break;
          }
        }
      } catch (_) {}

      logger.info(`Session recorded on blockchain. Block: ${receipt.blockNumber}, Gas: ${receipt.gasUsed.toString()}, loginCount: ${onChainLoginCount}`);

      return {
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        onChainLoginCount,
        success: true,
      };
    } catch (error) {
      logger.error('Failed to record session on blockchain:', error);
      
      // Return error info but don't throw - we don't want blockchain errors to break login
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getUserLoginCount(walletAddress) {
    if (!this.isInitialized) {
      return null;
    }

    try {
      const count = await this.contract.getUserLoginCount(walletAddress);
      return Number(count);
    } catch (error) {
      logger.error('Failed to get user login count:', error);
      return null;
    }
  }

  async getLatestSession(walletAddress) {
    if (!this.isInitialized) {
      return null;
    }

    try {
      const session = await this.contract.getLatestSession(walletAddress);
      return {
        walletAddress: session.walletAddress,
        loginCount: Number(session.loginCount),
        timestamp: Number(session.timestamp),
        stats: {
          totalTimePlayed: Number(session.stats.totalTimePlayed),
          totalGamesPlayedVsCPU: Number(session.stats.totalGamesPlayedVsCPU),
          totalGamesWonVsCPU: Number(session.stats.totalGamesWonVsCPU),
          totalGamesPlayedVsHuman: Number(session.stats.totalGamesPlayedVsHuman),
          totalGamesWonVsHuman: Number(session.stats.totalGamesWonVsHuman),
          totalBallsPocketed: Number(session.stats.totalBallsPocketed),
          ttBestScore: Number(session.stats.ttBestScore),
          matrixBestScore: Number(session.stats.matrixBestScore),
        },
      };
    } catch (error) {
      logger.error('Failed to get latest session:', error);
      return null;
    }
  }

  async getBlockchainStats() {
    if (!this.isInitialized) {
      return null;
    }

    try {
      const totalUsers = await this.contract.getTotalUsers();
      const totalSessions = await this.contract.totalSessions();
      
      return {
        totalUsers: Number(totalUsers),
        totalSessions: Number(totalSessions),
      };
    } catch (error) {
      logger.error('Failed to get blockchain stats:', error);
      return null;
    }
  }

  isReady() {
    return this.isInitialized;
  }
}

const blockchainService = new BlockchainService();

module.exports = blockchainService;
