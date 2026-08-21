/**
 * §9.9z corridor rule — proper test (pre-registered failure criteria in
 * notes/2026-08-03-corridor-validation-prereg.md).
 *
 * Long history, crypto + forex + indices, 1h/4h/1D, time-split OOS.
 * No threshold. Report shape: count, total, avg, worstNet, p5 net.
 *
 *   node scripts/measure-corridor-validation.mjs
 */
import fs from "node:fs";

// ENGINE=0803 runs the whole measurement on the engine as it stood before
// 3 August, the one the original corridor result was measured with. Both files
// are swapped together and never mixed: trader.js imports contactEvents from
// rope.js beside it, so swapping only one would produce a chimera whose numbers
// belong to neither engine.
//
// MEASURED 2026-08-21: ENGINE=0803 CANNOT run this measurement, and that is
// itself a finding. The pre-August trader emits trades as {from,to,dir,entry,
// exit,pnl,fee} - no `net`, and no `corridorGroup` at all, because the
// corridor classification did not exist yet. The script and the engine
// co-evolved, so the August result was produced by a pairing that no longer
// exists. The switch is kept for a future engine of the same shape, and it
// fails loudly rather than quietly producing a chimera.
const ENGINE_DIR = process.env.ENGINE === "0803" ? "../site/engine-0803" : "../site/engine";
const {
  computeFabric,
  computeATR,
  detectRopes,
  resolvePeriods,
  barMsOf,
  DEFAULT_CFG,
} = await import(`${ENGINE_DIR}/rope.js`);
const { runInstrument, DEFAULT_TRADE } = await import(`${ENGINE_DIR}/trader.js`);

const MAX_DAYS = Number(process.env.MAX_DAYS || 180);
const PROG = process.env.PROGRESS_LOG || "notes/2026-08-03-corridor-validation.progress.log";
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(PROG, line);
  process.stderr.write(line);
}

import { INSTRUMENTS, TFS, loadSeries } from "./lib/series.mjs";

const command = "node scripts/measure-corridor-validation.mjs";
const MIN_BOTH = 5; // min trades per group to count toward pass/fail

fs.writeFileSync(PROG, "");
log(`start command=${command}`);

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

function stats(trades) {
  const nets = trades.map((t) => t.net);
  const n = nets.length;
  if (!n) {
    return {
      count: 0, totalNet: 0, avgNet: null, worstNet: null, p5Net: null,
    };
  }
  const sorted = [...nets].sort((a, b) => a - b);
  const total = nets.reduce((s, x) => s + x, 0);
  return {
    count: n,
    totalNet: +total.toFixed(4),
    avgNet: +(total / n).toFixed(4),
    worstNet: +Math.min(...nets).toFixed(4),
    p5Net: +percentile(sorted, 0.05).toFixed(4),
  };
}

function hasRopeGroup(t) {
  return t.corridorGroup === "rope-too-close" || t.corridorGroup === "rope-with-room";
}

function splitIS_OOS(trades, candles, splitT) {
  const is = [], oos = [];
  for (const t of trades) {
    const openT = candles[t.from]?.t;
    if (openT == null) continue;
    if (openT < splitT) is.push(t);
    else oos.push(t);
  }
  return { is, oos };
}

function cellReport(trades) {
  const noRope = trades.filter((t) => t.corridorGroup === "no-rope-in-scan");
  const hasRope = trades.filter(hasRopeGroup);
  return {
    all: stats(trades),
    noRope: stats(noRope),
    hasRope: stats(hasRope),
    // Tail direction: noRope worse if worst (and p5) more negative
    adequate: noRope.length >= MIN_BOTH && hasRope.length >= MIN_BOTH,
    worstNoRopeWorse: noRope.length && hasRope.length
      ? Math.min(...noRope.map((t) => t.net)) < Math.min(...hasRope.map((t) => t.net))
      : null,
    p5NoRopeWorse: noRope.length && hasRope.length
      ? percentile([...noRope.map((t) => t.net)].sort((a, b) => a - b), 0.05) <
        percentile([...hasRope.map((t) => t.net)].sort((a, b) => a - b), 0.05)
      : null,
  };
}

function runCell(candles, atr, ropes, barMs, require) {
  return runInstrument(candles, atr, ropes, {
    ...DEFAULT_TRADE,
    startBalance: 10000,
    pauseMode: "hold",
    fundingRates: null, // cross-class parity
    barMs,
    requireRopeInScan: require,
    minRoomMul: 0,
    minTargetRiskRatio: 0,
    minPotentialMul: 0,
    historyForm: null,
  });
}

const cells = [];
const loadErrors = [];

for (const inst of INSTRUMENTS) {
  for (const tf of TFS) {
    const label = `${inst.id}/${tf.key}`;
    log(`loading ${label}`);
    let candles;
    try {
      candles = await loadSeries(inst, tf, log);
    } catch (e) {
      loadErrors.push({ id: inst.id, tf: tf.key, error: String(e.message || e) });
      log(`FAIL load ${label}: ${e.message}`);
      continue;
    }
    if (candles.length < 200) {
      loadErrors.push({ id: inst.id, tf: tf.key, error: `too few candles: ${candles.length}` });
      log(`skip ${label}: n=${candles.length}`);
      continue;
    }

    const barMs = barMsOf(tf.barKey);
    const tDetect0 = Date.now();
    const resolved = resolvePeriods(candles, { maxDays: MAX_DAYS, barMs });
    const fabric = computeFabric(candles, { periods: resolved.periods });
    const atr = computeATR(candles);
    const ropes = detectRopes(fabric, candles, atr, {
      ...DEFAULT_CFG,
      mode: "lookback",
      barMs,
      maxDays: MAX_DAYS,
    });

    const splitT = candles[0].t + (candles.at(-1).t - candles[0].t) / 2;
    const spanDays = (candles.at(-1).t - candles[0].t) / 864e5;

    log(
      `${label} n=${candles.length} span=${spanDays.toFixed(1)}d ropes=${ropes.length} ` +
        `detectMs=${Date.now() - tDetect0} split=${new Date(splitT).toISOString().slice(0, 10)}`,
    );

    // Unfiltered — geometry groups (rule absent as a gate; still classify)
    const raw = runCell(candles, atr, ropes, barMs, false);
    const { is: isTrades, oos: oosTrades } = splitIS_OOS(raw.trades, candles, splitT);

    // Rule on — require rope in scan
    const gated = runCell(candles, atr, ropes, barMs, true);
    const gatedSplit = splitIS_OOS(gated.trades, candles, splitT);

    cells.push({
      id: inst.id,
      cls: inst.cls,
      source: inst.source,
      route: inst.route,
      symbol: inst.symbol,
      tf: tf.key,
      nCandles: candles.length,
      from: new Date(candles[0].t).toISOString(),
      to: new Date(candles.at(-1).t).toISOString(),
      spanDays: +spanDays.toFixed(2),
      splitAt: new Date(splitT).toISOString(),
      nRopes: ropes.length,
      effMaxDays: resolved.effMaxDays,
      unfiltered: {
        is: cellReport(isTrades),
        oos: cellReport(oosTrades),
        all: cellReport(raw.trades),
      },
      ruleOn: {
        is: stats(gatedSplit.is),
        oos: stats(gatedSplit.oos),
        all: stats(gated.trades),
        nSkipped: gated.nSkippedCorridor,
      },
    });
  }
}

// --- Pass/fail aggregation (pre-registered) ---
function evaluate(splitKey) {
  const rows = [];
  for (const c of cells) {
    const rep = c.unfiltered[splitKey];
    if (!rep.adequate) continue;
    rows.push({
      id: c.id,
      cls: c.cls,
      tf: c.tf,
      worstNoRopeWorse: rep.worstNoRopeWorse,
      p5NoRopeWorse: rep.p5NoRopeWorse,
      noRope: rep.noRope,
      hasRope: rep.hasRope,
    });
  }
  const worstOk = rows.filter((r) => r.worstNoRopeWorse === true).length;
  const p5Ok = rows.filter((r) => r.p5NoRopeWorse === true).length;
  const byCls = {};
  for (const r of rows) {
    if (!byCls[r.cls]) byCls[r.cls] = { n: 0, worstOk: 0, p5Ok: 0 };
    byCls[r.cls].n += 1;
    if (r.worstNoRopeWorse) byCls[r.cls].worstOk += 1;
    if (r.p5NoRopeWorse) byCls[r.cls].p5Ok += 1;
  }
  return {
    nAdequateCells: rows.length,
    worstTailConsistent: rows.length ? worstOk / rows.length : null,
    p5TailConsistent: rows.length ? p5Ok / rows.length : null,
    byClass: byCls,
    cells: rows,
  };
}

const evalIS = evaluate("is");
const evalOOS = evaluate("oos");
const evalAll = evaluate("all");

const cryptoOOS = evalOOS.byClass.crypto;
const forexOOS = evalOOS.byClass.forex;
const indexOOS = evalOOS.byClass.index;

const failReasons = [];
// 1. not consistently worse across symbols (use OOS primary; also check all)
if (evalOOS.nAdequateCells === 0 && evalAll.nAdequateCells === 0) {
  failReasons.push("no adequate cells (both groups ≥5) — cannot confirm");
} else {
  const rate = evalOOS.nAdequateCells
    ? evalOOS.worstTailConsistent
    : evalAll.worstTailConsistent;
  const n = evalOOS.nAdequateCells || evalAll.nAdequateCells;
  if (rate != null && rate < 0.8) {
    failReasons.push(
      `worstNet direction consistency ${rate.toFixed(2)} on ${n} adequate cells (<0.80)`,
    );
  }
}
// 2. vanishes OOS
if (evalIS.nAdequateCells > 0 && evalOOS.nAdequateCells > 0) {
  if (evalIS.worstTailConsistent >= 0.8 && evalOOS.worstTailConsistent < 0.8) {
    failReasons.push(
      `effect vanishes OOS (IS worst-consistency ${evalIS.worstTailConsistent.toFixed(2)}, OOS ${evalOOS.worstTailConsistent.toFixed(2)})`,
    );
  }
} else if (evalIS.nAdequateCells > 0 && evalOOS.nAdequateCells === 0) {
  failReasons.push("OOS has no adequate cells — cannot confirm OOS survival");
}
// 3. crypto only
const nonCryptoOOS = [
  ...(forexOOS ? [forexOOS] : []),
  ...(indexOOS ? [indexOOS] : []),
];
const nonCryptoN = nonCryptoOOS.reduce((s, x) => s + x.n, 0);
const nonCryptoOk = nonCryptoOOS.reduce((s, x) => s + x.worstOk, 0);
if (cryptoOOS && cryptoOOS.n > 0 && cryptoOOS.worstOk / cryptoOOS.n >= 0.8) {
  if (nonCryptoN === 0) {
    failReasons.push("no adequate forex/index OOS cells — crypto-only unfalsifiable on breadth");
  } else if (nonCryptoOk / nonCryptoN < 0.8) {
    failReasons.push(
      `holds on crypto OOS but not on forex/index (${nonCryptoOk}/${nonCryptoN} non-crypto cells)`,
    );
  }
}

const verdict = failReasons.length
  ? { pass: false, failReasons }
  : { pass: true, failReasons: [] };

const out = {
  test: "§9.9z corridor rule — long history, breadth, multi-TF, OOS",
  command,
  prereg: "notes/2026-08-03-corridor-validation-prereg.md",
  feePct: DEFAULT_TRADE.feePct,
  funding: "omitted (cross-class parity)",
  scanAheadAtr: DEFAULT_TRADE.scanAheadAtr,
  maxDays: MAX_DAYS,
  engine: process.env.ENGINE === "0803" ? "pre-2026-08-03 (9b0bf65)" : "current",
  minBothGroups: MIN_BOTH,
  oosSplit: "calendar midpoint of loaded series; trade assigned by open time; nothing fitted",
  failureCriteria:
    "fails if no-rope tail not consistently worse across symbols, or effect vanishes OOS, or crypto-only",
  loadErrors,
  evaluation: { is: evalIS, oos: evalOOS, all: evalAll },
  verdict,
  cells,
};

console.log(JSON.stringify(out, null, 2));

// Human table
console.error("\n=== VERDICT ===");
console.error(JSON.stringify(verdict, null, 2));
console.error("\n=== OOS evaluation ===");
console.error(JSON.stringify(evalOOS, null, 2));
console.error("\nid/tf | split | noRope n/worst/p5 | hasRope n/worst/p5 | worse?");
for (const c of cells) {
  for (const split of ["is", "oos"]) {
    const r = c.unfiltered[split];
    const flag = r.adequate
      ? (r.worstNoRopeWorse ? "YES" : "NO")
      : "thin";
    console.error(
      `${c.id}/${c.tf} ${split.padEnd(3)} | ` +
        `no ${r.noRope.count}/${r.noRope.worstNet}/${r.noRope.p5Net} | ` +
        `has ${r.hasRope.count}/${r.hasRope.worstNet}/${r.hasRope.p5Net} | ${flag}`,
    );
  }
}
