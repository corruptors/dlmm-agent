#!/bin/bash
# Fee Compound Loop — runs fee-compound.js every 30 minutes
# Run via: pm2 start fee-compound-loop.sh --name fee-compound

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INTERVAL_MINUTES=30

while true; do
  echo "[$(date)] Running fee compound..."
  cd "$SCRIPT_DIR" && node fee-compound.js 2>&1
  echo "[$(date)] Sleep $INTERVAL_MINUTES minutes until next run..."
  sleep $((INTERVAL_MINUTES * 60))
done