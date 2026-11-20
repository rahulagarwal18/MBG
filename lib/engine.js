// The autonomous trading loop.
// 1. Scan the market  2. Pull live quotes  3. Filter gappers  4. Execute w/ stop & target  5. Repeat
import { SP500 } from './sp500.js';
import { getQuotes, getClock, etTime, etDate } from './market.js';
import { readJSON, writeJSON } from './store.js';
import { notify } from './notify.js';

export const CONFIG = {
  startCash: 10000,
  riskPct: 1.5,            // % of equity risked per trade
  maxPositions: 4,
  maxPositionPct: 25,      // max % of equity in one position
  minGapPct: 3,            // keep only stocks up >= 3% on the day
  minOpenGapPct: 2,        // ...that also opened >= 2% above prior close
  minPrice: 5,
  stopMinPct: 3,           // stop distance bounds
  stopMaxPct: 7,
  targetR: 3,              // profit target in R multiples
  firstScanMin: 25,        // first scan at 09:55 ET
  scanEveryMin: 30,
  noEntriesLastMin: 60,    // no new entries in the final hour
  flattenLastMin: 9,       // flat by 15:51 ET
  slippagePct: 0.05,
  sharesFloor: 1,
};

const STATE = 'state.json';

// Step 3: keep only the stocks gapping up and holding the gap.
export function filterGappers(quotes) {
  return Object.entries(quotes)
    .filter(([, q]) => q.changePct >= CONFIG.minGapPct && q.price >= CONFIG.minPrice &&
      q.open >= q.prevClose * (1 + CONFIG.minOpenGapPct / 100) && q.price >= q.open * 0.995)
    .map(([sym, q]) => ({ sym, chg: Math.round(q.changePct * 100) / 100, price: Math.round(q.price * 100) / 100 }))
    .sort((a, b) => b.chg - a.chg);
}

export function freshState() {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: 1,
    createdAt: now,
    startCash: CONFIG.startCash,
    cash: CONFIG.startCash,
    positions: [],
    trades: [],
    scans: [],
    events: [{ t: now, type: 'system', text: `Desk online · $${CONFIG.startCash.toLocaleString()} account · S&P 500 universe` }],
    equity: [{ t: now, v: CONFIG.startCash }],
    lastScanSlot: null,
    lastTick: null,
    lastTickInfo: null,
  };
}

export async function loadState() {
  return (await readJSON(STATE)) || freshState();
}
export async function saveState(s) {
  return writeJSON(STATE, s);
}

const r2 = n => Math.round(n * 100) / 100;
const usd = n => `$${r2(n).toFixed(2)}`;

function log(state, type, text, alerts) {
  const t = Math.floor(Date.now() / 1000);
  state.events.unshift({ t, type, text });
  state.events = state.events.slice(0, 400);
  if (alerts) alerts.push(text);
}

function equityOf(state, quotes) {
  let v = state.cash;
  for (const p of state.positions) v += p.shares * (quotes[p.sym]?.price ?? p.last ?? p.entry);
  return r2(v);
}

function closePosition(state, p, rawPrice, reason, alerts) {
  const px = r2(rawPrice * (1 - CONFIG.slippagePct / 100));
  const pnl = r2((px - p.entry) * p.shares);
  state.cash = r2(state.cash + px * p.shares);
  state.positions = state.positions.filter(x => x.id !== p.id);
  const now = Math.floor(Date.now() / 1000);
  state.trades.unshift({
    id: p.id, sym: p.sym, shares: p.shares, entry: p.entry, exit: px, pnl,
    pnlPct: r2((px / p.entry - 1) * 100), r: r2((px - p.entry) / p.R), reason,
    openedAt: p.openedAt, closedAt: now, date: etDate(now),
  });
  state.trades = state.trades.slice(0, 1000);
  const icon = pnl >= 0 ? '🟢' : '🔴';
  log(state, 'exit', `${icon} ${p.sym} ${reason} · ${p.shares} sh @ ${usd(px)} | P&L ${pnl >= 0 ? '+' : ''}${usd(pnl).replace('$-', '-$')} (${r2((px - p.entry) / p.R)}R)`, alerts);
}

export async function tick({ force = false } = {}) {
  const t0 = Date.now();
  const state = await loadState();
  const alerts = [];
  const clock = await getClock();
  const info = { at: clock.now, open: clock.isOpen, actions: [] };
  let changed = false;

  // Safety: market closed but still holding -> flatten at the official close.
  if (!clock.isOpen) {
    if (state.positions.length) {
      const q = await getQuotes(state.positions.map(p => p.sym));
      for (const p of [...state.positions]) closePosition(state, p, q[p.sym]?.price ?? p.last ?? p.entry, 'closed at bell', alerts);
      info.actions.push('flattened after close');
      changed = true;
    }
    if (changed) {
      state.equity.push({ t: clock.now, v: equityOf(state, {}) });
      log(state, 'system', `🏁 Session closed · flat · equity ${usd(state.cash)}`, alerts);
    }
    state.lastTick = clock.now;
    state.lastTickInfo = info;
    if (changed || force) await saveState(state);
    for (const a of alerts) await notify(a);
    return { state, info, clock };
  }

  // ---- 2. Pull live quotes for open positions & manage them ----
  if (state.positions.length) {
    const q = await getQuotes(state.positions.map(p => p.sym));
    for (const p of [...state.positions]) {
      const quote = q[p.sym];
      if (!quote) continue;
      const px = quote.price;
      p.last = px;
      p.high = Math.max(p.high ?? p.entry, quote.high ?? px);
      if (px <= p.stop) { closePosition(state, p, Math.min(px, p.stop), p.stage === 'open' ? 'stopped out' : 'stop hit', alerts); changed = true; continue; }
      if (px >= p.target) { closePosition(state, p, px, 'target hit', alerts); changed = true; continue; }
      // Move stop to breakeven at +1R, then trail 1R behind price after +2R.
      if (p.stage === 'open' && px >= p.be) {
        p.stop = p.entry; p.stage = 'breakeven'; changed = true;
        log(state, 'stop', `🔵 ${p.sym} stop → breakeven ${usd(p.entry)}`, alerts);
      }
      if (px >= p.entry + 2 * p.R) {
        const trail = r2(px - p.R);
        if (trail > p.stop) {
          p.stop = trail; p.stage = 'trailing'; changed = true;
          log(state, 'stop', `🟣 ${p.sym} trailing stop raised → ${usd(trail)}`, alerts);
        }
      }
    }
    changed = true; // marks + equity point
  }

  // ---- Closing bell: flat by 15:51 ET ----
  if (clock.minutesToClose <= CONFIG.flattenLastMin + 1 && state.positions.length) {
    const q = await getQuotes(state.positions.map(p => p.sym));
    for (const p of [...state.positions]) closePosition(state, p, q[p.sym]?.price ?? p.last, 'closed before bell', alerts);
    const today = state.trades.filter(t => t.date === clock.sessionDate);
    const dayPnl = r2(today.reduce((a, t) => a + t.pnl, 0));
    log(state, 'system', `🏁 Closed out before the bell · ${today.length} trades today · day P&L ${dayPnl >= 0 ? '+' : ''}${usd(dayPnl).replace('$-', '-$')}`, alerts);
    info.actions.push('flattened');
    changed = true;
  }

  // ---- 1/3/4. Scan → filter gappers → execute ----
  const slot = Math.floor((clock.minutesSinceOpen - CONFIG.firstScanMin) / CONFIG.scanEveryMin);
  const slotKey = `${clock.sessionDate}#${slot}`;
  const scanDue = slot >= 0 && clock.minutesToClose > CONFIG.flattenLastMin + 1 && (state.lastScanSlot !== slotKey || force);
  if (scanDue) {
    const s0 = Date.now();
    const quotes = await getQuotes(SP500);
    const universe = Object.keys(quotes).length;
    const survivors = filterGappers(quotes);
    const secs = ((Date.now() - s0) / 1000).toFixed(1);
    const label = `${etTime(clock.now)} ET`;
    state.scans.unshift({ t: clock.now, label, total: universe, secs: Number(secs), survivors: survivors.slice(0, 15), count: survivors.length });
    state.scans = state.scans.slice(0, 40);
    state.lastScanSlot = slotKey;
    const lines = survivors.slice(0, 12).map(s => `• ${s.sym} +${s.chg.toFixed(2)}%`).join('\n');
    log(state, 'scan', `📊 Prefilter ${label}\n${survivors.length}/${universe} survivors • ${secs}s${lines ? '\n' + lines : ''}`, alerts);
    info.actions.push(`scan ${survivors.length}/${universe}`);
    changed = true;

    // Execute entries
    if (clock.minutesToClose > CONFIG.noEntriesLastMin) {
      const tradedToday = new Set(state.trades.filter(t => t.date === clock.sessionDate).map(t => t.sym));
      const held = new Set(state.positions.map(p => p.sym));
      for (const s of survivors) {
        if (state.positions.length >= CONFIG.maxPositions) break;
        if (held.has(s.sym) || tradedToday.has(s.sym)) continue;
        const q = quotes[s.sym];
        const equity = equityOf(state, quotes);
        const entry = r2(q.price * (1 + CONFIG.slippagePct / 100));
        let stop = Math.min(q.low * 0.998, entry * (1 - CONFIG.stopMinPct / 100));
        stop = r2(Math.max(stop, entry * (1 - CONFIG.stopMaxPct / 100)));
        const R = r2(entry - stop);
        if (R <= 0) continue;
        const riskUsd = equity * CONFIG.riskPct / 100;
        let shares = Math.floor(riskUsd / R);
        shares = Math.min(shares, Math.floor(equity * CONFIG.maxPositionPct / 100 / entry), Math.floor(state.cash / entry));
        if (shares < CONFIG.sharesFloor) continue;
        const pos = {
          id: `${s.sym}-${clock.now}`, sym: s.sym, shares, entry, stop, initStop: stop, R,
          be: r2(entry + R), target: r2(entry + CONFIG.targetR * R), stage: 'open',
          openedAt: clock.now, last: q.price, high: q.price, gap: s.chg,
        };
        state.cash = r2(state.cash - entry * shares);
        state.positions.push(pos);
        held.add(s.sym);
        log(state, 'entry', `🟢 ${s.sym} entry filled\n${shares} shares @ ${usd(entry)} | Stop ${usd(stop)} | Risk $${Math.round(R * shares)} | BE at ${usd(pos.be)} | Target ${usd(pos.target)}`, alerts);
        info.actions.push(`buy ${s.sym}`);
      }
    }
  }

  // Mark equity
  if (changed) {
    const marks = {};
    for (const p of state.positions) marks[p.sym] = { price: p.last ?? p.entry };
    state.equity.push({ t: clock.now, v: equityOf(state, marks) });
    if (state.equity.length > 4000) state.equity = state.equity.filter((_, i) => i % 2 === 0 || i > state.equity.length - 500);
  }
  state.lastTick = clock.now;
  info.ms = Date.now() - t0;
  state.lastTickInfo = info;
  if (changed || force) await saveState(state);
  for (const a of alerts) await notify(a);
  return { state, info, clock };
}
