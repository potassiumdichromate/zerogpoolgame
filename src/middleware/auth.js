const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const authenticate = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No token provided. Please login first.',
      });
    }

    // Extract token
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token format',
      });
    }

    // Verify token
    let decoded;
    
    if(req.body.source === "browser"){
      decoded = jwt.verify(token, process.env.BROWSER_JWT_SECRET);
    } else {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    }

    // Add wallet address to request
    req.walletAddress = decoded.walletAddress.toLowerCase();
    req.userId = decoded.userId;
    
    next();
  } catch (error) {
    logger.error('Authentication error:', error.message);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token has expired. Please login again.',
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token. Please login again.',
      });
    }
    
    return res.status(401).json({
      success: false,
      error: 'Authentication failed',
    });
  }
};

module.exports = authenticate;