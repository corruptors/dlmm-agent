/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const BLACKLIST_FILE = repoPath("token-blacklist.json");

function load() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch (error) {
    log("blacklist_error", `Invalid ${BLACKLIST_FILE}: ${error.message}`);
    throw new Error(`Safety blacklist is unreadable: ${BLACKLIST_FILE}`);
  }
}

function save(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist.
 * Used in screening.js before returning pools to the LLM.
 */
export function isBlacklisted(mint) {
  if (!mint) return false;
  const db = load();
  return !!db[mint];
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({ mint, symbol, reason }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (db[mint]) {
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
    };
  }

  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  save(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist() {
  const db = load();
  const entries = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}

// ─── Auto-blacklist with Expiry ──────────────────────────────────

/**
 * Add to blacklist with automatic expiry (e.g., 30 days).
 * Used by auto-blacklist-on-3-losses logic.
 */
export function addToBlacklistWithExpiry({ mint, symbol, reason, days = 30 }) {
  if (!mint) return { error: "mint required" };
  const db = load();
  if (db[mint]) return { already_blacklisted: true, mint };

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "auto-loss-blacklist",
    expires_at: expiresAt.toISOString(),
  };
  save(db);
  log("blacklist", `Auto-blacklisted ${symbol || mint} for ${days} days: ${reason}`);
  return { blacklisted: true, mint, symbol, reason, expires_at: expiresAt.toISOString() };
}

/**
 * Check blacklist with expiry support.
 * Returns false if entry has expired (auto-cleanup).
 */
export function isBlacklistedWithExpiry(mint) {
  if (!mint) return false;
  const db = load();
  const entry = db[mint];
  if (!entry) return false;
  if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
    // Auto-cleanup expired entries
    delete db[mint];
    save(db);
    log("blacklist", `Expired blacklist entry removed: ${mint}`);
    return false;
  }
  return true;
}
