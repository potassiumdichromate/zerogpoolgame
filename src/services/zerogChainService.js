'use strict';
/**
 * ZeroGChain — anchor pool sessions on the 0G EVM chain.
 *
 * On every login, after a DA event is accepted, we call:
 *   PoolSessionAnchor.anchorSession(wallet, daEventId, statsHash)
 *
 * This creates an immutable, publicly verifiable on-chain record:
 *   "wallet 0xABC submitted DA event <id> whose stats hash to <hash>"
 *
 * Cross-layer proof chain:
 *   Browser  → 0G Storage (Merkle root verified)
 *   Backend  → 0G DA (event blob dispersed + BLS signed)
 *   On-chain → 0G EVM (daEventId + statsHash anchored, block-timestamped)
 *
 * 0G EVM:
 *   RPC:      https://evmrpc.0g.ai   (ZG_RPC_URL)
 *   ChainId:  16600                   (ZG_CHAIN_ID)
 *   Explorer: https://chainscan.0g.ai
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');

const ZG_RPC_URL  = process.env.ZG_RPC_URL  || 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID = Number(process.env.ZG_CHAIN_ID || 16600);
const ANCHOR_ADDR = process.env.ZG_POOL_ANCHOR_ADDRESS || '';

const ANCHOR_ABI = [
  'function anchorSession(address wallet, string calldata daEventId, string calldata statsHash) external',
  'function getLatestAnchor(address wallet) external view returns (string daEventId, string statsHash, uint256 anchoredAt)',
  'event SessionAnchored(address indexed wallet, string daEventId, string statsHash, uint256 timestamp)',
];

function getPrivateKey() {
  const k = (process.env.ZG_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY || '').trim();
  if (!k) throw new Error('ZG_PRIVATE_KEY not set — needed for 0G chain anchoring');
  return k.startsWith('0x') ? k : `0x${k}`;
}

let _contract = null;

function getContract() {
  if (_contract) return _contract;
  if (!ANCHOR_ADDR) throw new Error('ZG_POOL_ANCHOR_ADDRESS not set — deploy PoolSessionAnchor.sol on 0G chain first');
  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, { chainId: ZG_CHAIN_ID, name: '0g' });
  const signer   = new ethers.Wallet(getPrivateKey(), provider);
  _contract = new ethers.Contract(ANCHOR_ADDR, ANCHOR_ABI, signer);
  logger.info(`[0g-chain] PoolSessionAnchor ready — ${ANCHOR_ADDR} (chainId ${ZG_CHAIN_ID})`);
  return _contract;
}

function isEnabled() {
  return Boolean(
    ANCHOR_ADDR &&
    (process.env.ZG_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY),
  );
}

/**
 * Anchor a DA event + stats hash on the 0G EVM chain.
 * Call from setImmediate — never block a request handler.
 *
 * @returns {{ txHash, blockNumber, daEventId, statsHash, anchoredAt }} or null
 */
async function anchorSession(walletAddress, daEventId, statsHash) {
  if (!isEnabled()) {
    logger.warn('[0g-chain] anchor skipped — ZG_POOL_ANCHOR_ADDRESS or ZG_PRIVATE_KEY not set');
    return null;
  }

  const contract = getContract();
  const tx = await contract.anchorSession(walletAddress, daEventId, statsHash);
  logger.info('[0g-chain] anchorSession tx sent', { txHash: tx.hash, wallet: walletAddress, daEventId });

  const receipt = await tx.wait(1);

  let anchoredAtTs = null;
  try {
    for (const log of receipt.logs) {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === 'SessionAnchored') {
        anchoredAtTs = Number(parsed.args.timestamp);
        break;
      }
    }
  } catch (_) {}

  logger.info('[0g-chain] anchorSession confirmed', {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    daEventId,
  });

  return {
    txHash:      receipt.hash,
    blockNumber: Number(receipt.blockNumber),
    daEventId,
    statsHash,
    anchoredAt:  anchoredAtTs ? new Date(anchoredAtTs * 1000) : new Date(),
  };
}

/**
 * Read the latest on-chain anchor for a wallet.
 */
async function getLatestAnchor(walletAddress) {
  if (!isEnabled()) return null;
  try {
    const contract = getContract();
    const result   = await contract.getLatestAnchor(walletAddress);
    const ts       = Number(result.anchoredAt);
    if (!result.daEventId) return null;
    return {
      daEventId:  result.daEventId,
      statsHash:  result.statsHash,
      anchoredAt: ts ? new Date(ts * 1000) : null,
    };
  } catch (err) {
    logger.warn(`[0g-chain] getLatestAnchor failed: ${err.message}`);
    return null;
  }
}

module.exports = { anchorSession, getLatestAnchor, isEnabled };
