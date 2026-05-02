const logger = require('../utils/logger');

/**
 * 0G DA Service — ZeroGPool
 *
 * Sends login/session events to the 0G DA Event Gateway (same pattern as Highway Hustle).
 * Gateway batches and forwards to the 0G DA disperser; each event gets an eventId for
 * status polling and optional blob retrieval.
 *
 * Auth: Authorization: Bearer <ZEROG_DA_API_KEY> when the gateway requires it.
 */

const { randomUUID } = require('crypto');

const GATEWAY_URL = process.env.ZEROG_DA_GATEWAY_URL || 'https://da.warzonewarriors.xyz';
const SUBMIT_TIMEOUT = 10_000;
const STATUS_TIMEOUT = 8_000;
const RETRIEVE_TIMEOUT = 12_000;

const GAME_ID = 'zeroGpool';

const getHeaders = () => {
  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.ZEROG_DA_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
};

const isSubmitEnabled = () => process.env.ZEROG_DA_ENABLED !== 'false';

const buildEventData = (identifier, userDoc) => {
  const o = userDoc && typeof userDoc === 'object' ? userDoc : {};
  const plain = o.toObject ? o.toObject() : { ...o };
  return {
    identifier,
    walletAddress: identifier,
    playerName: plain.playerData?.playerNames0 || 'Anonymous',
    stats: {
      totalTimePlayed: plain.stats?.totalTimePlayed ?? 0,
      totalGamesPlayedVsCPU: plain.stats?.totalGamesPlayedVsCPU ?? 0,
      totalGamesWonVsCPU: plain.stats?.totalGamesWonVsCPU ?? 0,
      totalGamesPlayedVsHuman: plain.stats?.totalGamesPlayedVsHuman ?? 0,
      totalGamesWonVsHuman: plain.stats?.totalGamesWonVsHuman ?? 0,
      totalBallsPocketed: plain.stats?.totalBallsPocketed ?? 0,
      ttBestScore: plain.stats?.ttBestScore ?? 0,
      matrixBestScore: plain.stats?.matrixBestScore ?? 0,
    },
    recordedAt: new Date().toISOString(),
  };
};

/** @returns {Promise<{ eventId: string } | null>} */
const submitPlayerEvent = async (eventName, identifier, userDoc) => {
  if (!isSubmitEnabled()) {
    return null;
  }

  const eventId = randomUUID();

  try {
    const body = {
      eventId,
      game: GAME_ID,
      event: eventName,
      data: buildEventData(identifier, userDoc),
    };

    const res = await fetch(`${GATEWAY_URL}/v1/events`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gateway ${res.status}: ${text}`);
    }

    const json = await res.json();
    logger.info(`[0g-da] ✅ Event queued | eventId: ${eventId} | event: ${eventName} | wallet: ${identifier} | accepted: ${json.accepted}`);

    return { eventId };
  } catch (err) {
    logger.warn(`[0g-da] ⚠️ Submit failed (${eventName} / ${identifier}): ${err.message}`);
    return null;
  }
};

const getEventStatus = async (eventId) => {
  if (!eventId) return null;

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/da/status/${eventId}`, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(STATUS_TIMEOUT),
    });

    if (!res.ok) {
      if (res.status === 404) return { found: false };
      throw new Error(`Status check ${res.status}`);
    }

    const doc = await res.json();
    return {
      found: true,
      eventId: doc.eventId,
      status: doc.status,
      daReference: doc.daReference,
      daStatus: doc.daStatus,
      daBlobInfo: doc.daBlobInfo,
      error: doc.error,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  } catch (err) {
    logger.warn(`[0g-da] ⚠️ Status check failed (${eventId}): ${err.message}`);
    return null;
  }
};

const retrievePlayerEvent = async (eventId) => {
  if (!eventId) return { retrieved: false, reason: 'no_event_id' };

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/da/retrieve/${eventId}`, {
      method: 'POST',
      headers: getHeaders(),
      signal: AbortSignal.timeout(RETRIEVE_TIMEOUT),
    });

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      return { retrieved: false, reason: 'not_finalized_yet', daStatus: body.daStatus };
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { retrieved: false, reason: body.message || `gateway_${res.status}` };
    }

    const doc = await res.json();
    let data = null;
    if (doc.retrieved?.dataBase64) {
      try {
        data = JSON.parse(Buffer.from(doc.retrieved.dataBase64, 'base64').toString('utf-8'));
      } catch (_) {
        data = doc.retrieved.dataBase64;
      }
    }

    return {
      retrieved: true,
      eventId: doc.eventId,
      daBlobInfo: doc.daBlobInfo,
      data,
    };
  } catch (err) {
    return { retrieved: false, reason: err.message };
  }
};

const healthCheck = async () => {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json();
    return {
      gateway: GATEWAY_URL,
      online: !!body.ready,
      ...body,
    };
  } catch (err) {
    return { gateway: GATEWAY_URL, online: false, error: err.message };
  }
};

const getGatewayBaseUrl = () => GATEWAY_URL.replace(/\/+$/, '');

module.exports = {
  submitPlayerEvent,
  getEventStatus,
  retrievePlayerEvent,
  healthCheck,
  getGatewayBaseUrl,
};
