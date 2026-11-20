import { SP500 } from '../lib/sp500.js';
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=86400');
  return res.status(200).json(SP500.map(s => ({ s })));
}
