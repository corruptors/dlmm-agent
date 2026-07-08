/**
 * Fee Compounding Script — Meridian DLMM
 * 
 * Claim fees from all open positions and compound them back into
 * the same positions to maximize yield compounding.
 * 
 * Run: node scripts/fee-compound.js
 * Cron: every 30 minutes via PM2
 */

import { getMyPositions, claimFees, addLiquidity } from "../tools/dlmm.js";
import { getWalletBalances } from "../tools/wallet.js";
import { log } from "../logger.js";
import { isEnabled as telegramEnabled, sendMessage } from "../telegram.js";

const MIN_COMPOUND_USD = 1; // minimum fee value to trigger compound

async function main() {
  log("compound", "=== Fee Compounding Cycle ===");
  
  const balances = await getWalletBalances();
  const solBalance = balances.sol || 0;
  log("compound", `Wallet SOL: ${solBalance.toFixed(4)}`);
  
  // Get all open positions
  const portfolio = await getMyPositions({ force: true }).catch(() => null);
  if (!portfolio || portfolio.positions.length === 0) {
    log("compound", "No open positions — skipping");
    return;
  }
  
  log("compound", `Checking ${portfolio.positions.length} position(s) for unclaimed fees...`);
  
  let totalClaimed = 0;
  let totalCompounded = 0;
  const results = [];
  
  for (const pos of portfolio.positions) {
    const unclaimedUsd = pos.unclaimed_fees_usd ?? 0;
    const unclaimedSol = pos.unclaimed_fees_sol ?? 0;
    
    if (unclaimedUsd < MIN_COMPOUND_USD) {
      log("compound", `${pos.pair}: unclaimed ${unclaimedUsd.toFixed(4)} < ${MIN_COMPOUND_USD} — skip`);
      continue;
    }
    
    log("compound", `${pos.pair}: unclaimed ${unclaimedUsd.toFixed(4)} (${unclaimedSol.toFixed(4)} SOL) — claiming...`);
    
    // Step 1: Claim fees
    const claimResult = await claimFees({ position_address: pos.position });
    if (!claimResult.success) {
      log("compound_error", `${pos.pair}: claim failed — ${claimResult.error}`);
      results.push({ pair: pos.pair, status: "claim_failed", error: claimResult.error });
      continue;
    }
    
    const claimedSol = unclaimedSol; // approximate — actual may differ slightly
    log("compound", `${pos.pair}: claimed ${claimedSol.toFixed(4)} SOL, txs: ${(claimResult.txs || []).join(", ")}`);
    totalClaimed += claimedSol;
    
    // Step 2: Compound — add claimed SOL back to the same position
    if (claimedSol > 0.001) { // minimum meaningful amount
      log("compound", `${pos.pair}: compounding ${claimedSol.toFixed(4)} SOL back into position...`);
      
      const addResult = await addLiquidity({
        position_address: pos.position,
        amount_sol: claimedSol,
      });
      
      if (!addResult.success) {
        log("compound_error", `${pos.pair}: compound failed — ${addResult.error}`);
        results.push({ pair: pos.pair, status: "compound_failed", claimed_sol: claimedSol, error: addResult.error });
      } else {
        log("compound", `${pos.pair}: COMPOUNDED ${claimedSol.toFixed(4)} SOL into position, txs: ${(addResult.txs || []).join(", ")}`);
        totalCompounded += claimedSol;
        results.push({ pair: pos.pair, status: "compounded", claimed_sol: claimedSol, txs: addResult.txs });
      }
    } else {
      log("compound", `${pos.pair}: claimed amount too small (${claimedSol.toFixed(4)}) — skipping compound`);
      results.push({ pair: pos.pair, status: "claimed_too_small", claimed_sol: claimedSol });
    }
  }
  
  // Summary
  const summary = `Fee Compounding Done\n\nTotal claimed: ${totalClaimed.toFixed(4)} SOL\nTotal compounded: ${totalCompounded.toFixed(4)} SOL\n\n${results.map(r => {
    if (r.status === "compounded") return `✅ ${r.pair}: +${r.claimed_sol.toFixed(4)} SOL compounded`;
    if (r.status === "claimed_too_small") return `⚠️ ${r.pair}: claimed ${r.claimed_sol.toFixed(4)} SOL (too small to compound)`;
    if (r.status === "claim_failed") return `❌ ${r.pair}: claim failed — ${r.error}`;
    if (r.status === "compound_failed") return `❌ ${r.pair}: compound failed — ${r.error}`;
    return `${r.pair}: unclaimed < ${MIN_COMPOUND_USD}`;
  }).join("\n")}`;

  log("compound", `\n${summary}`);
  
  // Telegram notification
  if (telegramEnabled() && totalCompounded > 0) {
    sendMessage(summary).catch(() => {});
  }
  
  return { totalClaimed, totalCompounded, results };
}

main().catch((e) => {
  log("compound_error", `Fatal: ${e.message}`);
  process.exit(1);
});