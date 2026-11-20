// Strategy report: replays the bot's exact live rules on 5-minute data for the
// whole S&P 500 over the last ~60 sessions (scans at 09:55 + every 30 min,
// same filters, sizing, breakeven/trailing stops, target, flat by 15:51 ET).
import { SP500 } from './sp500.js';
import { pool, etDate } from './market.js';
import { CONFIG } from './engine.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const r2 = n => Math.round(n * 100) / 100;

async function sparkIntraday(group) {
  for (let i = 0; i < 3; i++) {
    const host = i % 2 ? 'https://query2.finance.yahoo.com' : 'https://query1.finance.yahoo.com';
    try {
      const r = await fetch(`${host}/v7/finance/spark?symbols=${encodeURIComponent(group.join(','))}&range=60d&interval=5m`, { headers: UA });
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 400 * (i + 1)));
  }
  return null;
}

// last index with ts <= t (bars sorted), starting hint
function idxAt(ts, t) {
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

export async function runBacktest() {
  const t0 = Date.now();
  const groups = [];
  for (let i = 0; i < SP500.length; i += 20) groups.push(SP500.slice(i, i + 20));
  const results = await pool(groups, 6, sparkIntraday);

  // days[date][sym] = { ts:[], c:[] }
  const days = new Map();
  const sessions = new Map(); // date -> {open, close}
  let loaded = 0;
  for (const res of results) {
    for (const item of res?.spark?.result || []) {
      const x = item.response?.[0];
      const ts = x?.timestamp, cl = x?.indicators?.quote?.[0]?.close;
      if (!ts || !cl) continue;
      loaded++;
      for (let i = 0; i < ts.length; i++) {
        if (cl[i] == null) continue;
        const d = etDate(ts[i]);
        if (!days.has(d)) days.set(d, new Map());
        const m = days.get(d);
        if (!m.has(item.symbol)) m.set(item.symbol, { ts: [], c: [] });
        const b = m.get(item.symbol); b.ts.push(ts[i]); b.c.push(cl[i]);
        const s = sessions.get(d) || { open: Infinity, close: 0 };
        s.open = Math.min(s.open, ts[i]); s.close = Math.max(s.close, ts[i] + 300);
        sessions.set(d, s);
      }
    }
  }
  const dates = [...days.keys()].sort();
  // previous close per (date, sym)
  const prevClose = new Map();
  for (let i = 1; i < dates.length; i++) {
    const prev = days.get(dates[i - 1]);
    const pc = new Map();
    for (const [sym, b] of prev) pc.set(sym, b.c[b.c.length - 1]);
    prevClose.set(dates[i], pc);
  }

  let cash = CONFIG.startCash;
  let peak = cash, maxDD = 0, maxDDPct = 0;
  const curve = [], trades = [];
  const slip = CONFIG.slippagePct / 100;

  for (let di = 1; di < dates.length; di++) {
    const date = dates[di];
    const bars = days.get(date);
    const pc = prevClose.get(date);
    const { open, close } = sessions.get(date);
    if ((close - open) / 60 < 200) continue; // skip partial sessions in the data
    let positions = [];
    const tradedToday = new Set();
    const priceAt = (sym, t) => { const b = bars.get(sym); if (!b) return null; const i = idxAt(b.ts, t - 300); return i < 0 ? null : b.c[i]; };
    const equityAt = t => positions.reduce((a, p) => a + p.shares * (priceAt(p.sym, t) ?? p.entry), cash);
    const exit = (p, px, reason, t) => {
      const fill = px * (1 - slip);
      const pnl = (fill - p.entry) * p.shares;
      cash += fill * p.shares;
      positions = positions.filter(x => x !== p);
      trades.push({ date, time: t, inTime: p.inTime, sym: p.sym, gap: p.gap, shares: p.shares, entry: r2(p.entry), exit: r2(fill), stop: r2(p.stop0), target: r2(p.target), be: r2(p.be), pnl: r2(pnl), r: r2((fill - p.entry) / p.R), reason });
    };
    const flatAt = close - (CONFIG.flattenLastMin + 1) * 60;
    for (let t = open + 600; t <= flatAt; t += 600) { // a tick every 10 minutes, like live
      // manage positions
      for (const p of [...positions]) {
        const px = priceAt(p.sym, t); if (px == null) continue;
        if (px <= p.stop) { exit(p, Math.min(px, p.stop), p.stage === 'open' ? 'stopped out' : 'stop hit', t); continue; }
        if (px >= p.target) { exit(p, px, 'target hit', t); continue; }
        if (p.stage === 'open' && px >= p.be) { p.stop = p.entry; p.stage = 'breakeven'; }
        if (px >= p.entry + 2 * p.R && px - p.R > p.stop) { p.stop = px - p.R; p.stage = 'trailing'; }
      }
      // scan
      const sinceOpen = (t - open) / 60;
      const toClose = (close - t) / 60;
      const isScan = sinceOpen >= CONFIG.firstScanMin && ((sinceOpen - CONFIG.firstScanMin) % CONFIG.scanEveryMin) < 10;
      if (isScan && toClose > CONFIG.noEntriesLastMin) {
        const surv = [];
        for (const [sym, b] of bars) {
          const prev = pc?.get(sym); if (!prev) continue;
          const i = idxAt(b.ts, t - 300); if (i < 0) continue;
          const price = b.c[i], o = b.c[0];
          let low = Infinity; for (let k = 0; k <= i; k++) if (b.c[k] < low) low = b.c[k];
          const chg = (price / prev - 1) * 100;
          if (chg >= CONFIG.minGapPct && price >= CONFIG.minPrice && o >= prev * (1 + CONFIG.minOpenGapPct / 100) && price >= o * 0.995)
            surv.push({ sym, chg, price, low });
        }
        surv.sort((a, b) => b.chg - a.chg);
        for (const s of surv) {
          if (positions.length >= CONFIG.maxPositions) break;
          if (tradedToday.has(s.sym)) continue;
          const eq = equityAt(t);
          const entry = s.price * (1 + slip);
          let stop = Math.min(s.low * 0.998, entry * (1 - CONFIG.stopMinPct / 100));
          stop = Math.max(stop, entry * (1 - CONFIG.stopMaxPct / 100));
          const R = entry - stop; if (R <= 0) continue;
          let shares = Math.floor(eq * CONFIG.riskPct / 100 / R);
          shares = Math.min(shares, Math.floor(eq * CONFIG.maxPositionPct / 100 / entry), Math.floor(cash / entry));
          if (shares < 1) continue;
          cash -= entry * shares;
          positions.push({ sym: s.sym, gap: r2(s.chg), shares, entry, stop, stop0: stop, inTime: t, R, be: entry + R, target: entry + CONFIG.targetR * R, stage: 'open' });
          tradedToday.add(s.sym);
        }
      }
    }
    for (const p of [...positions]) exit(p, priceAt(p.sym, flatAt + 60) ?? p.entry, 'closed before bell', flatAt);
    peak = Math.max(peak, cash);
    if (peak - cash > maxDD) { maxDD = peak - cash; maxDDPct = (peak - cash) / peak * 100; }
    curve.push({ date, v: r2(cash) });
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const gw = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = -trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  return {
    v: 2,
    computedAt: Math.floor(Date.now() / 1000),
    method: '5-minute replay of live rules',
    from: curve[0]?.date, to: curve[curve.length - 1]?.date, sessions: curve.length, universe: loaded,
    startCash: CONFIG.startCash,
    totalPnl: r2(cash - CONFIG.startCash),
    totalPct: r2((cash / CONFIG.startCash - 1) * 100),
    trades: trades.length, wins, winRate: trades.length ? r2(wins / trades.length * 100) : 0,
    avgWin: wins ? r2(gw / wins) : 0, avgLoss: trades.length - wins ? r2(-gl / (trades.length - wins)) : 0,
    profitFactor: gl ? r2(gw / gl) : null,
    maxDD: r2(maxDD), maxDDPct: r2(maxDDPct),
    curve, recent: trades.slice(-80).reverse(),
    secs: r2((Date.now() - t0) / 1000),
  };
}
