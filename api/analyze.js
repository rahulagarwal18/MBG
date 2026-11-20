// Stock report for one US symbol: last 30 days, 5-day projection, measured accuracy, AI write-up.
import { getQuotes } from '../lib/market.js';
import { analyzeStock } from '../lib/analyze.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const sym = String(req.query.symbol || '').trim().toUpperCase().replace(/\./g, '-');
  if (!/^[A-Z\-]{1,10}$/.test(sym)) return res.status(400).json({ error: 'Enter a valid US symbol, e.g. AAPL.' });
  try {
    const live = (await getQuotes([sym]).catch(() => ({})))[sym];
    const out = await analyzeStock({ symbol: sym, ysym: sym, currency: 'USD', tz: 'America/New_York', live });
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: `Could not build a report for ${sym}: ${String(e?.message || e)}` });
  }
}
