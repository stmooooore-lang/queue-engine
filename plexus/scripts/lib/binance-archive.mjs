/**
 * Perpetual-futures candles from the Binance static archive.
 *
 * Why an archive and not an exchange API: this project has answered the same
 * question three times and given the same answer each time - a live API is
 * rate-limited, geo-fenced and mutable, a file archive is none of those.
 * tendency_bot/run_verification.py records the third answer verbatim
 * ("CORRECTED 2026-07-21 (third time)"), and PRD-03 §9 the first.
 *
 * No key, no monthly quota, no user-agent games, and the files do not change -
 * so a run made today and a run made in August read the same bytes.
 *
 * Venue: Binance USDT-margined perpetuals. August measured Bybit linear
 * perpetuals. Measured 2026-08-20 over 200 shared hourly bars: the two agree to
 * a median of 0.57 bp, worst 2.85 bp. Bybit's own SPOT book - which is what the
 * CryptoCompare route returned - sits 5.44 bp away from Bybit's perpetual, ten
 * times further. The archive is therefore closer to August than the route that
 * carried Bybit's name.
 *
 * Layout (verified 2026-08-20):
 *   data/futures/um/monthly/klines/<SYM>/<TF>/<SYM>-<TF>-YYYY-MM.zip
 *   data/futures/um/daily/klines/<SYM>/<TF>/<SYM>-<TF>-YYYY-MM-DD.zip
 * Monthly files appear only after a month closes; the running month comes from
 * daily files.
 */
import zlib from "node:zlib";

const BASE = "https://data.binance.vision/data/futures/um";

/** Read the single member of a Binance archive zip. No dependency, no unzip binary. */
function unzipSingle(buf) {
  // End of central directory: signature 0x06054b50, at most 22 + comment bytes
  // from the end. Binance writes no comment, but scan anyway.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOff) !== 0x02014b50) throw new Error("not a zip: bad central directory");

  const method = buf.readUInt16LE(cdOff + 10);
  const compSize = buf.readUInt32LE(cdOff + 20);
  const localOff = buf.readUInt32LE(cdOff + 42);
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("not a zip: bad local header");

  // The local header carries its OWN name and extra lengths; they may differ
  // from the central directory's, and using the wrong ones shifts the data.
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip compression method ${method} not supported`);
}

/** Binance kline CSV -> candles. Handles the header row and microsecond stamps. */
function parseKlines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) < 48 || line.charCodeAt(0) > 57) continue;  // header or blank
    const f = line.split(",");
    let t = Number(f[0]);
    // Binance moved some datasets to microseconds; anything past ~2286 in ms is
    // really µs. Normalise rather than silently producing candles in year 57000.
    if (t > 1e14) t = Math.floor(t / 1000);
    const o = +f[1], h = +f[2], l = +f[3], c = +f[4];
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    out.push({ t, o, h, l, c });
  }
  return out;
}

// Cache per symbol+interval: which month files were already pulled, and the
// candles they yielded. 1h and 4h come from the same hourly files, and 4h needs
// the deeper history - without this the second one re-downloads everything the
// first already had.
const memo = new Map();

const PARALLEL = 6;   // polite, and turns ~800 sequential pulls into ~2 minutes

async function fetchZip(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;                    // not published yet
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseKlines(unzipSingle(Buffer.from(await res.arrayBuffer())).toString("utf8"));
}

async function fetchAll(urls) {
  const out = [];
  for (let i = 0; i < urls.length; i += PARALLEL) {
    const batch = await Promise.all(urls.slice(i, i + PARALLEL).map(fetchZip));
    for (const page of batch) if (page) out.push(...page);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * @param {object} o
 * @param {string} o.symbol   e.g. "BTCUSDT"
 * @param {"1h"|"1d"} o.tf    archive interval
 * @param {number} o.cap      candles wanted, newest backwards
 * @param {(m: string) => void} [o.log]
 */
export async function fetchArchive({ symbol, tf, cap, log = () => {} }) {
  const key = `${symbol}/${tf}`;
  let box = memo.get(key);
  if (!box) memo.set(key, (box = { months: new Set(), rows: new Map() }));

  const perDay = tf === "1h" ? 24 : 1;
  // One extra month so a partial first month still leaves enough bars.
  const months = Math.ceil(cap / (perDay * 28)) + 1;
  const now = new Date();

  const want = [];
  for (let i = months; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    want.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  }
  const missing = want.filter((m) => !box.months.has(m));

  if (missing.length) {
    const rows = await fetchAll(
      missing.map((m) => `${BASE}/monthly/klines/${symbol}/${tf}/${symbol}-${tf}-${m}.zip`),
    );
    for (const r of rows) box.rows.set(r.t, r);
    for (const m of missing) box.months.add(m);
  }

  // The running month lives only in daily files, and today's is not written
  // until the day closes - so the series ends yesterday. That is a property of
  // an archive, not a fault: it is also why two runs read the same bytes.
  if (!box.today || box.today !== now.getUTCDate()) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const days = [];
    for (const d = new Date(first); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    }
    const rows = await fetchAll(
      days.map((s) => `${BASE}/daily/klines/${symbol}/${tf}/${symbol}-${tf}-${s}.zip`),
    );
    for (const r of rows) box.rows.set(r.t, r);
    box.today = now.getUTCDate();
  }

  const series = [...box.rows.values()].sort((a, b) => a.t - b.t);
  log(`archive ${key}: ${series.length} bars, ${missing.length} new month files`);
  return series.slice(-cap);
}
