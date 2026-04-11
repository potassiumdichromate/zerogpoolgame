const { verifyBrowserToken } = require('../utils/jwt');
const logger = require('../utils/logger');

const extractWalletAddress = (payload) => {
  const candidates = [
    payload?.walletAddress,
    payload?.address,
    payload?.wallet,
    payload?.sub,
  ];

  const wallet = candidates.find(
    (value) => typeof value === 'string' && value.trim().length > 0
  );

  return wallet ? wallet.trim().toLowerCase() : '';
};

const decodeBrowserJwtOptional = async (req, res, next) => {
  req.walletFromJwt = "";
  const jwtToken = req.body?.jwt;
  
  if (!jwtToken) return next();

  if (req.body?.source !== "browser") {
    return res.status(401).json({ 
      success: false, 
      message: "invalid request" 
    });
  }

  try {
    const decodedData = await verifyBrowserToken(jwtToken);
    const walletFromJwt = extractWalletAddress(decodedData);
    if (!walletFromJwt) {
      return res.status(400).json({ 
        success: false, 
        message: "invalid walletAddress" 
      });
    }
    req.walletFromJwt = walletFromJwt;
    return next();
  } catch (error) {
    logger.error('Browser JWT verification failed:', error.message);
    return res.status(401).json({ 
      success: false, 
      message: "invalid token" 
    });
  }
};

module.exports = {
  decodeBrowserJwtOptional,
};
