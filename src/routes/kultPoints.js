const express = require('express');
const { adjustKultPoints, getKultPoints } = require('../services/kultPointsClient');

const router = express.Router();

function walletFrom(req) {
  return req.query.walletAddress || req.query.wallet || req.body.walletAddress || req.body.wallet;
}

function sendError(res, err) {
  return res.status(err.statusCode || 502).json({
    success: false,
    error: err.message || 'Kult Points request failed',
  });
}

function requireMutationKey(req, res, next) {
  const expected = String(
    process.env.KULT_POINTS_PROXY_API_KEY ||
    process.env.KULT_POINTS_INTERNAL_API_KEY ||
    process.env.INTERNAL_KULT_POINTS_API_KEY ||
    '',
  ).trim();
  const headerName = String(process.env.KULT_POINTS_INTERNAL_HEADER_NAME || process.env.INTERNAL_KULT_POINTS_HEADER_NAME || 'x-kult-internal-key');
  if (!expected) {
    return res.status(503).json({ success: false, error: 'Kult Points mutation key is not configured' });
  }
  if (String(req.header(headerName) || '').trim() !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid Kult Points mutation key' });
  }
  return next();
}

router.get('/', async (req, res) => {
  try {
    const data = await getKultPoints(walletFrom(req));
    return res.json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/add', requireMutationKey, async (req, res) => {
  try {
    const data = await adjustKultPoints({
      walletAddress: walletFrom(req),
      action: 'give',
      amount: req.body.amount,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
});

async function subtract(req, res) {
  try {
    const data = await adjustKultPoints({
      walletAddress: walletFrom(req),
      action: 'minus',
      amount: req.body.amount,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
}

router.post('/subtract', requireMutationKey, subtract);
router.post('/deduct', requireMutationKey, subtract);
router.post('/substract', requireMutationKey, subtract);

module.exports = router;
