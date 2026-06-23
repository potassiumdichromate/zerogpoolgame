const DEFAULT_BASE_URL = 'https://kult-browser-rust-l2lwg.ondigitalocean.app/api/internal/kult-points';

function getConfig() {
  const baseUrl = String(process.env.KULT_POINTS_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiKey = String(process.env.KULT_POINTS_INTERNAL_API_KEY || process.env.INTERNAL_KULT_POINTS_API_KEY || '').trim();
  const headerName = String(process.env.KULT_POINTS_INTERNAL_HEADER_NAME || process.env.INTERNAL_KULT_POINTS_HEADER_NAME || 'x-kult-internal-key').trim();
  return { baseUrl, apiKey, headerName };
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeWallet(value) {
  const walletAddress = String(value || '').trim();
  if (!walletAddress) throw httpError('walletAddress is required', 400);
  return walletAddress;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError('amount must be a positive number', 400);
  }
  return amount;
}

async function callKultPoints(path, options = {}) {
  const { baseUrl, apiKey, headerName } = getConfig();
  if (!apiKey) throw httpError('KULT_POINTS_INTERNAL_API_KEY is not configured', 503);

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      [headerName]: apiKey,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw httpError(payload.message || payload.error || 'Kult Points service request failed', response.status || 502);
  }
  return payload.data || payload;
}

async function getKultPoints(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  return callKultPoints(`/?walletAddress=${encodeURIComponent(wallet)}`);
}

async function adjustKultPoints({ walletAddress, action, amount }) {
  const wallet = normalizeWallet(walletAddress);
  const safeAmount = normalizeAmount(amount);
  return callKultPoints('/', {
    method: 'POST',
    body: JSON.stringify({ walletAddress: wallet, action, amount: safeAmount }),
  });
}

module.exports = {
  getKultPoints,
  adjustKultPoints,
};
