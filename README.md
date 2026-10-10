# Nadcab Faucet

Token faucet for any EVM chain, deployed by Nadcab Console. Next.js + Tailwind UI (static export) served by a Fastify API that signs drips from a hot wallet.

Every push to `main` publishes `faucet.tar.gz` to the `latest` release; faucet hosts download it and run `faucet/run.sh` in `node:22-alpine`.

## Run locally

```bash
(cd web && npm ci && npm run build)
(cd server && npm ci)
cd server && PORT=4100 DATA_DIR=./.data RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337 \
  FAUCET_PRIVATE_KEY=0x... FAUCET_SECRET=$(openssl rand -hex 32) npm start
```

Settings (branding, assets, limits, captcha) are read from `DATA_DIR/branding/settings.json`, written by the console.
