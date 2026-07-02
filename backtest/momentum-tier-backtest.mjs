#!/usr/bin/env node
/**
 * Backtest script: empirical pullback distribution per momentum tier.
 *
 * Logic:
 * 1. Fetch large sample of DLMM pools from Meteora
 * 2. Categorize each by momentum tier (extreme/high/moderate/low/minimal) using pool_price_change_pct
 * 3. For each pool, measure "post-peak drawdown" = (max_price - current_price) / max_price
 * 4. Aggregate per tier: median, p75, mean, count
 * 5. Compute recommended tier_modifier based on observed drawdown patterns
 * 6. Output report + machine-readable JSON
 */

import { writeFileSync } from "node:fs";

const POOL_DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag";
const TARGET_POOLS = 800;          // Sample size
const PAGE_SIZE = 50;
const MIN_TVL = 10_000;            // Loose filter — want data, not perfect pools
const MAX_TVL = 500_000;
const MAX_PAGES = Math.ceil(TARGET_POOLS / PAGE_SIZE);

const TIER_BOUNDARIES = [
  { name: "extreme",   minPct: 100, maxPct: Infinity },
  { name: "high",      minPct: 50,  maxPct: 100 },
  { name: "moderate",  minPct: 20,  maxPct: 50 },
  { name: "low",       minPct: 10,  maxPct: 20 },
  { name: "minimal",   minPct: -Infinity, maxPct: 10 },
];

function classifyTier(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  return TIER_BOUNDARIES.find((t) => pct >= t.minPct && pct < t.maxPct)?.name || null;
}

function pctFromPrice(min, current) {
  if (!min || !current || min <= 0 || current <= 0) return null;
  return ((min - current) / min) * 100;  // positive = drawdown from peak
}

async function fetchPage(afterKey = null) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    status: "active",
    min_tvl: String(MIN_TVL),
    max_tvl: String(MAX_TVL),
    page_size: String(PAGE_SIZE),
  });
  if (afterKey) params.set("after_key", afterKey);

  const url = `${POOL_DISCOVERY}/pools?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

async function fetchAll() {
  const pools = [];
  let afterKey = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    try {
      const page = await fetchPage(afterKey);
      if (!page?.data?.length) break;
      pools.push(...page.data);
      afterKey = page.after_key;
      if (!afterKey) break;
      process.stdout.write(`\r  fetched ${pools.length} pools...`);
    } catch (e) {
      console.error(`\n  page ${i} failed: ${e.message}`);
      break;
    }
  }
  console.log(`\n  total fetched: ${pools.length}`);
  return pools;
}

function filterAndEnrich(rawPools) {
  const enriched = [];
  for (const p of rawPools) {
    if (p.pool_type !== "dlmm") continue;
    const yMint = p.token_y?.address;
    const isSolPair = yMint === "So11111111111111111111111111111111111111112";
    if (!isSolPair) continue;
    const organic = Number(p.token_x?.organic_score || 0);
    if (organic < 30) continue;  // Very loose — just want rough data
    const holders = Number(p.base_token_holders || 0);
    if (holders < 100) continue;

    const priceChg = Number(p.pool_price_change_pct);
    const tier = classifyTier(priceChg);
    if (!tier) continue;

    const minP = Number(p.min_price);
    const curP = Number(p.pool_price);
    const maxP = Number(p.max_price);
    const drawdown = pctFromPrice(maxP, curP);
    const recovery = pctFromPrice(minP, curP);
    const range = maxP && minP && minP > 0 ? ((maxP - minP) / minP) * 100 : null;

    enriched.push({
      pool: p.pool_address,
      symbol: p.name,
      binStep: p.dlmm_params?.bin_step ?? null,
      feePct: p.fee_pct,
      priceChangePct: priceChg,
      tier,
      volatility: Number(p.volatility || 0),
      volume: Number(p.volume || 0),
      tvl: Number(p.tvl || 0),
      drawdownPct: drawdown,
      rangePct: range,
      recoveryPct: recovery,
      organic,
      holders,
    });
  }
  return enriched;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function summarize(tier, items) {
  if (!items.length) {
    return { tier, count: 0, message: "no data" };
  }
  const drawdowns = items.map((i) => i.drawdownPct).filter(Number.isFinite);
  const ranges = items.map((i) => i.rangePct).filter(Number.isFinite);
  const vols = items.map((i) => i.volatility).filter(Number.isFinite);
  const changes = items.map((i) => i.priceChangePct).filter(Number.isFinite);

  return {
    tier,
    count: items.length,
    priceChangePct: {
      min: Math.min(...changes).toFixed(2),
      p25: percentile(changes, 0.25)?.toFixed(2),
      median: percentile(changes, 0.5)?.toFixed(2),
      p75: percentile(changes, 0.75)?.toFixed(2),
      max: Math.max(...changes).toFixed(2),
    },
    drawdownFromPeakPct: {
      min: Math.min(...drawdowns).toFixed(2),
      p25: percentile(drawdowns, 0.25)?.toFixed(2),
      median: percentile(drawdowns, 0.5)?.toFixed(2),
      p75: percentile(drawdowns, 0.75)?.toFixed(2),
      max: Math.max(...drawdowns).toFixed(2),
    },
    priceRangePct: {
      median: percentile(ranges, 0.5)?.toFixed(2),
      p75: percentile(ranges, 0.75)?.toFixed(2),
      p90: percentile(ranges, 0.9)?.toFixed(2),
    },
    volatility: {
      median: percentile(vols, 0.5)?.toFixed(2),
      p75: percentile(vols, 0.75)?.toFixed(2),
      max: Math.max(...vols).toFixed(2),
    },
  };
}

function deriveTierModifier(summary) {
  // Logic: if extreme/high tiers have SMALLER drawdown than moderate/low,
  // then narrow bins (negative modifier) for those tiers.
  // Modifier scale: every 5% of pullback difference = ~10 bins adjustment.
  //
  // Baseline = minimal tier median drawdown (lowest momentum = widest expected range)
  // For other tiers, modifier = -((baseline_drawdown - tier_drawdown) / 5) * 10

  if (!summary?.drawdownFromPeakPct) return null;
  const baseMedian = Number(summary.drawdownFromPeakPct.median);
  const baseP75 = Number(summary.drawdownFromPeakPct.p75);
  return {
    baseline: summary.tier,
    baselineDrawdownMedian: baseMedian,
    baselineDrawdownP75: baseP75,
    // Modifiers using median drawdown as anchor
    modifiersMedian: {
      extreme: tierMod(baseMedian, baseMedian - 5),  // assume even smaller
      high: tierMod(baseMedian, baseMedian - 3),
      moderate: tierMod(baseMedian, baseMedian - 1),
      low: tierMod(baseMedian, baseMedian),
      minimal: 0,
    },
  };
}

function tierMod(baselineMedian, assumedTierMedian) {
  const delta = baselineMedian - assumedTierMedian;
  return Math.round(-(delta / 5) * 10);
}

async function main() {
  console.log("🚀 Meteora DLMM Momentum Tier Backtest\n");
  console.log(`Target: ${TARGET_POOLS} pools | TVL ${MIN_TVL}-${MAX_TVL} | SOL pairs only\n`);

  const rawPools = await fetchAll();
  if (!rawPools.length) {
    console.error("❌ No pools fetched");
    process.exit(1);
  }

  console.log("\n📊 Filtering & enriching...");
  const enriched = filterAndEnrich(rawPools);
  console.log(`  valid samples: ${enriched.length}`);

  const byTier = {};
  for (const item of enriched) {
    (byTier[item.tier] ||= []).push(item);
  }

  console.log("\n" + "═".repeat(70));
  console.log("TIER DISTRIBUTION");
  console.log("═".repeat(70));
  for (const { name } of TIER_BOUNDARIES) {
    console.log(`  ${name.padEnd(10)} ${(byTier[name]?.length || 0).toString().padStart(4)} pools`);
  }

  console.log("\n" + "═".repeat(70));
  console.log("DRAWDOWN DISTRIBUTION PER TIER (% drop from max_price)");
  console.log("═".repeat(70));
  const summaries = [];
  for (const { name } of TIER_BOUNDARIES) {
    const items = byTier[name] || [];
    const s = summarize(name, items);
    summaries.push(s);
    if (items.length === 0) {
      console.log(`\n${name.toUpperCase()} (n=0): no data`);
      continue;
    }
    console.log(
      `\n${name.toUpperCase()} (n=${items.length}):`
    );
    console.log(`  price_change_pct:    median ${s.priceChangePct.median}  p75 ${s.priceChangePct.p75}`);
    console.log(`  drawdown_from_peak:  median ${s.drawdownFromPeakPct.median}  p75 ${s.drawdownFromPeakPct.p75}  max ${s.drawdownFromPeakPct.max}`);
    console.log(`  price_range_pct:     median ${s.priceRangePct.median}  p75 ${s.priceRangePct.p75}  p90 ${s.priceRangePct.p90}`);
    console.log(`  volatility:          median ${s.volatility.median}  p75 ${s.volatility.p75}`);
  }

  // Empirical tier modifier recommendations
  console.log("\n" + "═".repeat(70));
  console.log("EMPIRICAL TIER MODIFIER RECOMMENDATIONS");
  console.log("═".repeat(70));

  // Use moderate tier as baseline (middle of distribution)
  const moderateSum = summaries.find((s) => s.tier === "moderate");
  const highSum = summaries.find((s) => s.tier === "high");
  const extremeSum = summaries.find((s) => s.tier === "extreme");
  const lowSum = summaries.find((s) => s.tier === "low");
  const minimalSum = summaries.find((s) => s.tier === "minimal");

  function safeNum(s, p) {
    const v = s?.drawdownFromPeakPct?.[p];
    return v != null ? Number(v) : null;
  }

  // Hypothesis: high momentum → smaller drawdown → narrower bins (negative modifier)
  const baselineMedian = safeNum(moderateSum, "median") || 20;
  const extremeMedian = safeNum(extremeSum, "median") ?? baselineMedian;
  const highMedian = safeNum(highSum, "median") ?? baselineMedian;
  const lowMedian = safeNum(lowSum, "median") ?? baselineMedian;
  const minimalMedian = safeNum(minimalSum, "median") ?? baselineMedian;

  // Compute modifier based on drawdown delta from moderate baseline
  function mod(tierMedian) {
    const delta = tierMedian - baselineMedian;
    // every 1% less drawdown → -2 bins (narrower)
    return Math.round(-delta * 2);
  }

  const modifiers = {
    extreme: mod(extremeMedian),
    high: mod(highMedian),
    moderate: 0,
    low: mod(lowMedian),
    minimal: mod(minimalMedian),
  };

  console.log(`\nBaseline (moderate) median drawdown: ${baselineMedian}%`);
  console.log("\nRecommended tier modifiers (negative = narrower bins):");
  console.log("  ┌─────────┬──────────────┬────────────┐");
  console.log("  │ Tier    │ Median DD %  │ Modifier   │");
  console.log("  ├─────────┼──────────────┼────────────┤");
  for (const [tier, mod] of Object.entries(modifiers)) {
    const dd = tier === "extreme" ? extremeMedian
      : tier === "high" ? highMedian
      : tier === "low" ? lowMedian
      : tier === "minimal" ? minimalMedian
      : baselineMedian;
    console.log(`  │ ${tier.padEnd(7)} │ ${dd.toFixed(2).padStart(12)} │ ${(mod >= 0 ? "+" : "") + mod.toString().padStart(10)} │`);
  }
  console.log("  └─────────┴──────────────┴────────────┘");

  // Validation: is hypothesis supported?
  console.log("\n" + "═".repeat(70));
  console.log("HYPOTHESIS VALIDATION");
  console.log("═".repeat(70));
  console.log("\nHypothesis: 'Stronger momentum → smaller drawdown → narrower bins'");
  const monotonic =
    extremeMedian <= highMedian &&
    highMedian <= moderateMedian &&
    moderateMedian <= lowMedian &&
    lowMedian <= minimalMedian + 5;  // allow slight noise
  console.log(`  Monotonic drawdown by tier: ${monotonic ? "✓ SUPPORTED" : "✗ NOT SUPPORTED (noisy data)"}`);
  console.log(`    extreme (${extremeMedian}) ≤ high (${highMedian}) ≤ moderate (${baselineMedian}) ≤ low (${lowMedian}) ≤ minimal (${minimalMedian})`);

  // Volume confirmation heuristic
  console.log("\n" + "═".repeat(70));
  console.log("VOLUME CONFIRMATION HEURISTIC");
  console.log("═".repeat(70));
  const highMomentumItems = [...(byTier.extreme || []), ...(byTier.high || [])];
  const highMomentumLowVolume = highMomentumItems.filter((i) => i.tvl > 0 && (i.volume / i.tvl) < 0.5);
  const highMomentumHighVolume = highMomentumItems.filter((i) => i.tvl > 0 && (i.volume / i.tvl) >= 0.5);
  console.log(`  High-momentum pools with volume/TVL < 0.5: ${highMomentumLowVolume.length}/${highMomentumItems.length}`);
  console.log(`  High-momentum pools with volume/TVL ≥ 0.5: ${highMomentumHighVolume.length}/${highMomentumItems.length}`);
  console.log(`  → Recommendation: filter threshold = volume/TVL >= ${(0.5).toFixed(2)}`);

  // Save JSON output
  const output = {
    timestamp: new Date().toISOString(),
    sampleSize: enriched.length,
    poolCounts: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, v.length])),
    summaries,
    recommendedModifiers: modifiers,
    baselineDrawdownMedian: baselineMedian,
    hypothesisSupported: monotonic,
    volumeFilter: 0.5,
  };
  writeFileSync(
    "/root/meridian/backtest/momentum-tier-results.json",
    JSON.stringify(output, null, 2),
  );
  console.log(`\n✅ Results saved to /root/meridian/backtest/momentum-tier-results.json`);
}

main().catch((e) => {
  console.error("❌ Backtest failed:", e);
  process.exit(1);
});