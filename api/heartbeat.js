// Self-healing: an open dashboard nudges the desk if no cycle has run for 9+ minutes,
// or as soon as a scheduled scan (09:50 ET, then every 30 min) is due and hasn't run yet.
import { tick, loadState, CONFIG } from '../lib/engine.js';

export const config = { maxDuration: 60 };

// Cheap local check (no network) for "a scan slot has started that this desk hasn't run".
function scanDueNow(s) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const sinceOpen = Number(p.hour) * 60 + Number(p.minute) - 570;           // 09:30 ET
  if (sinceOpen < CONFIG.firstScanMin || sinceOpen > 390 - CONFIG.flattenLastMin - 1) return false;
  const slot = Math.floor((sinceOpen - CONFIG.firstScanMin) / CONFIG.scanEveryMin);
  return s.lastScanSlot !== `${p.year}-${p.month}-${p.day}#${slot}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
  try {
    const s = await loadState();
    const age = Math.floor(Date.now() / 1000) - (s.lastTick || 0);
    const due = age >= 60 && scanDueNow(s);
    if (age < 540 && !due) return res.status(200).json({ ok: true, ran: false, age });
    const { info } = await tick();
    return res.status(200).json({ ok: true, ran: true, actions: info.actions });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
}
