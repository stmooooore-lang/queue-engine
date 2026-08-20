/**
 * S12-13 — что срезало канаты: код или данные.
 *
 *   node scripts/measure-s12-13-engine-vs-data.mjs > s12-13.json
 *
 * Ропов стало меньше на 19% против замера 2026-08-03. Между тем замером и
 * сегодняшним прогоном изменились ДВЕ вещи сразу: движок (четыре коммита
 * 3-10 августа) и данные (шестнадцать дней сдвига). Пока меняются обе,
 * причину назвать нельзя.
 *
 * Здесь они разделены: ОДИН И ТОТ ЖЕ ряд свечей прогоняется через ДВА движка -
 * нынешний и тот, что стоял до 3 августа (rope.js на 9b0bf65, 2026-08-03
 * 01:42, последний коммит перед d346561). Данные при этом тождественны, потому
 * что это буквально один массив в памяти.
 *
 *   старый движок даёт заметно больше ропов  -> причина КОД
 *   оба движка дают примерно поровну         -> причина ДАННЫЕ, все четыре
 *                                               коммита оправданы
 *
 * Модели в задаче нет, квоты она не ест, ключей не требует.
 */
import fs from "node:fs";
import { INSTRUMENTS, TFS, loadSeries } from "./lib/series.mjs";
import * as NOW from "../site/engine/rope.js";
import * as OLD from "../site/engine-0803/rope.js";

const MAX_DAYS = Number(process.env.MAX_DAYS || 180);
const PROG = process.env.PROGRESS_LOG || "s12-13.progress.log";
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(PROG, line);
  process.stderr.write(line);
}
fs.writeFileSync(PROG, "");

/** Ropes as that engine would build them, from the same candles. */
function ropesWith(E, candles, barMs) {
  const resolved = E.resolvePeriods(candles, { maxDays: MAX_DAYS, barMs });
  const fabric = E.computeFabric(candles, { periods: resolved.periods });
  const atr = E.computeATR(candles);
  const ropes = E.detectRopes(fabric, candles, atr, {
    ...E.DEFAULT_CFG,
    mode: "lookback",
    barMs,
    maxDays: MAX_DAYS,
  });
  return ropes.length;
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
      log(`FAIL load ${label}: ${e.message}`);
      continue;
    }
    if (candles.length < 200) {
      loadErrors.push({ id: inst.id, tf: tf.key, error: `too few candles: ${candles.length}` });
      continue;
    }
    const barMs = NOW.barMsOf(tf.barKey);
    const t0 = Date.now();
    const now = ropesWith(NOW, candles, barMs);
    const old = ropesWith(OLD, candles, barMs);
    const delta = old ? (now - old) / old : null;
    cells.push({
      id: inst.id, cls: inst.cls, tf: tf.key, source: inst.source,
      nCandles: candles.length,
      from: new Date(candles[0].t).toISOString(),
      to: new Date(candles.at(-1).t).toISOString(),
      ropesNow: now, ropesOld: old,
      deltaPct: delta === null ? null : +(delta * 100).toFixed(1),
    });
    log(`${label} n=${candles.length} now=${now} old=${old} ` +
        `delta=${delta === null ? "n/a" : (delta * 100).toFixed(1) + "%"} ms=${Date.now() - t0}`);
  }
}

const withBoth = cells.filter((c) => c.deltaPct !== null);
const deltas = withBoth.map((c) => c.deltaPct).sort((a, b) => a - b);
const median = deltas.length ? deltas[deltas.length >> 1] : null;
const fewer = withBoth.filter((c) => c.ropesNow < c.ropesOld).length;

// The threshold is the size of the drop being explained: ropes fell ~19% in
// S11-M4. If the engine alone reproduces most of that on identical data, the
// engine is the cause; if it reproduces almost none of it, the data is.
const verdict =
  median === null ? "NO DATA"
  : median <= -10 ? "CODE — the current engine builds materially fewer ropes on identical candles"
  : median >= -3 ? "DATA — both engines agree on today's candles, so the 16-day shift carries the drop"
  : "MIXED — the engine explains part of the drop, not all of it";

const out = {
  task: "S12-13",
  question: "what cut the ropes by ~19% — the four engine commits of 3-10 August, or the 16-day data shift",
  method: "same candles, two engines: current vs rope.js at 9b0bf65 (2026-08-03 01:42, last before d346561)",
  command: "node scripts/measure-s12-13-engine-vs-data.mjs",
  maxDays: MAX_DAYS,
  ranAt: new Date().toISOString(),
  cellsCompared: withBoth.length,
  cellsWithFewerRopesNow: fewer,
  medianDeltaPct: median,
  verdict,
  loadErrors,
  cells,
};

console.log(`\n${"cell".padEnd(14)} ${"now".padStart(5)} ${"old".padStart(5)} ${"delta".padStart(8)}`);
for (const c of cells) {
  console.log(`${(c.id + "/" + c.tf).padEnd(14)} ${String(c.ropesNow).padStart(5)} ${String(c.ropesOld).padStart(5)} ${(c.deltaPct === null ? "n/a" : c.deltaPct + "%").padStart(8)}`);
}
console.log(`\nmedian delta ${median}% over ${withBoth.length} cells, fewer now in ${fewer}`);
console.log(`VERDICT: ${verdict}\n`);
console.log(JSON.stringify(out, null, 2));
