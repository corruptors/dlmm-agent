/**
 * Intelligence Module — Smart Pool Analysis Toolkit
 *
 * Phase 1 (T1, T5, T9):  Implemented
 *   T1: Pool Fee Efficiency Ranking  — fees per unit of IL risk
 *   T5: Leave Pool Alert             — detect dying positions
 *   T9: PVP Alert (enhanced)         — score competitor risk
 *
 * Phase 2 (T4, T6, T7): Stubbed (interface ready)
 *   T4: Concentration Risk Alert     — TVL spike / top-10 share
 *   T6: PNL Curve Simulator          — PNL at every price point
 *   T7: Range Survival Predictor     — % chance of staying in range
 *
 * Phase 3 (T2, T3): Stubbed (heavy build, future)
 *   T2: Pool Simulator               — Monte Carlo price walk
 *   T3: Optimal Bin/Fee Calculator   — heuristic engine
 *
 * Phase 4 (T8): Stubbed (webhook infra, future)
 *   T8: Clipper Alerts               — large holder sell detection
 */

import { log } from "../logger.js";
import { config } from "../config.js";

// ─── T1: Pool Fee Efficiency Ranking ────────────────────────────

/**
 * Calculate fee efficiency score: fees earned per unit of IL risk.
 * Higher = better. Range: typically 0 - 100+.
 *
 * Formula: fee_tvl_ratio / (volatility * sqrt(bin_step))
 * - vol: pool volatility (higher = more IL risk)
 * - bin_step: discrete price steps (wider = more IL per step)
 *
 * @param {Object} pool  Pool data with fee_tvl_ratio, volatility, bin_step
 * @returns {Object} { efficiency: number, grade: 'S'|'A'|'B'|'C'|'D', reason: string }
 */
export function calculateFeeEfficiency(pool) {
  const feeTvl = Number(pool.fee_tvl_ratio ?? pool.fee_active_tvl_ratio ?? 0);
  const vol = Math.max(Number(pool.volatility ?? 0.1), 0.1);
  const binStep = Math.max(Number(pool.bin_step ?? 1), 1);

  // Volatility-adjusted fee efficiency
  // Higher fee/TVL is good, higher vol is bad
  const rawScore = feeTvl / (vol * Math.sqrt(binStep));

  // Grade
  let grade;
  if (rawScore >= 50) grade = "S";
  else if (rawScore >= 20) grade = "A";
  else if (rawScore >= 10) grade = "B";
  else if (rawScore >= 3) grade = "C";
  else grade = "D";

  const reason =
    rawScore >= 20
      ? "Strong fee/IL ratio — good risk-adjusted yield"
      : rawScore >= 10
      ? "Acceptable fee/IL ratio"
      : rawScore >= 3
      ? "Marginal — high IL risk relative to fees"
      : "Poor — fees don't justify IL risk";

  return { efficiency: Number(rawScore.toFixed(2)), grade, reason };
}

/**
 * Enhanced candidate scorer: combines existing formula with fee efficiency.
 * Drop-in replacement for the original scoreCandidate function.
 */
export function enhancedScoreCandidate(pool) {
  const feeTvl = Number(pool.fee_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  const baseScore = feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;

  // Boost based on fee efficiency grade
  const eff = calculateFeeEfficiency(pool);
  let boost = 0;
  if (eff.grade === "S") boost = baseScore * 0.5;
  else if (eff.grade === "A") boost = baseScore * 0.25;
  else if (eff.grade === "B") boost = baseScore * 0.1;
  else if (eff.grade === "D") boost = -baseScore * 0.2; // penalty

  return {
    base: baseScore,
    efficiency: eff.efficiency,
    grade: eff.grade,
    total: baseScore + boost,
    reason: eff.reason,
  };
}

// ─── T5: Leave Pool Alert ────────────────────────────────────────

/**
 * Determine if a position should be closed based on health signals.
 * Compares current metrics against entry baseline.
 *
 * @param {Object} position  Current position state (from getMyPositions)
 * @param {Object} entryState  Entry baseline (fees, volume, TVL at open)
 * @returns {Object} { leave: bool, reason: string, severity: 'info'|'warn'|'critical' }
 */
export function shouldLeavePool(position, entryState = {}) {
  if (!position) return { leave: false, reason: "no position", severity: "info" };

  const signals = [];
  let severity = "info";

  // 1. OOR already — should leave
  if (position.in_range === false) {
    return {
      leave: true,
      reason: `Position is out of range (${position.minutes_out_of_range}m)`,
      severity: "critical",
    };
  }

  // 2. Fee collapse — current fees < 30% of entry
  const currentFees = Number(position.unclaimed_fees_usd || 0) +
                      Number(position.collected_fees_usd || 0);
  const entryFees = Number(entryState.fees_at_entry || 1);
  if (entryState.fees_at_entry != null && currentFees < entryFees * 0.3) {
    signals.push(`Fees collapsed: $${currentFees.toFixed(2)} < 30% of entry ($${entryFees.toFixed(2)})`);
    severity = "critical";
  }

  // 3. Volume death — current 24h volume < 20% of pool's avg
  const currentVolume = Number(position.pool_24h_volume || 0);
  const poolAvgVolume = Number(position.pool_avg_volume_24h || 0);
  if (poolAvgVolume > 0 && currentVolume < poolAvgVolume * 0.2) {
    signals.push(`Volume dying: $${currentVolume.toFixed(0)} < 20% of pool avg`);
    if (severity !== "critical") severity = "warn";
  }

  // 4. Competition rising — TVL up > 50% since entry
  const currentTvl = Number(position.pool_tvl || 0);
  const entryTvl = Number(entryState.tvl_at_entry || 0);
  if (entryTvl > 0 && currentTvl > entryTvl * 1.5) {
    signals.push(`TVL surged: $${currentTvl.toFixed(0)} > 150% of entry ($${entryTvl.toFixed(0)}) — fee share diluted`);
    if (severity !== "critical") severity = "warn";
  }

  // 5. PnL approaching stop-loss (use existing rule)
  const pnlPct = Number(position.pnl_pct || 0);
  if (pnlPct <= -15) {
    signals.push(`PnL at ${pnlPct.toFixed(1)}% — approaching SL -18%`);
    severity = "critical";
  }

  // 6. Take-profit reached
  if (pnlPct >= 12) {
    return {
      leave: true,
      reason: `Take-profit target reached: +${pnlPct.toFixed(1)}%`,
      severity: "info",
    };
  }

  return {
    leave: signals.length >= 2 || severity === "critical",
    reason: signals.length ? signals.join("; ") : "Position healthy",
    severity,
    signals,
  };
}

// ─── T9: PVP Alert (Enhanced) ────────────────────────────────────

/**
 * Calculate PVP risk score for a pool.
 * Returns a 0-100 score where 100 = highest competition risk.
 *
 * @param {Object} pool  Pool data with is_pvp, pvp_rival_tvl, etc.
 * @returns {Object} { score: number, level: 'low'|'medium'|'high'|'extreme', recommendation: string }
 */
export function calculatePvpRisk(pool) {
  let score = 0;
  const reasons = [];

  // Has explicit rival pool
  if (pool.is_pvp && pool.pvp_rival_tvl) {
    const rivalTvl = Number(pool.pvp_rival_tvl);
    const ourTvl = Number(pool.tvl || 0);
    if (rivalTvl > ourTvl * 2) {
      score += 50;
      reasons.push(`Rival pool TVL 2x ours ($${rivalTvl.toFixed(0)} vs $${ourTvl.toFixed(0)})`);
    } else if (rivalTvl > 0) {
      score += 30;
      reasons.push(`Rival pool exists ($${rivalTvl.toFixed(0)} TVL)`);
    }
  }

  // Bot holders — high bot % means MEV/bot competition
  const botHolders = Number(pool.max_bot_holders_pct ?? pool.bot_holders_pct ?? 0);
  if (botHolders > 30) {
    score += 20;
    reasons.push(`High bot holders: ${botHolders.toFixed(0)}%`);
  }

  // Top-10 concentration — fewer holders, more concentrated = more competitive
  const top10 = Number(pool.max_top10_pct ?? pool.top10_pct ?? 0);
  if (top10 > 50) {
    score += 15;
    reasons.push(`Top-10 holders: ${top10.toFixed(0)}%`);
  }

  // Clamp
  score = Math.min(score, 100);

  let level, recommendation;
  if (score >= 70) {
    level = "extreme";
    recommendation = "AVOID — too competitive, fees will be eaten by rivals";
  } else if (score >= 40) {
    level = "high";
    recommendation = "CAUTION — consider smaller deploy, monitor closely";
  } else if (score >= 20) {
    level = "medium";
    recommendation = "Acceptable — standard competition";
  } else {
    level = "low";
    recommendation = "Good — low competition expected";
  }

  return { score, level, recommendation, reasons };
}

// ─── T4: Concentration Risk Alert (STUB) ─────────────────────────

/**
 * Monitor concentration risk — TVL spike, top-10 holder share changes.
 * TODO: implement real-time monitoring via Helius + Meteora streaming.
 */
export function calculateConcentrationRisk(pool) {
  // Stub: returns placeholder until full implementation
  const top10 = Number(pool.max_top10_pct ?? pool.top10_pct ?? 0);
  const botPct = Number(pool.max_bot_holders_pct ?? pool.bot_holders_pct ?? 0);
  let level = "low";
  if (top10 > 60 || botPct > 40) level = "high";
  else if (top10 > 40 || botPct > 25) level = "medium";
  return {
    level,
    top10_pct: top10,
    bot_pct: botPct,
    note: "Stub — full implementation in Phase 2",
  };
}

// ─── T6: PNL Curve Simulator (STUB) ──────────────────────────────

/**
 * Simulate PNL curve for a position at various price points.
 * TODO: implement using existing position's bin liquidity + IL math.
 */
export function simulatePnlCurve(position) {
  // Stub: returns placeholder
  return {
    note: "Stub — full implementation in Phase 2",
    current_value: position?.total_value_usd || 0,
    current_pnl_pct: position?.pnl_pct || 0,
  };
}

// ─── T7: Range Survival Predictor (STUB) ─────────────────────────

/**
 * Predict probability of position staying in range for N hours.
 * TODO: implement using volatility stats + range width.
 */
export function predictRangeSurvival(volatility, rangeWidth, hours = 24) {
  // Stub: rough heuristic based on volatility and range
  const vol = Math.max(Number(volatility || 0.1), 0.01);
  const width = Math.max(Number(rangeWidth || 0.05), 0.01);
  // Naive: narrower range + higher vol = lower survival
  const survival24h = Math.min(Math.max(100 - (vol / width) * 50, 5), 99);
  return {
    survival_24h_pct: Number(survival24h.toFixed(1)),
    note: "Stub — full implementation in Phase 2 (currently naive heuristic)",
  };
}

// ─── T2: Pool Simulator (STUB) ───────────────────────────────────

/**
 * Simulate pool performance under various scenarios.
 * TODO: implement Monte Carlo with price walks + IL + fee accrual.
 */
export async function simulatePool(pool, params = {}) {
  return {
    note: "Stub — full implementation in Phase 3",
    estimated_apr: 0,
    estimated_il: 0,
    estimated_fees: 0,
    sharpe_like_score: 0,
  };
}

// ─── T3: Optimal Bin/Fee Calculator (STUB) ───────────────────────

/**
 * Suggest optimal bin step and fee tier based on pool metrics.
 * TODO: implement heuristic engine from historical data.
 */
export function calculateOptimalBin(metrics = {}) {
  const { mcap, volume, volatility, tvl } = metrics;
  // Stub: very rough heuristic
  const vol = Number(volatility || 5);
  let suggestedBinStep = 20;
  if (vol > 30) suggestedBinStep = 80;
  else if (vol > 15) suggestedBinStep = 50;
  else if (vol > 8) suggestedBinStep = 25;
  else suggestedBinStep = 10;

  return {
    suggested_bin_step: suggestedBinStep,
    note: "Stub — full implementation in Phase 3",
  };
}

// ─── T8: Clipper Alerts (STUB) ──────────────────────────────────

/**
 * Set up large-holder sell detection for a token.
 * TODO: implement Helius webhook + holder monitoring.
 */
export async function setupClipperMonitor(mint, options = {}) {
  return {
    note: "Stub — full implementation in Phase 4 (needs Helius webhook setup)",
    mint,
    monitoring: false,
  };
}

// ─── Aggregate Intelligence Report ───────────────────────────────

/**
 * Generate a full intelligence report for a pool.
 * Combines all available analyses.
 */
export function getPoolIntelligence(pool) {
  return {
    fee_efficiency: calculateFeeEfficiency(pool),
    pvp_risk: calculatePvpRisk(pool),
    concentration: calculateConcentrationRisk(pool),
    enhanced_score: enhancedScoreCandidate(pool),
  };
}
