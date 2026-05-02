# ZeroGPool Backend API

Production-ready backend for ZerpGPool game with MongoDB integration.

**0G integration (DA gateway + optional EVM sessions):** see **[0G_INTEGRATION.md](./0G_INTEGRATION.md)** for architecture, env vars, routes, data flow, and operational notes.

## Features

- ✅ RESTful API with 3 endpoints
- ✅ MongoDB for data persistence
- ✅ No caching - real-time data
- ✅ Input validation with Joi
- ✅ Security headers with Helmet
- ✅ Rate limiting
- ✅ Comprehensive error handling
- ✅ Winston logging
- ✅ CORS support
- ✅ Production-ready

## Prerequisites

- Node.js >= 18.0.0
- MongoDB database (MongoDB Atlas recommended)

## Installation

1. Clone the repository
2. Install dependencies:
```bash
   npm install
```
3. Create `.env` file from `.env.example`:
```bash
   cp .env.example .env
```
4. Update `.env` with your configuration

## Running Locally

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

## API Endpoints

### 1. Get User Data
```http
GET /api/user?walletAddress=0x1234567890abcdef1234567890abcdef12345678
```

**Response:**
```json
{
  "success": true,
  "data": {
    "walletAddress": "0x1234...",
    "playerData": {...},
    "stats": {...},
    ...
  }
}
```

### 2. Save User Data
```http
POST /api/user
Content-Type: application/json

{
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "playerData": {...},
  "stats": {...},
  ...
}
```

### 3. Leaderboard
```http
GET /api/leaderboard
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "rank": 1,
      "walletAddress": "0x1234...",
      "playerName": "Player1",
      "totalBallsPocketed": 1500,
      "totalGamesWon": 100
    }
  ],
  "count": 100
}