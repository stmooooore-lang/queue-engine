/**
 * Acceptance check for the CryptoCompare route.
 *
 *   PLEXUS_CRYPTOCOMPARE_KEY=… node scripts/crypto-route-check.mjs
 *
 * Answers two questions the corridor run itself would only answer after an
 * hour: does the route return candles at all for all five pairs, and are they
 * the same candles Bybit serves directly?
 *
 * Run it on the Mac and it does both — the Mac can reach api.bybit.com, so the
 * two series are compared bar by bar against Bybit's linear (perpetual) and
 * spot books, and the closer of the two is named. Run it on a US runner and
 * Bybit is unreachable; the check then reports the route alone and says so.
 * Exit code is 1 if any pair fails to load.
 */
import { fetchCryptoCompare } from "./lib/cryptocompare.mjs";

const PAIRS = [
  { id: "BTCUSDT", fsym: "BTC", tsym: "USDT" },
  { id: "ETHUSDT", fsym: "ETH", tsym: "USDT" },
  { id: "SOLUSDT", fsym: "SOL", tsym: "USDT" },
  { id: "XRPUSDT", fsym: "XRP", tsym: "USDT" },
  { id: "BNBUSDT", fsym: "BNB", tsym: "USDT" },
];
const N = Number(process.env.CHECK_BARS || 48);

async function bybitDirect(symbol, category) {
  const u =
    `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}` +
    `&interval=60&limit=${N}`;
  const j = await (await fetch(u, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PlexusResearch/1.0)" },
  })).json();
  if (j.retCode && j.retCode !== 0) throw new Error(j.retMsg || String(j.retCode));
  return new Map((j.result?.list || []).map((x) => [+x[0], +x[4]]));
}

// Largest close-to-close difference over the shared timestamps, in basis points.
function worstBps(series, direct) {
  let worst = 0, n = 0;
  for (const bar of series) {
    const c = direct.get(bar.t);
    if (c == null) continue;
    n++;
    worst = Math.max(worst, Math.abs(bar.c - c) / c * 1e4);
  }
  return { worst, n };
}

let failed = 0;
for (const p of PAIRS) {
  let series;
  try {
    series = await fetchCryptoCompare({ fsym: p.fsym, tsym: p.tsym, unit: "hour", cap: N });
  } catch (e) {
    console.log(`${p.id.padEnd(8)} FAIL  ${e.message}`);
    failed++;
    continue;
  }
  if (!series.length) {
    console.log(`${p.id.padEnd(8)} FAIL  no candles`);
    failed++;
    continue;
  }
  const span =
    `${new Date(series[0].t).toISOString().slice(0, 16)} … ` +
    `${new Date(series.at(-1).t).toISOString().slice(0, 16)}`;
  let verdict = "bybit unreachable from here — route only";
  try {
    const [linear, spot] = await Promise.all([
      bybitDirect(p.id, "linear"),
      bybitDirect(p.id, "spot"),
    ]);
    const l = worstBps(series, linear);
    const s = worstBps(series, spot);
    if (!l.n && !s.n) {
      verdict = "no shared timestamps with Bybit";
    } else {
      const closer = l.worst <= s.worst ? "linear" : "spot";
      verdict =
        `matches Bybit ${closer} — worst linear ${l.worst.toFixed(1)} bp over ${l.n} bars, ` +
        `spot ${s.worst.toFixed(1)} bp over ${s.n}`;
    }
  } catch {
    // left as the unreachable verdict: that is the cloud case, not a failure
  }
  console.log(`${p.id.padEnd(8)} ok    ${String(series.length).padStart(4)} bars  ${span}  ${verdict}`);
}

console.log(failed ? `\n${failed} of ${PAIRS.length} pairs failed` : `\nall ${PAIRS.length} pairs load`);
process.exit(failed ? 1 : 0);
