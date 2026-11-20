// Search US-listed stocks by name or symbol.
import { SP500 } from '../lib/sp500.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const US = new Set(['NMS', 'NYQ', 'NGM', 'NCM', 'ASE', 'PCX', 'BTS', 'NAS', 'NYS']);

export default async function handler(req, res) {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (q.length < 1) return res.status(200).json([]);
  const k = q.toUpperCase();
  const out = new Map();
  for (const s of SP500) if (s.startsWith(k)) out.set(s, { s, n: null, i: null });
  try {
    const j = await (await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`, { headers: UA })).json();
    for (const x of j.quotes || []) {
      if (x.quoteType !== 'EQUITY' || !US.has(x.exchange) || /[.=]/.test(x.symbol)) continue;
      out.set(x.symbol, { s: x.symbol, n: x.longname || x.shortname || null, i: x.sector || null });
    }
  } catch { /* local matches only */ }
  const list = [...out.values()].sort((a, b) => (a.s.startsWith(k) ? 0 : 1) - (b.s.startsWith(k) ? 0 : 1) || (a.n ? 0 : 1) - (b.n ? 0 : 1)).slice(0, 12);
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  return res.status(200).json(list);
}
