/**
 * Discord webhook notifier — filtered events only (deploy, close, PnL alerts, OOR).
 * Embeds with color coding: green=profit, red=loss, yellow=warning, blue=info.
 * Fire-and-forget: never blocks main loop.
 */

import { log } from "./logger.js";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

const COLORS = {
  info:     0x3498db, // blue
  success:  0x2ecc71, // green
  profit:   0x2ecc71, // green
  loss:     0xe74c3c, // red
  warning:  0xf39c12, // amber
  neutral:  0x95a5a6, // gray
};

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log("discord_error", `Webhook ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (e) {
    log("discord_error", `Webhook failed: ${e.message}`);
  }
}

function embed(title, description, color, fields = []) {
  return {
    embeds: [{
      title,
      description,
      color,
      fields: fields.length > 0 ? fields : undefined,
      timestamp: new Date().toISOString(),
    }],
  };
}

// ─── Public API ────────────────────────────────────────────────────

export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  const fields = [
    { name: "Amount",     value: `${amountSol} SOL`, inline: true },
    { name: "Bin Step",   value: `${binStep ?? "?"}`, inline: true },
    { name: "Base Fee",   value: `${baseFee != null ? baseFee + "%" : "?"}`, inline: true },
  ];
  if (priceRange) {
    const min = priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6);
    const max = priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6);
    fields.push({ name: "Price Range", value: `${min} — ${max}`, inline: false });
  }
  if (rangeCoverage) {
    fields.push({ name: "Coverage", value: `↓${rangeCoverage.downside_pct?.toFixed(1)}% | ↑${rangeCoverage.upside_pct?.toFixed(1)}% | Total ${rangeCoverage.width_pct?.toFixed(1)}%`, inline: false });
  }
  if (position) fields.push({ name: "Position", value: `\`${position.slice(0, 12)}...\``, inline: true });
  if (tx)        fields.push({ name: "Tx", value: `\`${tx.slice(0, 16)}...\``, inline: true });

  await postWebhook(embed(`✅ Deployed ${pair}`, "", COLORS.info, fields));
}

export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  const isProfit = (pnlUsd ?? 0) >= 0;
  const sign = isProfit ? "+" : "";
  const emoji = isProfit ? "🟢" : "🔴";
  const color = isProfit ? COLORS.profit : COLORS.loss;

  await postWebhook(embed(
    `${emoji} Closed ${pair}`,
    `**PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)**`,
    color,
  ));
}

export async function notifyPnlAlert({ pair, prevPnl, curPnl, totalValueUsd, unclaimedFeesUsd, type }) {
  const isProfit = type === "profit";
  const emoji = isProfit ? "🚀" : "⚠️";
  const color = isProfit ? COLORS.profit : COLORS.warning;
  const label = isProfit ? "PROFIT ALERT" : "LOSS ALERT";

  await postWebhook(embed(
    `${emoji} ${label} — ${pair}`,
    `**${prevPnl.toFixed(2)}% → ${curPnl.toFixed(2)}%**`,
    color,
    [
      { name: "Value",  value: `$${(totalValueUsd ?? 0).toFixed(2)}`, inline: true },
      { name: "Fees",   value: `$${(unclaimedFeesUsd ?? 0).toFixed(4)}`, inline: true },
    ],
  ));
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  await postWebhook(embed(
    `⚠️ Out of Range — ${pair}`,
    `Been OOR for **${minutesOOR} minutes**`,
    COLORS.warning,
  ));
}
