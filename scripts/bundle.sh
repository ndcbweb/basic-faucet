#!/usr/bin/env bash
# Builds dist/faucet.tar.gz, which faucet hosts download and run with node:22-alpine.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd web && npm ci && NODE_ENV=production npm run build)
(cd server && npm ci --omit=dev)

rm -rf dist
mkdir -p dist/faucet/web
cp -R server dist/faucet/server
rm -rf dist/faucet/server/.data
cp -R web/out dist/faucet/web/out
cp run.sh dist/faucet/run.sh
tar -czf dist/faucet.tar.gz -C dist faucet
echo "Built $(pwd)/dist/faucet.tar.gz"
