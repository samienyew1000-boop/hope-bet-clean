# Hope Bet API — Phase 1

Backend for the Hope Bet sportsbook: accounts, ETB wallet, bet placement, and odds proxy.

## Quick start (local)

```bash
cd hope-bet-api
cp .env.example .env
npm install
npm run dev
```

API runs at **http://127.0.0.1:8787**

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check |
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Sign in → JWT |
| GET | `/api/auth/me` | Yes | Current user |
| GET | `/api/wallet/balance` | Yes | Wallet balance |
| POST | `/api/bets/place` | Yes | Place bet |
| GET | `/api/bets/history` | Yes | Bet history |
| GET | `/api/odds/*` | No | Proxied live odds |

## Deploy to Render (free tier)

1. Create **Web Service** from this folder
2. Build: `npm install`
3. Start: `npm start`
4. Env vars: `JWT_SECRET`, `CORS_ORIGIN=https://betting-ed.vercel.app`
5. Copy Render URL into sport betting `index.html`:

```html
<meta name="hope-bet-api" content="https://YOUR-API.onrender.com" />
```

## Frontend connection

In `sport betting/index.html`, set the meta tag to your API URL.  
Locally, `config.js` auto-uses `http://127.0.0.1:8787`.

Redeploy sport betting on Vercel after updating the meta tag.
