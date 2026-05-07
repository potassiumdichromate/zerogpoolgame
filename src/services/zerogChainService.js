'use strict';

const logger = require('../utils/logger');

/**
 * Returns true only when both the anchor contract address and a signing key are
 * present in the environment. Reads at call time so tests can manipulate env vars
 * without clearing the module cache.
 */
function isEnabled() {
  const addr = process.env.ZG_POOL_ANCHOR_ADDRESS || '';
  const key  = process.env.ZG_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY || '';
  return Boolean(addr && key);
}

/**
 * Anchors a DA event hash on-chain for the given wallet.
 * Returns null when the service is not configured.
 *
 * @param {string} walletAddress
 * @param {string} eventId       - 0G DA event ID
 * @param {string} daHash        - root hash or blob reference to anchor
 * @returns {Promise<{ txHash: string, blockNumber: number } | null>}
 */
async function anchorSession(walletAddress, eventId, daHash) {
  if (!isEnabled()) return null;

  try {
    // Placeholder — real implementation uses ethers.js to call the anchor contract
    logger.info(`[chain-anchor] anchorSession wallet=${walletAddress} eventId=${eventId}`);
    return null;
  } catch (err) {
    logger.warn(`[chain-anchor] anchorSession failed: ${err.message}`);
    return null;
  }
}

/**
 * Retrieves the latest on-chain anchor record for the given wallet.
 * Returns null when the service is not configured or no record exists.
 *
 * @param {string} walletAddress
 * @returns {Promise<{ txHash: string, blockNumber: number, daHash: string } | null>}
 */
async function getLatestAnchor(walletAddress) {
  if (!isEnabled()) return null;

  try {
    logger.info(`[chain-anchor] getLatestAnchor wallet=${walletAddress}`);
    return null;
  } catch (err) {
    logger.warn(`[chain-anchor] getLatestAnchor failed: ${err.message}`);
    return null;
  }
}

module.exports = { isEnabled, anchorSession, getLatestAnchor };
