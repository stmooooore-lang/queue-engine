/**
 * Bybit candles by way of CryptoCompare (CoinDesk Data).
 *
 * Why the detour: api.bybit.com refuses US addresses, and the nightly run is a
 * US GitHub runner — so the cloud verdict has been computed on forex and
 * indices alone, four instruments out of nine. CryptoCompare relays the same
 * venue's candles when the venue is named (`e=Bybit`), which keeps the series
 * comparable with the 2026-08-03 measurement: same exchange, different road.
 *
 * The key travels in the `authorization` header, never in the URL. A URL with
 * a key inside reaches progress.log, and progress.log is uploaded as a run
 * artifact.
 *
 * Anonymous calls no longer work: since the CoinDesk migration the endpoint
 * answers 401 `API key required` without one (measured 2026-08-20). So a
 * missing key is a hard failure here, not a quiet downgrade.
 */

const BASE = "https://min-api.cryptocompare.com/data/v2";

// limit is capped at 2000 per call and the response is inclusive of both ends,
// so a call returns limit + 1 points.
const PAGE = 2000;

/**
 * @param {object} o
 * @param {string} o.fsym      base symbol, e.g. "BTC"
 * @param {string} o.tsym      quote symbol, e.g. "USDT"
 * @param {"hour"|"day"} o.unit
 * @param {number} o.cap       how many candles to gather, newest backwards
 * @param {string} o.exchange  venue to ask for; "Bybit" keeps August parity
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<Array<{t:number,o:number,h:number,l:number,c:number}>>}
 */
export async function fetchCryptoCompare({ fsym, tsym, unit, cap, exchange = "Bybit", log = () => {} }) {
  const key = process.env.PLEXUS_CRYPTOCOMPARE_KEY;
  if (!key) {
    throw new Error(
      "PLEXUS_CRYPTOCOMPARE_KEY is not set — CryptoCompare answers 401 without it. " +
        "In the cloud it comes from the queue-engine Actions secret of that name.",
    );
  }
  const path = unit === "day" ? "histoday" : "histohour";
  const label = `${fsym}${tsym}@${exchange} ${unit}`;

  let rows = [];
  let toTs = "";
  while (rows.length < cap) {
    const lim = Math.min(PAGE, cap - rows.length);
    let u = `${BASE}/${path}?fsym=${fsym}&tsym=${tsym}&e=${exchange}&limit=${lim}`;
    if (toTs) u += `&toTs=${toTs}`;

    const res = await fetch(u, {
      cache: "no-store",
      headers: { authorization: `Apikey ${key}` },
    });
    let j;
    try {
      j = await res.json();
    } catch {
      throw new Error(`cryptocompare ${label}: HTTP ${res.status}, body is not JSON`);
    }
    // Two error shapes live side by side: the legacy Response/Message pair and
    // the gateway's Err object. Neither is guaranteed, so check both.
    const err = j.Err && (j.Err.message || j.Err.type) ? j.Err.message || `type ${j.Err.type}` : null;
    if (err) throw new Error(`cryptocompare ${label}: HTTP ${res.status}: ${err}`);
    if (j.Response === "Error") throw new Error(`cryptocompare ${label}: ${j.Message}`);
    if (!Array.isArray(j.Data?.Data)) {
      throw new Error(`cryptocompare ${label}: HTTP ${res.status}, no Data.Data in the answer`);
    }

    // Rows before the venue's own history begin come back as all-zero padding.
    const page = j.Data.Data.filter((x) => x.close > 0 && x.high > 0);
    if (!page.length) break;

    // With e= named there should be no conversion. If one happened anyway the
    // prices are synthesised from another pair and are not Bybit's — fail
    // rather than let them into a measurement that claims to be comparable.
    const conv = page.find((x) => x.conversionType && x.conversionType !== "direct");
    if (conv) {
      throw new Error(
        `cryptocompare ${label}: conversionType=${conv.conversionType} ` +
          `(via ${conv.conversionSymbol || "?"}) — not the venue's own prices`,
      );
    }

    rows = rows.concat(
      page.map((x) => ({ t: x.time * 1000, o: x.open, h: x.high, l: x.low, c: x.close })),
    );

    const earliest = Math.min(...page.map((x) => x.time));
    toTs = String(earliest - 1);
    log(`cryptocompare ${label}: +${page.length} rows, ${rows.length}/${cap}`);

    // Short page means the history ran out.
    if (page.length < lim) break;
  }

  const byT = new Map();
  for (const r of rows) byT.set(r.t, r);
  return [...byT.values()].sort((a, b) => a.t - b.t).slice(-cap);
}
