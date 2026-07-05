#!/usr/bin/env bash
# ─── Meridian DLMM Agent — Fresh VPS Bootstrap ──────────────────────────
# Usage on a new VPS (after cloning/funding wallet):
#   curl -sSL https://raw.githubusercontent.com/corruptors/dlmm-agent/main/scripts/install.sh | bash
#
# Optional arg: target install dir (default: ~/meridian)
#
# What it does:
#   1. Installs Node.js 20 + git if missing (apt/dnf detection)
#   2. Installs PM2 globally if missing
#   3. Clones the repo (or `git pull` if exists)
#   4. Runs `npm install` (includes postinstall anchor patch)
#   5. Prints next-step instructions for the interactive setup wizard
#
# Notes:
#   - Does NOT run setup wizard or start PM2 (those need interactive input)
#   - Requires sudo access for prereq installs
#   - Idempotent — safe to re-run; detects existing state

set -euo pipefail

REPO_URL="https://github.com/corruptors/dlmm-agent.git"
INSTALL_DIR="${1:-meridian}"

# ─── Colors (cosmetic) ───────────────────────────────────────────────────
GREEN="\033[0;32m"; YELLOW="\033[1;33m"; BLUE="\033[0;34m"; RESET="\033[0m"
step() { echo -e "${BLUE}▶ $*${RESET}"; }
ok()   { echo -e "${GREEN}✅ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠️  $*${RESET}"; }

echo ""
echo "🌐 Meridian DLMM Agent — Fresh VPS Bootstrap"
echo "─────────────────────────────────────────────"
echo ""

# ─── 1. Prereqs ───────────────────────────────────────────────────────────
step "Checking prereqs…"

if ! command -v git >/dev/null 2>&1; then
  warn "git missing — install manually first."
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then
    NODE_OK=1
    ok "Node $(node --version)"
  fi
fi
if [ "$NODE_OK" -eq 0 ]; then
  warn "Node 18+ not found — installing Node 20…"
  if command -v apt-get >/dev/null 2>&1; then
    if [ ! -f /etc/apt/sources.list.d/nodesource.list ]; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    fi
    sudo apt-get update -qq
    sudo apt-get install -y nodejs build-essential python3
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
    sudo dnf install -y nodejs gcc-c++ make python3
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
    sudo yum install -y nodejs gcc-c++ make python3
  else
    warn "Unsupported package manager. Install Node 20+ manually, then re-run."
    exit 1
  fi
  ok "Node $(node --version)"
fi

# ─── 2. PM2 ──────────────────────────────────────────────────────────────
if ! command -v pm2 >/dev/null 2>&1; then
  warn "PM2 missing — installing globally…"
  sudo npm i -g pm2
  ok "PM2 $(pm2 --version)"
else
  ok "PM2 $(pm2 --version)"
fi

# ─── 3. Clone or pull ────────────────────────────────────────────────────
cd "$HOME"
if [ -d "$INSTALL_DIR" ]; then
  warn "$INSTALL_DIR already exists — pulling latest"
  cd "$INSTALL_DIR"
  git pull --rebase --autostash
else
  step "Cloning $REPO_URL…"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
ok "Repo ready at $(pwd)"

# ─── 4. Install deps ─────────────────────────────────────────────────────
step "Installing dependencies (this may take a minute)…"
npm install --no-audit --no-fund
ok "Dependencies installed"

# ─── 5. Next steps ──────────────────────────────────────────────────────
cat <<EOF

${GREEN}✅ Bootstrap complete!${RESET}

${BLUE}Next steps (run manually — needs interactive input):${RESET}

  cd ~/${INSTALL_DIR}
  npm run setup              # interactive wizard (.env + user-config.json)
  npm run env:encrypt        # OPTIONAL: encrypt .env at rest
  npm run pm2:start          # deploy as 24/7 daemon

${YELLOW}You'll need these ready BEFORE running setup:${RESET}

  • Wallet private key (bs58)         — export from Phantom/Backpack
  • Helius API key                    — https://helius.dev (free tier OK)
  • LLM provider URL + key + model    — e.g. OpenRouter + minimax/\${model}
  • Telegram bot token + chat ID      — @BotFather + @userinfobot
  • (Optional) GMGN API key           — https://t.me/gmgngptsbot
  • (Optional) SOL in the wallet      — start with ~1 SOL for first deploys

${BLUE}Post-install sanity check:${RESET}

  pm2 list                          # meridian should show online
  pm2 logs meridian --lines 50      # tail recent activity
  node cli.js manage --dry-run      # one management cycle, no real trades

${BLUE}Useful paths:${RESET}
  Repo         : ~/${INSTALL_DIR}
  Logs         : ~/.pm2/logs/meridian-{out,error}.log
  User config  : ~/${INSTALL_DIR}/user-config.json  (gitignored, contains API keys)
  Encrypted .env (if you used env:encrypt): ~/${INSTALL_DIR}/.envcrypt

EOF
