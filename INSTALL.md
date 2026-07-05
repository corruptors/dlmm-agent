# Installing Meridian on a New VPS

One-shot bootstrap for any Ubuntu/Debian/RHEL/Fedora VPS. Tested on a clean Ubuntu 22.04 LTS.

---

## Quick Start (one-liner)

On the **fresh VPS**, as a user with `sudo`:

```bash
curl -sSL https://raw.githubusercontent.com/corruptors/dlmm-agent/main/scripts/install.sh | bash
```

What it does:
1. Installs Node.js 20 + git + build tools (if missing) — auto-detects `apt` / `dnf` / `yum`
2. Installs PM2 globally
3. Clones the repo into `~/meridian`
4. Runs `npm install` (triggers `postinstall` anchor patch)
5. Prints next-step instructions

The script is **idempotent** — safe to re-run on partially-configured boxes. Use a custom install dir with `bash install.sh my-dir-name`.

---

## After the Bootstrap

The script halts before the interactive setup. Run these manually:

```bash
cd ~/meridian
npm run setup           # ⮕ interactive wizard (creates .env + user-config.json)
npm run env:encrypt     # OPTIONAL — encrypts .env to .envcrypt at rest
npm run pm2:start       # ⮕ deploy as 24/7 PM2 daemon
```

`pm2:start` registers `meridian` with PM2 and persists across reboots (uses `ecosystem.config.cjs`).

---

## What You'll Need Ready

| Item | Source |
|---|---|
| **Wallet private key (bs58)** | Export from Phantom / Backpack / Solflare |
| **Helius API key** | https://helius.dev (free tier works) |
| **LLM provider URL + key + model** | e.g. OpenRouter (`https://openrouter.ai/api/v1`) + key + `minimax/<model>` |
| **Telegram bot token** | @BotFather on Telegram |
| **Telegram chat ID** | @userinfobot (numeric ID, e.g. `1533328129`) |
| **(Optional) GMGN API key** | https://t.me/gmgngptsbot |
| **SOL in wallet** | Start with ~1 SOL for first deploys + gas |

The setup wizard will prompt for these sequentially.

---

## Manual Install (if you can't use the script)

If `curl | bash` is blocked or you want a hand-rolled setup:

```bash
# 1. Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 git

# 2. PM2
sudo npm i -g pm2

# 3. Clone + install
cd ~
git clone https://github.com/corruptors/dlmm-agent.git meridian
cd meridian
npm install

# 4. Configure
npm run setup

# 5. Deploy
npm run pm2:start
```

RHEL/Fedora users: swap `apt` for `dnf` and the NodeSource URL is `https://rpm.nodesource.com/setup_20.x`.

---

## Post-Install Sanity Checks

```bash
# 1. PM2 health
pm2 list
pm2 jlist | head -5

# 2. Recent logs (last 50 lines, no error filter)
pm2 logs meridian --lines 50 --nostream

# 3. Errors only
pm2 logs meridian --lines 100 --nostream | grep -i -E "error|fail|throw"

# 4. Force one management cycle in DRY_RUN mode (no real trades)
cd ~/meridian
node cli.js manage --dry-run

# 5. Telegram reach: send /start to the bot
```

**Healthy startup banner**:

```
[STARTUP] DLMM LP Agent starting...
[STARTUP] Repo: /root/meridian | cwd: /root/meridian | PM2 id: 0
[STARTUP] Non-TTY mode — starting cron cycles immediately.
[CRON] Cycles started — management every 10m, screening every 30m
[TELEGRAM] Bot polling started
```

---

## Updating a Running VPS

The bot uses PM2 — to pull latest code without losing state:

```bash
cd ~/meridian
git pull                            # pull latest
npm install                         # if package.json changed
pm2 restart meridian --update-env   # graceful restart
pm2 logs meridian --lines 30        # confirm clean startup
```

State files (`state.json`, `pool-memory.json`, `lessons.json`, `decision-log.json`) live in the repo root and are gitignored — they survive `git pull` + `pm2 restart` intact.

---

## Common Operations

```bash
# Stop the bot
pm2 stop meridian

# Start (if stopped but registered)
pm2 start meridian

# Restart (e.g. after config change)
pm2 restart meridian --update-env

# Tail logs live
pm2 logs meridian

# One-shot screening cycle (off-cron)
node cli.js screen

# One-shot management cycle
node cli.js manage

# Reset all stats + restart
pm2 delete meridian
pm2 start meridian
```

---

## File Layout (relevant)

| Path | Purpose | Gitignored? |
|---|---|---|
| `index.js`, `tools/`, `agent.js`, etc. | Source code | **Tracked** |
| `user-config.json` | Per-VPS runtime config (RPC keys, model, telegram IDs) | Yes |
| `.env` / `.envcrypt` | Wallet key, LLM API keys (encrypted option available) | Yes |
| `state.json` | Open position bookkeeping + history | Yes |
| `pool-memory.json` | Per-pool notes & snapshots (adaptive learning) | Yes |
| `lessons.json` | Auto-evolved rules (Darwin) | Yes |
| `strategy-library.json` | User-pasted strategies from Twitter/etc | Yes |
| `decision-log.json` | Recent deploy/close/skip decisions (capped at 100) | Yes |

State lives in JSON files at the repo root. No DB. `git pull` + `pm2 restart` preserves everything except the source code itself.

---

## Troubleshooting

**Bot fails to start with `Cannot find module '@meteora-ag/dlmm'`**
→ Run `npm install` in the repo root.

**Cron cycles running but every cycle says `Screening skipped — insufficient SOL`**
→ Wallet needs SOL. Verify balance directly: `node cli.js wallet`.

**Telegram bot not responding**
→ Check `pm2 logs meridian` for `[TELEGRAM] 401` (bad token) or `[TELEGRAM] polling failed` (network).

**Cron never fires**
→ Confirm PM2 running: `pm2 list`. Bot must be started via `pm2:start` (not `npm start`) for cron to initialize in non-TTY mode.

**Need to change runtime config (e.g. swap LLM provider)**
→ Edit `user-config.json`, then `pm2 restart meridian --update-env`.

---

## Security Notes

- `user-config.json` and `.env` / `.envcrypt` are gitignored — never commit them.
- The repo's git remote uses a deploy PAT; don't share the token.
- Wallet private key lives in `.env` (or `.envcrypt` after running `npm run env:encrypt`). Plain-text mode is readable by anyone with shell access to the VPS.
- Telegram chat ID is your personal one — confirm by sending `/start` to your bot.
