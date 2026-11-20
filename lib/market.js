// Market data: live quotes (batched) + market clock + daily history.
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function getJSON(path, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const host = HOSTS[i % HOSTS.length];
    try {
      const r = await fetch(host + path, { headers: UA, cache: 'no-store' });
      if (r.ok) return await r.json();
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    await new Promise(res => setTimeout(res, 300 * (i + 1)));
  }
  throw lastErr;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

// Returns { SYMBOL: {price, prevClose, open, high, low, volume, changePct, time} }
export async function getQuotes(symbols) {
  const groups = chunk([...new Set(symbols)], 20);
  const res = await pool(groups, 8, g =>
    getJSON(`/v7/finance/spark?symbols=${encodeURIComponent(g.join(','))}&range=1d&interval=5m`));
  const quotes = {};
  let meta0 = null;
  for (const r of res) {
    for (const item of r?.spark?.result || []) {
      const resp = item.response?.[0];
      const m = resp?.meta;
      if (!m || m.regularMarketPrice == null) continue;
      if (!meta0) meta0 = m;
      const closes = resp.indicators?.quote?.[0]?.close || [];
      const firstBar = closes.find(v => v != null);
      const prevClose = m.chartPreviousClose ?? m.previousClose;
      const price = m.regularMarketPrice;
      quotes[item.symbol] = {
        price,
        prevClose,
        open: firstBar ?? price,
        high: m.regularMarketDayHigh ?? price,
        low: m.regularMarketDayLow ?? price,
        volume: m.regularMarketVolume ?? 0,
        changePct: prevClose ? (price / prevClose - 1) * 100 : 0,
        time: m.regularMarketTime,
        period: m.currentTradingPeriod?.regular,
      };
    }
  }
  return quotes;
}

// Market clock from the exchange's own trading-period data (handles holidays & early closes).
export async function getClock() {
  const d = await getJSON(`/v8/finance/chart/SPY?range=1d&interval=5m`);
  const m = d.chart.result[0].meta;
  const p = m.currentTradingPeriod.regular;
  const now = Math.floor(Date.now() / 1000);
  const isOpen = now >= p.start && now < p.end;
  return {
    now, isOpen,
    openTs: p.start, closeTs: p.end,
    minutesSinceOpen: (now - p.start) / 60,
    minutesToClose: (p.end - now) / 60,
    sessionDate: etDate(p.start),
    spy: { price: m.regularMarketPrice, prevClose: m.chartPreviousClose },
  };
}

export async function getDaily(symbol, range = '6mo') {
  const d = await getJSON(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, 2);
  const r = d.chart.result[0];
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }))
    .filter(b => b.o != null && b.c != null && b.h != null && b.l != null);
}

export { pool };

const _dateCache = new Map();
export function etDate(ts) {
  const h = Math.floor(ts / 3600);
  let d = _dateCache.get(h);
  if (!d) {
    d = new Date(h * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    _dateCache.set(h, d);
  }
  return d;
}
export function etTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
}
