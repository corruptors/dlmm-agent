#!/bin/bash
# Meridian daily state backup
# Backs up state.json, decision-log.json, pool-memory.json, user-config.json
# Keeps last 7 days of backups (rotation)

set -e
BACKUP_DIR="/root/meridian/backups"
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
MERIDIAN_DIR="/root/meridian"

mkdir -p "$BACKUP_DIR"

cd "$MERIDIAN_DIR"
for f in state.json decision-log.json pool-memory.json user-config.json; do
  if [ -f "$f" ]; then
    cp "$f" "$BACKUP_DIR/${f%.json}_${TIMESTAMP}.json"
  fi
done

# Rotation: keep last 7 days
find "$BACKUP_DIR" -name "*.json" -mtime +7 -delete

# Log result
echo "[$TIMESTAMP] Backup complete. Files:"
ls -la "$BACKUP_DIR" | tail -10
