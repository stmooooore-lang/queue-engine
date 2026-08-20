/**
 * Acceptance check for the crypto route.
 *
 *   node scripts/crypto-route-check.mjs
 *
 * No key and no secret: the candles come from the Binance static archive.
 * Answers in seconds what the hour-long corridor run would otherwise answer
 * last: do all five pairs load, how fresh is the archive, and how far the
 * series sits from the Bybit perpetual August measured.
 *
 * Where api.bybit.com is reachable - it is from the founder's Mac - the check
 * compares bar by bar and prints the distance in basis points. Where it is not,
 * it reports the archive alone and says so. Exit code 1 if any pair fails.
 */
import { fetchArchive } from "./lib/binance-archive.mjs";

const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];
const N = Number(process.env.CHECK_BARS || 200);

async function bybitCloses(symbol) {
  const u =
    `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}` +
    `&interval=60&limit=${N}`;
  const j = await (await fetch(u, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PlexusResearch/1.0)" },
  })).json();
  if (j.retCode && j.retCode !== 0) throw new Error(j.retMsg || String(j.retCode));
  return new Map((j.result?.list || []).map((x) => [+x[0], +x[4]]));
}

let failed = 0;
for (const symbol of PAIRS) {
  let series;
  try {
    series = await fetchArchive({ symbol, tf: "1h", cap: N });
  } catch (e) {
    console.log(`${symbol.padEnd(8)} FAIL  ${e.message}`);
    failed++;
    continue;
  }
  if (series.length < N / 2) {
    console.log(`${symbol.padEnd(8)} FAIL  only ${series.length} bars of ${N}`);
    failed++;
    continue;
  }
  const last = new Date(series.at(-1).t).toISOString().slice(0, 16);
  const lagH = ((Date.now() - series.at(-1).t) / 3600e3).toFixed(0);
  let verdict = "bybit unreachable from here - archive only";
  try {
    const B = await bybitCloses(symbol);
    const d = [];
    for (const bar of series) {
      const c = B.get(bar.t);
      if (c) d.push(Math.abs(bar.c - c) / c * 1e4);
    }
    d.sort((a, b) => a - b);
    verdict = d.length
      ? `vs Bybit perp: median ${d[d.length >> 1].toFixed(2)} bp, worst ${d.at(-1).toFixed(2)} bp over ${d.length} bars`
      : "no shared timestamps with Bybit";
  } catch {
    // the cloud case, not a failure
  }
  console.log(`${symbol.padEnd(8)} ok    ${String(series.length).padStart(4)} bars, last ${last} (${lagH}h ago)  ${verdict}`);
}

console.log(failed ? `\n${failed} of ${PAIRS.length} pairs failed` : `\nall ${PAIRS.length} pairs load`);
process.exit(failed ? 1 : 0);
