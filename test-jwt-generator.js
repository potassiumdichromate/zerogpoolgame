const jwt = require('jsonwebtoken');

// Generate a test JWT for autologin
const generateTestJWT = () => {
  const payload = {
    walletAddress: '0x1234567890123456789012345678901234567890',
    timestamp: Date.now()
  };
  
  const secret = process.env.BROWSER_JWT_SECRET || 'dev-secret-change-me';
  const token = jwt.sign(payload, secret, { expiresIn: '1h' });
  
  console.log('Generated JWT:', token);
  console.log('Test URL with jwt and source:', `http://localhost:5173/?jwt=${token}&source=browser`);
  console.log('JWT-only URL:', `http://localhost:5173/?jwt=${token}`);
  
  return token;
};

console.log('Test URL with jwt and source:', 'http://localhost:5173/?jwt=your_jwt_token&source=browser');

generateTestJWT();
