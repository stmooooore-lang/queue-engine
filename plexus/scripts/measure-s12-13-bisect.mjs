/**
 * S12-13, second half — WHICH change cut the ropes.
 *
 *   node scripts/measure-s12-13-bisect.mjs > s12-13-bisect.json
 *
 * The first half established that the cause is the code: the same candles give
 * 16.4% fewer ropes on the current engine than on the one from before
 * 3 August. Four commits landed between them, and any of them could be it.
 *
 * This walks all six versions over ONE array of candles per cell, in order, so
 * the drop can be attributed to a step rather than to the range:
 *
 *   9b0bf65  2026-08-03  life-cycle win/forgive in days      <- the baseline
 *   d346561  2026-08-03  per-TF params, longitudinal co-travel
 *   a2015da  2026-08-03  %-history life-cycle
 *   c5fe427  2026-08-03  ropes as Gaussian curves
 *   d3c358b  2026-08-10  instrument alignment gate
 *   5e49be5  2026-08-10  angle bound removed
 *   current
 *
 * Only rope construction is compared, never trades: the pre-August trader has
 * no corridorGroup and no net, so nothing downstream of ropes can be compared
 * across this range at all. Rope counts can, and they are what fell.
 *
 * No model, no quota, no key.
 */
import fs from "node:fs";
import { INSTRUMENTS, TFS, loadSeries } from "./lib/series.mjs";

const MAX_DAYS = Number(process.env.MAX_DAYS || 180);
const PROG = process.env.PROGRESS_LOG || "s12-13-bisect.progress.log";
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(PROG, line);
  process.stderr.write(line);
}
fs.writeFileSync(PROG, "");

const STEPS = [
  { id: "9b0bf65", dir: "../site/engine-0803", what: "before 3 August — baseline" },
  { id: "d346561", dir: "../site/engine-d346561", what: "per-TF params, longitudinal co-travel" },
  { id: "a2015da", dir: "../site/engine-a2015da", what: "%-history life-cycle" },
  { id: "c5fe427", dir: "../site/engine-c5fe427", what: "ropes as Gaussian curves" },
  { id: "d3c358b", dir: "../site/engine-d3c358b", what: "instrument alignment gate" },
  { id: "5e49be5", dir: "../site/engine-5e49be5", what: "angle bound removed" },
  { id: "current",  dir: "../site/engine",         what: "today" },
];

const engines = [];
for (const s of STEPS) {
  try {
    engines.push({ ...s, mod: await import(`${s.dir}/rope.js`) });
  } catch (e) {
    log(`SKIP ${s.id}: ${e.message}`);
  }
}
log(`engines loaded: ${engines.map((e) => e.id).join(", ")}`);

function ropesWith(E, candles, barMs) {
  const resolved = E.resolvePeriods(candles, { maxDays: MAX_DAYS, barMs });
  const fabric = E.computeFabric(candles, { periods: resolved.periods });
  const atr = E.computeATR(candles);
  return E.detectRopes(fabric, candles, atr, {
    ...E.DEFAULT_CFG, mode: "lookback", barMs, maxDays: MAX_DAYS,
  }).length;
}

const cells = [];
const loadErrors = [];

for (const inst of INSTRUMENTS) {
  for (const tf of TFS) {
    const label = `${inst.id}/${tf.key}`;
    let candles;
    try {
      candles = await loadSeries(inst, tf, log);
    } catch (e) {
      loadErrors.push({ id: inst.id, tf: tf.key, error: String(e.message || e) });
      continue;
    }
    if (candles.length < 200) continue;

    const barMs = engines[0].mod.barMsOf(tf.barKey);
    const row = { id: inst.id, cls: inst.cls, tf: tf.key, nCandles: candles.length, ropes: {} };
    for (const e of engines) {
      try {
        row.ropes[e.id] = ropesWith(e.mod, candles, barMs);
      } catch (err) {
        row.ropes[e.id] = null;
        log(`FAIL ${label} on ${e.id}: ${err.message}`);
      }
    }
    cells.push(row);
    log(`${label} ${engines.map((e) => `${e.id}=${row.ropes[e.id]}`).join(" ")}`);
  }
}

// Step-to-step change, summed over cells: which commit is the cliff.
const totals = {};
for (const e of engines) {
  totals[e.id] = cells.reduce((s, c) => s + (c.ropes[e.id] ?? 0), 0);
}
const steps = [];
for (let i = 1; i < engines.length; i++) {
  const prev = engines[i - 1], cur = engines[i];
  const before = totals[prev.id], after = totals[cur.id];
  steps.push({
    commit: cur.id,
    what: cur.what,
    ropesBefore: before,
    ropesAfter: after,
    deltaPct: before ? +(((after - before) / before) * 100).toFixed(1) : null,
  });
}
const worst = steps.reduce((a, b) => ((b.deltaPct ?? 0) < (a.deltaPct ?? 0) ? b : a), steps[0]);

console.log("\nropes summed over all cells, one step at a time:");
for (const s of steps) {
  console.log(`  ${s.commit.padEnd(9)} ${String(s.ropesBefore).padStart(5)} -> ${String(s.ropesAfter).padStart(5)}  ${String(s.deltaPct).padStart(7)}%   ${s.what}`);
}
const summary = `BIGGEST DROP: ${worst.commit} (${worst.deltaPct}%) — ${worst.what}`;
console.log(`\n${summary}\n`);
log(summary);

console.log(JSON.stringify({
  task: "S12-13 bisect",
  question: "which of the four commits between 3 and 10 August cut the ropes",
  method: "one array of candles per cell, seven engine versions in order, rope counts only",
  maxDays: MAX_DAYS,
  ranAt: new Date().toISOString(),
  cells: cells.length,
  loadErrors,
  totals,
  steps,
  verdict: summary,
  perCell: cells,
}, null, 2));
