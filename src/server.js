require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const connectDB = require('./config/database');
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const blockchainService   = require('./utils/blockchain');
const zerogDAService      = require('./services/zerogDAService');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Connect to MongoDB
connectDB();

// 🔗 Initialize Blockchain Service (NEW)
blockchainService.initialize()
  .then(() => {
    if (blockchainService.isReady()) {
      logger.info('🔗 Blockchain service initialized and ready');
    } else {
      logger.warn('⚠️ Blockchain service disabled - check .env configuration');
    }
  })
  .catch(err => {
    logger.error('❌ Blockchain initialization failed:', err);
  });

zerogDAService.healthCheck().then((s) => {
  logger.info(`[0g-da] gateway ${s.gateway} online=${s.online}`);
});


// ✅ Trust proxy (needed for Render)
app.set('trust proxy', 1);

// ✅ Security middleware — must allow the React app to iframe `/zeroGpool-play/` (different port = different origin)
// Unity WebGL breaks under Helmet's default CSP (dynamic loader + WASM); tightening script-src
// still leaves edge cases. Ship no CSP from Node for this API — embed protection uses CORS + auth instead.
app.use(
  helmet({
    frameguard: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }),
);

// Do not send any CSP on `/zeroGpool-play` — Unity WebGL + dynamic script tags need an unrestricted document.
// (frame-ancestors-only CSP still confused Chrome in testing.) Iframe parents: rely on `frameguard: false` above.

// ✅ Global CORS Fix (handles preflight first)
const allowedOrigins = [
  'https://zerogpool.xyz',
  'https://zerogpool-frontend.vercel.app',
  'https://zerogpoolgame.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    // Respond to preflight immediately
    return res.sendStatus(204);
  }
  next();
});

// ✅ Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ✅ Compression for performance
app.use(compression());

// ✅ Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  next();
});

// ✅ Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ZeroGPool Backend API',
    version: '3.0.0',
    status: {
      blockchain: blockchainService.isReady() ? 'enabled' : 'disabled',
    },
  });
});

// ✅ Static host: Unity WebGL (manifest + bootstrap + build binaries under public/zeroGpool-play/)
// __dirname is `src/` — public assets live at project root `public/`, not `src/public/`.
app.use(
  '/zeroGpool-play',
  express.static(path.join(__dirname, '..', 'public', 'zeroGpool-play')),
);

// ✅ API routes
app.use('/api', apiRoutes);

// ✅ REFERRAL routes (NEW)
app.use('/api/referral', require('./routes/referralRoutes'));

// ✅ 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
  });
});

// ✅ Error handler
app.use(errorHandler);

// ✅ Graceful shutdown
const gracefulShutdown = () => {
  logger.info('🛑 Shutting down gracefully...');
  server.close(() => {
    logger.info('✅ HTTP server closed');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ✅ Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Promise Rejection:', err);
  server.close(() => {
    process.exit(1);
  });
});

// ✅ Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  logger.info(`🔗 Blockchain integration: ${blockchainService.isReady() ? 'ENABLED' : 'DISABLED'}`);
});

module.exports = app;
