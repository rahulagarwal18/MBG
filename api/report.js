import { runBacktest } from '../lib/backtest.js';
import { readJSON, writeJSON } from '../lib/store.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    let rep = await readJSON('report.json');
    const stale = !rep || rep.v !== 2 || (Date.now() / 1000 - rep.computedAt) > 20 * 3600;
    if (stale) {
      rep = await runBacktest({ range: '6mo' });
      await writeJSON('report.json', rep);
    }
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(rep);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
