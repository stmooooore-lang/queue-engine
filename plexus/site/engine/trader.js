/**
 * Personal trading instrument rules (PRD-TRADER) — same path for backtest /
 * paper / live; only data source and money differ.
 *
 * S10-C8: contacts use the rope edge (no separate zone pad). Zoom/TF must
 * not change the rule — ropes are built in time units upstream.
 *
 * Reports what the rules did on the contacts the engine already measured.
 * Does not predict. Does not claim an edge.
 */
import { contactEvents } from './rope.js';

export const DEFAULT_TRADE = {
  pauseMode: 'hold',   // 'hold' | 'close' | 'hedge'
  sizePct: 10,         // position size as % of balance
  sharpMoveAtr: 1.5,   // stop: what counts as a sharp move (× ATR) = risk unit
  scanAheadAtr: 2.0,   // stop: how far ahead to scan for a rope (× ATR)
  feePct: 0.0005,      // 0.05% — modelled from the first run (PRD-03 §11)
  startBalance: 10000,
  // Skip open if room to nearest rope ahead < mul × round-trip fee (price units).
  // 0 = no filter. Sweep in measure-pause; do not treat any mul as a default.
  minPotentialMul: 0,
  // Skip open if target/risk < ratio. Target = nearest rope ahead (price, NO
  // scan cap); risk = sharpMoveAtr × ATR. 0 = off. Claude's continuous form —
  // not the founder's joint corridor rule (see requireRopeInScan).
  minTargetRiskRatio: 0,
  // Founder's corridor rule (joint): (a) a live rope must exist ahead within
  // scanAheadAtr×ATR; (b) distance to it ≥ minRoomMul × round-trip fee.
  // requireRopeInScan=false → off. minRoomMul=0 with require → (a) only.
  requireRopeInScan: false,
  minRoomMul: 0,
  // Rope-history open filter (canon §9.9h). All 0/null = off.
  // form: 'absolute' | 'relative'
  // absolute: minAgeDays, minPriorTouches
  // relative: minAgePercentile (0–100 among live ropes), minTouchesPerDay
  historyForm: null,
  minAgeDays: 0,
  minPriorTouches: 0,
  minAgePercentile: 0,
  minTouchesPerDay: 0,
  barMs: null, // required for age-in-days / relative history filters
  // Optional [{ t, rate }] Bybit-style funding settlements.
  fundingRates: null,
};

/** Direction after a contact with no prior position (geometric read). */
function directionFromResolution(ev) {
  if (ev.kind === 'bounce') return ev.side === 'above' ? 1 : -1;
  if (ev.kind === 'break') return ev.side === 'above' ? 1 : -1;
  return null;
}

/** Is there a live rope band ahead of price within scan distance? */
function ropeAhead(ropes, bar, price, dir, scanDist) {
  return nearestRopeAhead(ropes, bar, price, dir) <= scanDist;
}

/**
 * Distance (price units) to the nearest live rope midpoint in the travel
 * direction. Infinity if none ahead on this bar.
 * Optional maxDist: ignore ropes farther than that (scan window).
 */
export function nearestRopeAhead(ropes, bar, price, dir, maxDist = Infinity) {
  let best = Infinity;
  for (const r of ropes || []) {
    if (r.dead && r.deathBar != null && bar >= r.deathBar) continue;
    let band = null;
    for (const [i, b] of r.bands) {
      if (i === bar) { band = b; break; }
    }
    if (!band) continue;
    const mid = (band[0] + band[1]) / 2;
    let dist = null;
    if (dir > 0 && mid > price) dist = mid - price;
    if (dir < 0 && mid < price) dist = price - mid;
    if (dist == null || dist > maxDist) continue;
    best = Math.min(best, dist);
  }
  return best;
}

/** Round-trip commission expressed as a price move that repays open+close fees. */
export function roundTripCostPrice(price, feePct) {
  return price * 2 * feePct;
}

/**
 * Founder's corridor geometry at an open.
 * Groups:
 *   no-rope-in-scan  — nothing within scanAheadAtr×ATR (unknown space)
 *   rope-too-close   — rope in scan but room < 1× round-trip fee
 *   rope-with-room   — rope in scan and room ≥ 1× round-trip fee
 *
 * Note: uncapped nearestRopeAhead can be large while roomInScan is null —
 * Claude's target/risk would score that as a high ratio (best); founder as worst.
 */
export function corridorAtOpen(ropes, bar, price, dir, atrVal, cfg) {
  const scan = (cfg.scanAheadAtr || 0) * (atrVal || 0);
  const rtc = roundTripCostPrice(price, cfg.feePct || 0);
  const roomUncapped = nearestRopeAhead(ropes, bar, price, dir, Infinity);
  const roomInScan = scan > 0
    ? nearestRopeAhead(ropes, bar, price, dir, scan)
    : roomUncapped;
  let group;
  if (!Number.isFinite(roomInScan)) group = 'no-rope-in-scan';
  else if (rtc > 0 && roomInScan < rtc) group = 'rope-too-close';
  else group = 'rope-with-room';
  return {
    group,
    scan,
    rtc,
    roomInScan: Number.isFinite(roomInScan) ? roomInScan : null,
    roomUncapped: Number.isFinite(roomUncapped) ? roomUncapped : null,
    // True when uncapped sees a rope but scan does not — Claude/founder diverge.
    distantOnly: Number.isFinite(roomUncapped) && !Number.isFinite(roomInScan),
  };
}

/** Rope age in days at bar (needs barMs). */
export function ropeAgeDays(rope, bar, barMs) {
  if (!barMs || !rope) return 0;
  const birth = rope.from != null ? rope.from : 0;
  return Math.max(0, (bar - birth) * barMs / 864e5);
}

/** Live ropes at bar (have a band, not yet dead). */
export function liveRopesAt(ropes, bar) {
  return (ropes || []).filter((r) => {
    if (r.dead && r.deathBar != null && bar >= r.deathBar) return false;
    for (const [i] of r.bands) {
      if (i === bar) return true;
    }
    return false;
  });
}

/** Age percentile of rope among live ropes at bar (0–100). */
export function ropeAgePercentile(rope, bar, ropes, barMs) {
  const live = liveRopesAt(ropes, bar);
  if (!live.length || !rope) return 0;
  const ages = live.map((r) => ropeAgeDays(r, bar, barMs)).sort((a, b) => a - b);
  const age = ropeAgeDays(rope, bar, barMs);
  let below = 0;
  for (const a of ages) if (a < age) below += 1;
  // Mid-rank percentile
  const eq = ages.filter((a) => a === age).length;
  return ((below + 0.5 * eq) / ages.length) * 100;
}

function emptyRun(cfg) {
  return {
    balance: cfg.startBalance,
    equity: cfg.startBalance,
    startBalance: cfg.startBalance,
    position: null,
    hedge: null,
    direction: null,
    trades: [],
    events: [],
    log: [],
    nContacts: 0,
    nTrades: 0,
    nSkippedPotential: 0,
    nSkippedTargetRisk: 0,
    nSkippedCorridor: 0,
    nSkippedHistory: 0,
    nFeeOps: 0,
    totalFees: 0,
    totalFunding: 0,
    fundingModelled: !!(cfg.fundingRates && cfg.fundingRates.length),
  };
}

export function runInstrument(candles, atr, ropes, tradeCfg = {}) {
  const cfg = { ...DEFAULT_TRADE, ...tradeCfg };
  if (!candles || candles.length < 2) return emptyRun(cfg);

  // S10-C8: pad = 0 — decision boundary is the rope's own [lo, hi].
  const events = contactEvents(ropes || [], candles, {});

  const ropeById = new Map((ropes || []).map((r) => [r.id, r]));

  // Prior completed contact episodes (enter→bounce/break) per rope, as of bar.
  // Built incrementally while scanning events in bar order.
  const priorTouches = new Map(); // ropeId -> count of completed episodes
  const eventsChrono = [...events].sort(
    (a, b) => a.bar - b.bar || a.ropeId - b.ropeId,
  );

  let balance = cfg.startBalance;
  let dir = null;
  let pos = null;
  let hedge = null;
  let paused = false;
  let pauseRope = null;
  let nSkippedPotential = 0;
  let nSkippedTargetRisk = 0;
  let nSkippedCorridor = 0;
  let nSkippedHistory = 0;
  let nFeeOps = 0;
  let totalFees = 0;
  let totalFunding = 0;
  let fundingIdx = 0;
  const trades = [];
  const log = [];

  const funding = (cfg.fundingRates && cfg.fundingRates.length)
    ? [...cfg.fundingRates].sort((a, b) => a.t - b.t)
    : null;

  function notional() {
    return balance * (cfg.sizePct / 100);
  }

  function chargeFee(size) {
    const fee = size * cfg.feePct;
    balance -= fee;
    totalFees += fee;
    nFeeOps += 1;
    return fee;
  }

  function passesPotential(bar, price, d) {
    const mul = cfg.minPotentialMul;
    if (!mul || mul <= 0) return true;
    const room = nearestRopeAhead(ropes, bar, price, d);
    const rt = roundTripCostPrice(price, cfg.feePct);
    if (!Number.isFinite(room) || room < mul * rt) {
      nSkippedPotential += 1;
      log.push({
        bar, kind: 'skip-potential', side: d > 0 ? 'long' : 'short', price,
        room: Number.isFinite(room) ? room : null,
        threshold: mul * rt, mul,
      });
      return false;
    }
    return true;
  }

  function passesTargetRisk(bar, price, d) {
    const minR = cfg.minTargetRiskRatio;
    if (!minR || minR <= 0) return true;
    const a = atr[bar] || atr[bar - 1] || 0;
    const risk = cfg.sharpMoveAtr * a;
    if (!(risk > 0)) {
      nSkippedTargetRisk += 1;
      return false;
    }
    // Uncapped — Claude's continuous form. Distant rope → large ratio → passes.
    const target = nearestRopeAhead(ropes, bar, price, d, Infinity);
    if (!Number.isFinite(target)) {
      // Empty uncapped scan: skip when filter on (not scored as Infinity/best).
      nSkippedTargetRisk += 1;
      log.push({
        bar, kind: 'skip-target-risk', side: d > 0 ? 'long' : 'short', price,
        target: null, risk, ratio: null, minR,
      });
      return false;
    }
    const ratio = target / risk;
    if (ratio < minR) {
      nSkippedTargetRisk += 1;
      log.push({
        bar, kind: 'skip-target-risk', side: d > 0 ? 'long' : 'short', price,
        target, risk, ratio, minR,
      });
      return false;
    }
    return true;
  }

  /** Founder's joint corridor: rope in scan AND room ≥ minRoomMul × RTC. */
  function passesCorridor(bar, price, d) {
    if (!cfg.requireRopeInScan) return true;
    const a = atr[bar] || atr[bar - 1] || 0;
    const geo = corridorAtOpen(ropes, bar, price, d, a, cfg);
    const mul = cfg.minRoomMul || 0;
    const need = mul * geo.rtc;
    const ok = geo.roomInScan != null && geo.roomInScan >= need;
    if (!ok) {
      nSkippedCorridor += 1;
      log.push({
        bar, kind: 'skip-corridor', side: d > 0 ? 'long' : 'short', price,
        group: geo.group, roomInScan: geo.roomInScan, need, mul,
        distantOnly: geo.distantOnly,
      });
      return false;
    }
    return true;
  }

  function passesHistory(bar, ropeId) {
    if (!cfg.historyForm) return true;
    const rope = ropeById.get(ropeId);
    if (!rope) {
      nSkippedHistory += 1;
      return false;
    }
    const touches = priorTouches.get(ropeId) || 0;
    const ageDays = ropeAgeDays(rope, bar, cfg.barMs);

    if (cfg.historyForm === 'absolute') {
      if (cfg.minAgeDays > 0 && ageDays < cfg.minAgeDays) {
        nSkippedHistory += 1;
        log.push({
          bar, kind: 'skip-history', form: 'absolute', ropeId,
          ageDays, touches, minAgeDays: cfg.minAgeDays,
        });
        return false;
      }
      if (cfg.minPriorTouches > 0 && touches < cfg.minPriorTouches) {
        nSkippedHistory += 1;
        log.push({
          bar, kind: 'skip-history', form: 'absolute', ropeId,
          ageDays, touches, minPriorTouches: cfg.minPriorTouches,
        });
        return false;
      }
      return true;
    }

    if (cfg.historyForm === 'relative') {
      if (cfg.minAgePercentile > 0) {
        const pct = ropeAgePercentile(rope, bar, ropes, cfg.barMs);
        if (pct < cfg.minAgePercentile) {
          nSkippedHistory += 1;
          log.push({
            bar, kind: 'skip-history', form: 'relative', ropeId,
            agePercentile: pct, minAgePercentile: cfg.minAgePercentile,
          });
          return false;
        }
      }
      if (cfg.minTouchesPerDay > 0) {
        const rate = ageDays > 0 ? touches / ageDays : (touches > 0 ? Infinity : 0);
        if (rate < cfg.minTouchesPerDay) {
          nSkippedHistory += 1;
          log.push({
            bar, kind: 'skip-history', form: 'relative', ropeId,
            touchesPerDay: rate, minTouchesPerDay: cfg.minTouchesPerDay,
          });
          return false;
        }
      }
      return true;
    }

    return true;
  }

  function openPos(bar, price, d, reason, ropeId) {
    if (!passesPotential(bar, price, d)) return false;
    if (!passesTargetRisk(bar, price, d)) return false;
    if (!passesCorridor(bar, price, d)) return false;
    if (ropeId != null && !passesHistory(bar, ropeId)) return false;
    const a = atr[bar] || atr[bar - 1] || 0;
    const corridor = corridorAtOpen(ropes, bar, price, d, a, cfg);
    const size = notional();
    const openFee = chargeFee(size);
    pos = {
      dir: d, entry: price, size, bar, ropeId: ropeId ?? null,
      openFee, corridor,
    };
    log.push({
      bar, kind: 'open', side: d > 0 ? 'long' : 'short', price, reason,
      ropeId: ropeId ?? null, corridor: corridor.group, balance,
    });
    return true;
  }

  function closeLeg(leg, bar, price, reason, asTrade) {
    if (!leg) return null;
    const pnl = leg.dir * (price - leg.entry) / leg.entry * leg.size;
    const fee = chargeFee(leg.size);
    balance += pnl;
    if (asTrade) {
      const openFee = leg.openFee || 0;
      trades.push({
        from: leg.bar, to: bar, dir: leg.dir, entry: leg.entry, exit: price,
        pnl, fee, openFee,
        net: pnl - fee - openFee,
        reason,
        corridorGroup: leg.corridor?.group || null,
        corridor: leg.corridor || null,
      });
    }
    log.push({
      bar, kind: 'close', side: leg.dir > 0 ? 'long' : 'short', price, reason,
      pnl, balance,
    });
    return null;
  }

  function closePos(bar, price, reason) {
    pos = closeLeg(pos, bar, price, reason, true);
  }

  function openHedge(bar, price) {
    if (!pos || hedge) return;
    const size = pos.size;
    chargeFee(size);
    hedge = { dir: -pos.dir, entry: price, size, bar };
    log.push({
      bar, kind: 'hedge-open', side: hedge.dir > 0 ? 'long' : 'short',
      price, reason: 'pause-hedge', balance,
    });
  }

  function resolveHedge(bar, price, keepDir) {
    if (!hedge && !pos) return;
    if (!hedge) return;
    if (!pos) {
      if (hedge.dir === keepDir) {
        pos = hedge;
        hedge = null;
      } else {
        hedge = closeLeg(hedge, bar, price, 'hedge-lose', true);
      }
      return;
    }
    if (pos.dir === keepDir) {
      hedge = closeLeg(hedge, bar, price, 'hedge-lose', true);
    } else if (hedge.dir === keepDir) {
      pos = closeLeg(pos, bar, price, 'hedge-lose', true);
      pos = hedge;
      hedge = null;
      log.push({
        bar, kind: 'hedge-keep', side: pos.dir > 0 ? 'long' : 'short',
        price, reason: 'pause-hedge-resolve', balance,
      });
    } else {
      pos = closeLeg(pos, bar, price, 'hedge-flatten', true);
      hedge = closeLeg(hedge, bar, price, 'hedge-flatten', true);
    }
  }

  function applyFunding(bar) {
    if (!funding || (!pos && !hedge)) return;
    const t1 = candles[bar].t;
    const t0 = candles[bar - 1] ? candles[bar - 1].t : t1 - 1;
    while (fundingIdx < funding.length && funding[fundingIdx].t <= t0) fundingIdx += 1;
    while (fundingIdx < funding.length && funding[fundingIdx].t <= t1) {
      const rate = funding[fundingIdx].rate;
      for (const leg of [pos, hedge]) {
        if (!leg) continue;
        const pay = -leg.dir * rate * leg.size;
        balance += pay;
        totalFunding += pay;
        log.push({
          bar, kind: 'funding', side: leg.dir > 0 ? 'long' : 'short',
          rate, pay, balance, t: funding[fundingIdx].t,
        });
      }
      fundingIdx += 1;
    }
  }

  // Advance prior-touch counts up to (not including) events at bar `upToBar`
  // for completed episodes ending before that bar. Called as we process bars.
  let touchScan = 0;
  function advanceTouches(upToBar) {
    while (touchScan < eventsChrono.length && eventsChrono[touchScan].bar < upToBar) {
      const ev = eventsChrono[touchScan];
      if (ev.kind === 'bounce' || ev.kind === 'break') {
        priorTouches.set(ev.ropeId, (priorTouches.get(ev.ropeId) || 0) + 1);
      }
      touchScan += 1;
    }
  }

  const byBar = new Map();
  for (const ev of events) {
    if (!byBar.has(ev.bar)) byBar.set(ev.bar, []);
    byBar.get(ev.bar).push(ev);
  }

  for (let i = 1; i < candles.length; i++) {
    const price = candles[i].c;
    const a = atr[i] || atr[i - 1] || 0;
    const barEvents = byBar.get(i) || [];

    advanceTouches(i); // prior touches = episodes completed before this bar
    applyFunding(i);

    for (const ev of barEvents) {
      if (ev.kind === 'enter') {
        paused = true;
        pauseRope = ev.ropeId;
        log.push({ bar: i, kind: 'enter', side: ev.side, price, ropeId: ev.ropeId });
        if (cfg.pauseMode === 'close' && pos) closePos(i, price, 'pause-close');
        if (cfg.pauseMode === 'hedge' && pos) openHedge(i, price);
      } else if (ev.kind === 'bounce' || ev.kind === 'break') {
        log.push({
          bar: i, kind: ev.kind, side: ev.side, price, ropeId: ev.ropeId,
        });
        paused = false;
        pauseRope = null;

        if (cfg.pauseMode === 'hedge' && hedge) {
          if (dir == null) {
            hedge = closeLeg(hedge, i, price, 'hedge-orphan', true);
            dir = directionFromResolution(ev);
            if (dir != null && !pos) openPos(i, price, dir, 'start-' + ev.kind, ev.ropeId);
          } else if (ev.kind === 'bounce') {
            const keepDir = -dir;
            resolveHedge(i, price, keepDir);
            dir = keepDir;
            if (!pos) openPos(i, price, dir, 'bounce-reverse', ev.ropeId);
          } else {
            resolveHedge(i, price, dir);
            if (!pos) openPos(i, price, dir, 'break-keep', ev.ropeId);
          }
          continue;
        }

        if (dir == null) {
          dir = directionFromResolution(ev);
          if (dir != null && !pos) openPos(i, price, dir, 'start-' + ev.kind, ev.ropeId);
        } else if (ev.kind === 'bounce') {
          dir = -dir;
          if (pos) closePos(i, price, 'bounce');
          openPos(i, price, dir, 'bounce-reverse', ev.ropeId);
        } else {
          if (!pos) openPos(i, price, dir, 'break-keep', ev.ropeId);
        }
      }
    }

    if (pos && !paused && !hedge && a > 0) {
      const move = Math.abs(price - pos.entry);
      if (move >= cfg.sharpMoveAtr * a) {
        const scan = cfg.scanAheadAtr * a;
        if (!ropeAhead(ropes, i, price, pos.dir, scan)) {
          closePos(i, price, 'stop-no-rope-ahead');
          dir = null;
        }
      }
    }
  }

  const last = candles[candles.length - 1].c;
  let equity = balance;
  if (pos) {
    equity += pos.dir * (last - pos.entry) / pos.entry * pos.size;
  }
  if (hedge) {
    equity += hedge.dir * (last - hedge.entry) / hedge.entry * hedge.size;
  }

  return {
    balance,
    equity,
    startBalance: cfg.startBalance,
    position: pos,
    hedge,
    direction: dir,
    trades,
    events,
    log,
    nContacts: events.filter(e => e.kind !== 'enter').length,
    nTrades: trades.length,
    nSkippedPotential,
    nSkippedTargetRisk,
    nSkippedCorridor,
    nSkippedHistory,
    nFeeOps,
    totalFees,
    totalFunding,
    fundingModelled: !!funding,
  };
}
