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
    const all = Object.values(quotes).filter(q => Number.isFinite(q.changePct));
    // Day-change distribution for the overview chart: how many stocks fell / rose by how much.
    const edges = [-3, -2, -1, 0, 1, 2, 3];
    const dist = new Array(edges.length + 1).fill(0);
    for (const q of all) { let i = 0; while (i < edges.length && q.changePct >= edges[i]) i++; dist[i]++; }
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      asOf, date: etDate(asOf), label: `${etTime(asOf)} ET`, total: Object.keys(quotes).length,
      count: survivors.length, survivors: survivors.slice(0, 15),
      movers: Object.entries(quotes).sort((a, b) => b[1].changePct - a[1].changePct).slice(0, 10)
        .map(([sym, q]) => ({ sym, chg: Math.round(q.changePct * 100) / 100 })),
      breadth: { adv: all.filter(q => q.changePct > 0).length, dec: all.filter(q => q.changePct < 0).length },
      dist: { edges, counts: dist },
      secs: Math.round((Date.now() - t0) / 100) / 10,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
