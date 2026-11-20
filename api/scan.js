// Read-only market snapshot: runs the gap filter on the latest quotes (no trading).
import { SP500 } from '../lib/sp500.js';
import { getQuotes, etTime, etDate } from '../lib/market.js';
import { filterGappers } from '../lib/engine.js';

export default async function handler(req, res) {
  try {
    const t0 = Date.now();
    const quotes = await getQuotes(SP500);
    const survivors = filterGappers(quotes);
    const asOf = Math.max(...Object.values(quotes).map(q => q.time || 0));
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      asOf, date: etDate(asOf), label: `${etTime(asOf)} ET`, total: Object.keys(quotes).length,
      count: survivors.length, survivors: survivors.slice(0, 15),
      movers: Object.entries(quotes).sort((a, b) => b[1].changePct - a[1].changePct).slice(0, 10)
        .map(([sym, q]) => ({ sym, chg: Math.round(q.changePct * 100) / 100 })),
      secs: Math.round((Date.now() - t0) / 100) / 10,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
