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
  pauseMode: 'hold',   // 'hold' | 'close' — while price is inside a rope
  sizePct: 10,         // position size as % of balance
  sharpMoveAtr: 1.5,   // stop: what counts as a sharp move (× ATR)
  scanAheadAtr: 2.0,   // stop: how far ahead to scan for a rope (× ATR)
  feePct: 0.0005,      // 0.05% — modelled from the first run (PRD-03 §11)
  startBalance: 10000,
};

/** Direction after a contact with no prior position (geometric read). */
function directionFromResolution(ev) {
  if (ev.kind === 'bounce') return ev.side === 'above' ? 1 : -1;
  if (ev.kind === 'break') return ev.side === 'above' ? 1 : -1;
  return null;
}

/** Is there a live rope band ahead of price within scan distance? */
function ropeAhead(ropes, bar, price, dir, scanDist) {
  for (const r of ropes) {
    if (r.dead && r.deathBar != null && bar >= r.deathBar) continue;
    let band = null;
    for (const [i, b] of r.bands) {
      if (i === bar) { band = b; break; }
    }
    if (!band) continue;
    const mid = (band[0] + band[1]) / 2;
    if (dir > 0 && mid > price && (mid - price) <= scanDist) return true;
    if (dir < 0 && mid < price && (price - mid) <= scanDist) return true;
  }
  return false;
}

/**
 * runInstrument(candles, atr, ropes, tradeCfg) -> run summary
 * ropes = engine output for the loaded history (not the zoomed viewport).
 */
function emptyRun(cfg) {
  return {
    balance: cfg.startBalance,
    equity: cfg.startBalance,
    startBalance: cfg.startBalance,
    position: null,
    direction: null,
    trades: [],
    events: [],
    log: [],
    nContacts: 0,
    nTrades: 0,
  };
}

export function runInstrument(candles, atr, ropes, tradeCfg = {}) {
  const cfg = { ...DEFAULT_TRADE, ...tradeCfg };
  if (!candles || candles.length < 2) return emptyRun(cfg);

  // S10-C8: pad = 0 — decision boundary is the rope's own [lo, hi].
  const events = contactEvents(ropes || [], candles, {});

  let balance = cfg.startBalance;
  let dir = null;          // +1 long, -1 short, null = not yet set
  let pos = null;          // { dir, entry, size }
  let paused = false;
  let pauseRope = null;
  const trades = [];
  const log = [];

  function notional() {
    return balance * (cfg.sizePct / 100);
  }

  function openPos(bar, price, d, reason) {
    const size = notional();
    const fee = size * cfg.feePct;
    balance -= fee;
    pos = { dir: d, entry: price, size, bar };
    log.push({ bar, kind: 'open', side: d > 0 ? 'long' : 'short', price, reason, balance });
  }

  function closePos(bar, price, reason) {
    if (!pos) return;
    const pnl = pos.dir * (price - pos.entry) / pos.entry * pos.size;
    const fee = pos.size * cfg.feePct;
    balance += pnl - fee;
    trades.push({
      from: pos.bar, to: bar, dir: pos.dir, entry: pos.entry, exit: price, pnl, fee,
    });
    log.push({
      bar, kind: 'close', side: pos.dir > 0 ? 'long' : 'short', price, reason,
      pnl, balance,
    });
    pos = null;
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

    for (const ev of barEvents) {
      if (ev.kind === 'enter') {
        paused = true;
        pauseRope = ev.ropeId;
        log.push({ bar: i, kind: 'enter', side: ev.side, price, ropeId: ev.ropeId });
        if (cfg.pauseMode === 'close' && pos) closePos(i, price, 'pause-close');
      } else if (ev.kind === 'bounce' || ev.kind === 'break') {
        log.push({
          bar: i, kind: ev.kind, side: ev.side, price, ropeId: ev.ropeId,
        });
        paused = false;
        pauseRope = null;
        if (dir == null) {
          dir = directionFromResolution(ev);
          if (dir != null && !pos) openPos(i, price, dir, 'start-' + ev.kind);
        } else if (ev.kind === 'bounce') {
          dir = -dir;
          if (pos) closePos(i, price, 'bounce');
          openPos(i, price, dir, 'bounce-reverse');
        } else {
          if (!pos) openPos(i, price, dir, 'break-keep');
        }
      }
    }

    if (pos && !paused && a > 0) {
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

  return {
    balance,
    equity,
    startBalance: cfg.startBalance,
    position: pos,
    direction: dir,
    trades,
    events,
    log,
    nContacts: events.filter(e => e.kind !== 'enter').length,
    nTrades: trades.length,
  };
}
