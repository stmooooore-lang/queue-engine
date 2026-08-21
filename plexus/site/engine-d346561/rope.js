/**
 * Plexus rope engine — pure: candles in, ropes and events out.
 *
 * S10-C8 / canon §9.9x: periods are TIME (days), converted to bars per
 * timeframe. Closeness defaults to percent of price; ATR path remains
 * behind tolMode:'atr'. Decision boundary is the rope edge (no zone pad).
 *
 * No I/O, no rendering, no network. No function returns a probability
 * or a forecast — the engine reports structure and what price did at it.
 */

// ---------------------------------------------------------------------------
// Timeframe → bar duration
// ---------------------------------------------------------------------------

/** Bar length in ms for instrument TF keys (Bybit-style: "60", "D", …). */
export const BAR_MS = {
  "1": 60e3,
  "3": 180e3,
  "5": 300e3,
  "15": 900e3,
  "30": 1800e3,
  "60": 3600e3,
  "120": 7200e3,
  "240": 14400e3,
  "360": 21600e3,
  "720": 43200e3,
  D: 864e5,
  W: 6048e5,
};

export function barMsOf(tf) {
  const ms = BAR_MS[tf];
  if (ms == null) throw new Error(`unknown timeframe: ${tf}`);
  return ms;
}

// ---------------------------------------------------------------------------
// Period family — progressive spacing in DAYS, then → bars per TF (§9.9x)
// ---------------------------------------------------------------------------

/**
 * Progressive period list in abstract units (same shape as the old bar family).
 * Historically genPeriods(500) → 2…494 with 54 members; that shape is kept.
 */
export function genProgressive(maxP) {
  const out = [];
  let p = 2, step = 3;
  while (p <= maxP) {
    out.push(Math.round(p));
    p += step;
    step = Math.min(step * 1.04, 3 + Math.log(Math.max(p, 2)) * 2.2);
  }
  return [...new Set(out)];
}

/** @deprecated bar-space family — use genPeriodDays + periodsToBars (S10-C8). */
export function genPeriods(maxP) {
  return genProgressive(maxP);
}

/** Period family in days (real time). Default max 500 ≈ old 2…494 daily bars. */
export function genPeriodDays(maxDays) {
  return genProgressive(maxDays);
}

/**
 * Convert a duration in days to whole bars for a bar length.
 * Positive durations honour `min` so life-cycle params never round to 0 on
 * coarse timeframes (forgiveHours=4 → 0 on daily was killing daily ropes).
 */
export function daysToBars(days, barMs, { min = 0 } = {}) {
  if (!(days > 0)) return 0;
  return Math.max(min, Math.round((days * 864e5) / barMs));
}

/** Hours → bars (UI mirror of day durations). */
export function hoursToBars(hours, barMs, { min = 0 } = {}) {
  if (!(hours > 0)) return 0;
  return Math.max(min, Math.round((hours * 3600e3) / barMs));
}

/**
 * Time-based family → unique bar periods for this timeframe.
 * Dedupes after rounding (short TFs keep more members; daily collapses).
 */
export function periodsToBars(dayList, barMs) {
  return [...new Set(dayList.map((d) => daysToBars(d, barMs, { min: 2 })))]
    .sort((a, b) => a - b);
}

export function genPeriodsForTimeframe(maxDays, barMs) {
  return periodsToBars(genPeriodDays(maxDays), barMs);
}

/**
 * Effective depth and bar periods given loaded history.
 * Cap: longest MA ≤ half the loaded span (same honesty rule as before).
 */
export function resolvePeriods(candles, { maxDays, barMs } = {}) {
  if (!barMs) throw new Error("resolvePeriods: barMs required");
  const want = maxDays != null ? maxDays : DEFAULT_CFG.maxDays;
  const spanDays = (candles.length * barMs) / 864e5;
  const effMaxDays = Math.min(want, spanDays * 0.5);
  const periods = genPeriodsForTimeframe(Math.max(2, effMaxDays), barMs);
  return { periods, effMaxDays, spanDays, wantDays: want };
}

/**
 * computeFabric(candles, { maxDays, barMs } | { periods }) -> MA series
 * Each series is SMA of (h+l)/2 over its period (in bars).
 */
export function computeFabric(candles, opts = {}) {
  let periods = opts.periods;
  if (!periods) {
    if (opts.barMs != null) {
      periods = resolvePeriods(candles, opts).periods;
    } else {
      // Legacy: maxPeriod in bars (pre-S10-C8 call sites / smoke).
      const n = candles.length;
      const maxP = opts.maxPeriod != null
        ? opts.maxPeriod
        : Math.min(500, Math.floor(n * 0.5));
      periods = genPeriods(maxP);
    }
  }
  const med = candles.map((b) => (b.h + b.l) / 2);
  return periods.map((p) => {
    const arr = new Array(med.length).fill(null);
    let sum = 0;
    for (let i = 0; i < med.length; i++) {
      sum += med[i];
      if (i >= p) sum -= med[i - p];
      if (i >= p - 1) arr[i] = sum / p;
    }
    return arr;
  });
}

/** ATR series (Wilder-style simple window average of true range). */
export function computeATR(candles, window = 14) {
  const out = new Array(candles.length).fill(null);
  const tr = new Array(candles.length);
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    const pc = i > 0 ? candles[i - 1].c : candles[i].o;
    const t = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - pc),
      Math.abs(candles[i].l - pc),
    );
    tr[i] = t;
    acc += t;
    if (i >= window) acc -= tr[i - window];
    out[i] = i >= window - 1 ? acc / Math.min(i + 1, window) : null;
  }
  return out;
}

export const DEFAULT_CFG = {
  // S10-C8: closeness as % of price (tolMode 'pct'). ATR path: tolMode 'atr' + kTol.
  tolMode: "pct",
  kTolPct: 0.25, // percent of price
  kTol: 0.25, // × ATR when tolMode === 'atr'
  density: 1.0,
  // Life-cycle in DAYS — same unit conversion as the period family (§9.9x):
  // old bar counts (win 47, forgive 4) become day counts, then → bars per TF.
  // Hours are a UI mirror only (days × 24). Floor in daysToBars keeps forgive ≥ 1
  // bar whenever the duration is positive.
  winDays: 47,
  forgiveDays: 4,
  winHours: 47 * 24,
  forgiveHours: 4 * 24,
  // Legacy bar overrides (if set, used as-is — for tests).
  win: null,
  forgive: null,
  minShare: 0.0,
  mode: "lookback",
  maxDays: 500,
  barMs: null, // required at detect time unless win/forgive given in bars
  // Max angle between strand motions in ATR-normalized (bar, price) space.
  // Near-perpendicular crossings are proximity without a shared direction —
  // they must not count as co-travel (no third rope at an X of two ropes).
  maxPairAngleDeg: 55,
};

/** Absolute closeness tolerance at a price (and optional ATR). */
export function tolAbs(price, atr, cfg) {
  if (cfg.tolMode === "atr") {
    if (atr == null || !(atr > 0)) return null;
    return cfg.kTol * atr;
  }
  if (!(price > 0)) return null;
  return (cfg.kTolPct / 100) * price;
}

/** Resolve life-cycle days from cfg (days are canonical; hours are UI mirror). */
function lifeDays(cfg, hoursKey, daysKey, fallbackDays) {
  if (cfg[daysKey] != null) return cfg[daysKey];
  if (cfg[hoursKey] != null) return cfg[hoursKey] / 24;
  return fallbackDays;
}

/**
 * Win / forgive → bars. Positive durations use a floor so coarse TFs never
 * get 0 (daily forgiveHours=4 used to round to 0 and kill every rope).
 */
export function resolveWinForgive(cfg) {
  let win = cfg.win;
  let forgive = cfg.forgive;
  if (win != null && forgive != null) return { win, forgive };
  if (cfg.barMs == null) {
    throw new Error("detectRopes: barMs required when win/forgive are in time");
  }
  const winDays = lifeDays(cfg, "winHours", "winDays", DEFAULT_CFG.winDays);
  const forgiveDays = lifeDays(cfg, "forgiveHours", "forgiveDays", DEFAULT_CFG.forgiveDays);
  if (win == null) win = daysToBars(winDays, cfg.barMs, { min: 2 });
  if (forgive == null) {
    forgive = forgiveDays <= 0
      ? 0
      : daysToBars(forgiveDays, cfg.barMs, { min: 1 });
  }
  return { win, forgive };
}

// ---------------------------------------------------------------------------
// §1 construction — ported from rope-prototype.html; tol unit per S10-C8
// ---------------------------------------------------------------------------

/** Pairwise co-travel at bar i: close, same direction, similar speed. */
export function together(ma, a, b, i, atr, cfgOrKTol) {
  const cfg = typeof cfgOrKTol === "number"
    ? { ...DEFAULT_CFG, tolMode: "atr", kTol: cfgOrKTol }
    : cfgOrKTol;
  const va = ma[a][i], vb = ma[b][i];
  if (va == null || vb == null) return false;
  const mid = (va + vb) / 2;
  const tol = tolAbs(mid, atr && atr[i], cfg);
  if (tol == null || !(tol > 0)) return false;
  if (Math.abs(va - vb) > tol) return false;
  const pa = ma[a][i - 1], pb = ma[b][i - 1];
  if (pa == null || pb == null) return false;
  const da = va - pa, db = vb - pb;
  if (da * db < 0) return false;
  if (Math.abs(da - db) > tol * 0.5) return false;
  // Longitudinal only: reject near-orthogonal motions (crossing ≠ co-travel).
  const atrv = atr && atr[i];
  if (atrv != null && atrv > 0) {
    const maxDeg = cfg.maxPairAngleDeg != null ? cfg.maxPairAngleDeg : DEFAULT_CFG.maxPairAngleDeg;
    const ya = da / atrv, yb = db / atrv;
    const den = Math.hypot(1, ya) * Math.hypot(1, yb);
    if (den > 0) {
      const cos = (1 + ya * yb) / den;
      if (Math.abs(cos) < Math.cos((maxDeg * Math.PI) / 180)) return false;
    }
  }
  return true;
}

/** All strand pairs in g co-directed at bar i (same rule as together's angle). */
function groupAligned(ma, g, i, atr, cfg) {
  if (i < 1 || g.length < 2) return false;
  const atrv = atr && atr[i];
  if (!(atrv > 0)) return true;
  const maxDeg = cfg.maxPairAngleDeg != null ? cfg.maxPairAngleDeg : DEFAULT_CFG.maxPairAngleDeg;
  const minCos = Math.cos((maxDeg * Math.PI) / 180);
  const slopes = [];
  for (const s of g) {
    const v = ma[s][i], p = ma[s][i - 1];
    if (v == null || p == null) return false;
    slopes.push((v - p) / atrv);
  }
  for (let a = 0; a < slopes.length; a++) {
    for (let b = a + 1; b < slopes.length; b++) {
      if (slopes[a] * slopes[b] < 0) return false;
      const ya = slopes[a], yb = slopes[b];
      const den = Math.hypot(1, ya) * Math.hypot(1, yb);
      if (den > 0 && Math.abs((1 + ya * yb) / den) < minCos) return false;
    }
  }
  return true;
}

/**
 * Density-based grouping with non-maximum suppression over [from..to].
 * Not union-find: A~B and B~C must not chain into one rope (§9.2).
 */
export function groupOver(ma, from, to, atr, cfg) {
  const L = ma.length, span = to - from + 1, share = new Array(L * L).fill(0);
  for (let i = Math.max(from, 1); i <= to; i++) {
    for (let a = 0; a < L; a++) {
      if (ma[a][i] == null) continue;
      for (let b = a + 1; b < L; b++) {
        if (ma[b][i] == null) continue;
        if (together(ma, a, b, i, atr, cfg)) share[a * L + b]++;
      }
    }
  }
  const need = Math.max(2, Math.floor(span * cfg.minShare));
  const priceRef = (() => {
    for (let a = 0; a < L; a++) {
      if (ma[a][to] != null) return ma[a][to];
    }
    return null;
  })();
  const tol = tolAbs(priceRef, atr && atr[to], cfg);
  if (!(tol > 0)) return [];

  const idx = [];
  for (let a = 0; a < L; a++) if (ma[a][to] != null) idx.push(a);
  idx.sort((x, y) => ma[x][to] - ma[y][to]);
  if (idx.length < 4) return [];

  const gaps = [];
  for (let k = 1; k < idx.length; k++) gaps.push(ma[idx[k]][to] - ma[idx[k - 1]][to]);
  gaps.sort((a, b) => a - b);
  const medGap = gaps[Math.floor(gaps.length / 2)] || 0;
  if (!(medGap > 0)) return [];

  const MIN_LINES = 3;
  const cands = [];
  for (let a = 0; a < idx.length; a++) {
    const anchor = idx[a], g = [anchor];
    for (let b = a + 1; b < idx.length && (ma[idx[b]][to] - ma[anchor][to]) <= tol; b++) {
      const lo = Math.min(anchor, idx[b]), hi = Math.max(anchor, idx[b]);
      if (share[lo * L + hi] >= need) g.push(idx[b]);
    }
    if(g.length < MIN_LINES) continue;
    // Group must share a longitudinal direction at the judgment bar —
    // a price pile-up of crossing strands is not a rope.
    if (!groupAligned(ma, g, to, atr, cfg)) continue;
    const width = ma[g[g.length - 1]][to] - ma[g[0]][to];
    const ownGap = width / (g.length - 1);
    if (ownGap * cfg.density > medGap) continue;
    cands.push({ g, score: g.length * (medGap / (ownGap || 1e-9)) });
  }

  cands.sort((x, y) => y.score - x.score);
  const out = [], taken = new Set();
  for (const c of cands) {
    const shared = c.g.filter((s) => taken.has(s)).length;
    if (shared / c.g.length >= 0.5) continue;
    c.g.forEach((s) => taken.add(s));
    out.push(c.g);
  }
  return out;
}

function bandOf(ma, strands, i) {
  let lo = Infinity, hi = -Infinity, ok = 0;
  for (const s of strands) {
    const v = ma[s][i];
    if (v == null) continue;
    ok++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return ok >= 2 ? [lo, hi] : null;
}

function coreOverlap(a, b) {
  const sa = new Set(a);
  let hit = 0;
  for (const x of b) if (sa.has(x)) hit++;
  return hit / Math.max(a.length, b.length);
}

function nextId(state) {
  return state.id++;
}

function buildStreaming(ma, candles, atr, cfg, state) {
  const N = candles.length, ropes = [];
  let live = [];
  for (let i = cfg.win; i < N; i++) {
    const groups = groupOver(ma, i - cfg.win, i, atr, cfg);
    const used = new Set();
    for (const g of groups) {
      let best = null, bestOv = 0.34;
      for (const r of live) {
        if (used.has(r)) continue;
        const ov = coreOverlap(r.strands, g);
        if (ov > bestOv) { bestOv = ov; best = r; }
      }
      if (best) {
        used.add(best);
        best.strands = g;
        best.to = i;
        best.miss = 0;
        const bd = bandOf(ma, g, i);
        if (bd) best.bands.push([i, bd]);
      } else {
        const bd = bandOf(ma, g, i);
        const r = {
          id: nextId(state),
          strands: g,
          from: i,
          to: i,
          miss: 0,
          bands: bd ? [[i, bd]] : [],
          roles: new Map(),
          dead: false,
          deathBar: null,
        };
        live.push(r);
        ropes.push(r);
        used.add(r);
      }
    }
    live = live.filter((r) => {
      if (used.has(r)) return true;
      r.miss = (r.miss || 0) + 1;
      if (r.miss > cfg.forgive) {
        r.dead = true;
        r.deathBar = i;
        return false;
      }
      return true;
    });
  }
  return ropes;
}

function buildLookback(ma, candles, atr, cfg, state) {
  const N = candles.length, ropes = [];
  let live = [];
  for (let i = cfg.win; i < N; i++) {
    const groups = groupOver(ma, i - cfg.win, i, atr, cfg);
    const used = new Set();
    for (const g of groups) {
      let best = null, bestOv = 0.34;
      for (const r of live) {
        if (used.has(r)) continue;
        const ov = coreOverlap(r.strands, g);
        if (ov > bestOv) { bestOv = ov; best = r; }
      }
      if (best) {
        used.add(best);
        best.strands = g;
        best.to = i;
        best.miss = 0;
        const bd = bandOf(ma, g, i);
        if (bd) best.bands.push([i, bd]);
      } else {
        let start = i;
        while (start > 1) {
          const bd = bandOf(ma, g, start);
          if (!bd) break;
          const mid = (bd[0] + bd[1]) / 2;
          const tol = tolAbs(mid, atr && atr[start], cfg);
          if (tol == null || (bd[1] - bd[0]) > tol) break;
          let ok = 0, tot = 0;
          for (let a = 0; a < g.length; a++) {
            for (let b = a + 1; b < g.length; b++) {
              tot++;
              if (together(ma, g[a], g[b], start, atr, cfg)) ok++;
            }
          }
          if (tot === 0 || ok / tot < cfg.minShare) break;
          start--;
        }
        const r = {
          id: nextId(state),
          strands: g,
          from: start + 1,
          to: i,
          miss: 0,
          bands: [],
          roles: new Map(),
          dead: false,
          deathBar: null,
        };
        for (let b = r.from; b <= i; b++) {
          const bd = bandOf(ma, g, b);
          if (bd) r.bands.push([b, bd]);
        }
        live.push(r);
        ropes.push(r);
        used.add(r);
      }
    }
    live = live.filter((r) => {
      if (used.has(r)) return true;
      r.miss = (r.miss || 0) + 1;
      if (r.miss > cfg.forgive) {
        r.dead = true;
        r.deathBar = i;
        return false;
      }
      return true;
    });
  }
  return ropes;
}

/**
 * Role from band EDGES, carried while price is inside.
 * Fully above → support (1); fully below → resistance (−1).
 */
export function assignRoles(rope, candles) {
  rope.roles = new Map();
  let prev = null;
  for (const [i, band] of rope.bands) {
    if (!band) continue;
    const p = candles[i].c;
    let role;
    if (p > band[1]) role = 1;
    else if (p < band[0]) role = -1;
    else if (prev !== null) role = prev;
    else role = p > (band[0] + band[1]) / 2 ? 1 : -1;
    rope.roles.set(i, role);
    prev = role;
  }
}

/**
 * detectRopes(fabric, candles, atr, cfg) -> Rope[]
 * cfg: DEFAULT_CFG fields + barMs (required unless win/forgive set in bars)
 */
export function detectRopes(fabric, candles, atr, cfg = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const { win, forgive } = resolveWinForgive(c);
  c.win = win;
  c.forgive = forgive;
  const state = { id: 1 };
  const ropes = c.mode === "stream"
    ? buildStreaming(fabric, candles, atr, c, state)
    : buildLookback(fabric, candles, atr, c, state);
  const kept = ropes.filter((r) => r.bands.length > 0);
  for (const r of kept) assignRoles(r, candles);
  return kept;
}

// ---------------------------------------------------------------------------
// contactEvents — geometric enter / bounce / break (PRD-TRADER §1)
// S10-C8: decision boundary is the rope edge; pad defaults to 0.
// ---------------------------------------------------------------------------

function zoneSide(price, zLo, zHi) {
  if (price > zHi) return "above";
  if (price < zLo) return "below";
  return null;
}

/**
 * contactEvents(ropes, candles, opts?) -> Event[]
 * Event: { bar, ropeId, kind: 'enter'|'bounce'|'break', side, price }
 * opts.zone / zoneAtr kept only for legacy measurement; default pad = 0.
 */
export function contactEvents(ropes, candles, {
  zone = 0,
  zoneAtr = null,
  atr = null,
} = {}) {
  const events = [];
  for (const rope of ropes) {
    const bandAt = new Map();
    for (const [i, band] of rope.bands) {
      if (band) bandAt.set(i, band);
    }
    if (!bandAt.size) continue;

    const bars = [...bandAt.keys()].sort((a, b) => a - b);
    let inside = false;
    let enterSide = null;

    for (const i of bars) {
      const [lo, hi] = bandAt.get(i);
      const pad = (zoneAtr != null && atr && atr[i] != null)
        ? zoneAtr * atr[i]
        : zone;
      const zLo = lo - pad;
      const zHi = hi + pad;
      const price = candles[i].c;
      const sideNow = zoneSide(price, zLo, zHi);
      const isIn = sideNow === null;

      if (!inside && isIn) {
        const prevPrice = i > 0 ? candles[i - 1].c : price;
        const from = zoneSide(prevPrice, zLo, zHi);
        enterSide = from || (prevPrice > (zLo + zHi) / 2 ? "above" : "below");
        events.push({
          bar: i,
          ropeId: rope.id,
          kind: "enter",
          side: enterSide,
          price,
        });
        inside = true;
      } else if (inside && !isIn) {
        const exitSide = sideNow;
        const kind = exitSide === enterSide ? "bounce" : "break";
        events.push({
          bar: i,
          ropeId: rope.id,
          kind,
          side: exitSide,
          price,
        });
        inside = false;
        enterSide = null;
      }
    }
  }
  events.sort((a, b) => a.bar - b.bar || a.ropeId - b.ropeId);
  return events;
}
