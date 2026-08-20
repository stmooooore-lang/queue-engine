/**
 * The data layer of the corridor work: which instruments, which timeframes, and
 * how a series is fetched. Shared so that two scripts cannot drift into
 * measuring different things and calling both of them "the corridor".
 */
import { fetchArchive } from "./binance-archive.mjs";

// `source` is the venue the candles belong to; `route` is how they are reached.
//
// Crypto changed venue on 2026-08-20 and the record says so rather than hiding
// it. August measured Bybit linear perpetuals over their live API. That API is
// rate-limited and mutable, and every attempt to reach it from a scheduled
// runner ended somewhere worse - the last one at a hundred calls a month. The
// candles now come from the Binance static archive: no key, no quota, and the
// files do not change, so two runs read the same bytes.
//
// The venues are not the same and the number says how far apart: 0.57 bp median
// over 200 shared hourly bars, worst 2.85. For comparison, Bybit's own spot
// book sits 5.44 bp from Bybit's perpetual. Closer to August than the road that
// still carried Bybit's name.
const INSTRUMENTS = [
  { id: "BTCUSDT", cls: "crypto", source: "binance-perp", route: "archive", symbol: "BTCUSDT" },
  { id: "ETHUSDT", cls: "crypto", source: "binance-perp", route: "archive", symbol: "ETHUSDT" },
  { id: "SOLUSDT", cls: "crypto", source: "binance-perp", route: "archive", symbol: "SOLUSDT" },
  { id: "XRPUSDT", cls: "crypto", source: "binance-perp", route: "archive", symbol: "XRPUSDT" },
  { id: "BNBUSDT", cls: "crypto", source: "binance-perp", route: "archive", symbol: "BNBUSDT" },
  { id: "EURUSD", cls: "forex", source: "yahoo", route: "yahoo", symbol: "EURUSD=X" },
  { id: "GBPUSD", cls: "forex", source: "yahoo", route: "yahoo", symbol: "GBPUSD=X" },
  { id: "NDX", cls: "index", source: "yahoo", route: "yahoo", symbol: "^NDX" },
  { id: "SPX", cls: "index", source: "yahoo", route: "yahoo", symbol: "^GSPC" },
];

// Caps = practical source limits (Yahoo 60m ≈ 2y; Bybit matched to that for parity).
// Daily: Yahoo range=max; crypto paginates to cap. The cap names and the
// BYBIT_* overrides are unchanged from August — the venue is still Bybit, only
// the road changed — and `arch` names the archive interval. There is no 4h
// archive, so 4h is built from hourly by the same aggregateHours()
// that builds it for Yahoo; both bucket on absolute UTC boundaries, which is
// where Bybit's own 240 bars start.
const TFS = [
  {
    key: "1h", barKey: "60", yahoo: "60m", arch: "1h", yahooRange: "2y",
    // ~2y hourly when feasible; override BYBIT_1H. Default 10000 (~14 months):
    // detectRopes cost grows steeply; Yahoo 60m max is ~2y — stated per cell.
    bybitCap: Number(process.env.BYBIT_1H || 10000),
  },
  {
    key: "4h", barKey: "240", yahoo: "60m", arch: "1h", yahooRange: "2y",
    aggregateHours: 4,
    bybitCap: Number(process.env.BYBIT_4H || 4400),
  },
  {
    // Yahoo range=max returns ~160–270 pts for indices/FX; 10y is usable daily.
    key: "1D", barKey: "D", yahoo: "1d", arch: "1d", yahooRange: "10y",
    bybitCap: Number(process.env.BYBIT_1D || 3000),
  },
];


async function fetchYahoo(symbol, interval, range) {
  const u =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}`;
  const j = await (await fetch(u, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PlexusResearch/1.0)" },
  })).json();
  const r = j.chart?.result?.[0];
  if (!r?.timestamp?.length) {
    throw new Error(`yahoo empty ${symbol} ${interval} ${range}: ${JSON.stringify(j.chart?.error || j)}`);
  }
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ t: r.timestamp[i] * 1000, o, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

function aggregateHours(candles, hours) {
  const barMs = hours * 3600e3;
  const buckets = new Map();
  for (const b of candles) {
    const t0 = Math.floor(b.t / barMs) * barMs;
    const cur = buckets.get(t0);
    if (!cur) buckets.set(t0, { t: t0, o: b.o, h: b.h, l: b.l, c: b.c });
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// `log` is passed in: this module has no logger of its own, and the caller's
// progress file is the only place a load line is useful.
async function loadSeries(inst, tf, log = () => {}) {
  if (inst.route === "archive") {
    // 4h is folded here rather than downloaded: the archive publishes hourly
    // and daily only. Checked against Bybit's own 240 bars on all five pairs -
    // 495 shared bars, every OHLC value identical - because both bucket on
    // absolute UTC boundaries.
    const hours = tf.aggregateHours || 1;
    const series = await fetchArchive({
      symbol: inst.symbol,
      tf: tf.arch,
      cap: tf.bybitCap * (tf.arch === "1h" ? hours : 1),
      log,
    });
    return tf.aggregateHours ? aggregateHours(series, tf.aggregateHours) : series;
  }
  if (tf.aggregateHours) {
    const hourly = await fetchYahoo(inst.symbol, "60m", tf.yahooRange);
    return aggregateHours(hourly, tf.aggregateHours);
  }
  return fetchYahoo(inst.symbol, tf.yahoo, tf.yahooRange);
}


export { INSTRUMENTS, TFS, loadSeries, aggregateHours };
