# CLAUDE.md: guide for AI assistants working on this repo

MBG is the US desk of MultiBank Automated Trading. It is a gap-up momentum paper-trading desk for the S&P 500. It runs on a simulated $10,000 account, and a human must approve every new trade.
The sister repo is **MBG_Nse** (India / NIFTY 500 + MCP server). Both repos share most of their code, so a bug fixed in one usually needs the same fix in the other.

Live site: https://multibank-automated-trading.vercel.app (Vercel project `gapline-desk`, region iad1)

## Architecture
- No framework or build step. The code is plain Node ESM (`"type": "module"`), and every file in `api/` is a Vercel serverless function `export default async function handler(req, res)`.
- `public/index.html` is the whole dashboard (vanilla JS + inline CSS). It polls `/api/state` and `/api/quotes` every 5 s.
- State is stored as JSON in **private Vercel Blob** (`lib/store.js`). It is always read with `useCache:false`. Do NOT switch it to a public store: its CDN cache served stale state for about 60 s, and updates were lost.
- Prices come from Yahoo Finance spark/chart endpoints (`lib/market.js`). A spark batch takes at most 20 symbols per request.
- AI write-ups (`lib/ai.js`) use Claude if `ANTHROPIC_API_KEY` is set, otherwise Groq (`GROQ_API_KEY`). If both fail, a rules-based fallback is used.

## Key files
| File | What it does |
|---|---|
| `lib/engine.js` | `CONFIG`, scan → `tick()` creates proposals in `state.pending`; `decide()` approves/rejects (re-checks live price, rejects if drift > `approvalDriftPct`); exits (stop, breakeven at +1R, trail after +2R, 3R target, flatten before close) |
| `lib/analyze.js` | Stock report: 1y history → 30-day metrics, lognormal 5-day projection (drift shrunk 50%), walk-forward accuracy check, Wilder RSI; cached 5 min in memory |
| `lib/backtest.js` | Strategy replay shown in the "Strategy report" tab |
| `api/tick.js` | Runs one desk cycle. Auth: header `x-desk-key: $TICK_SECRET` or `Authorization: Bearer $CRON_SECRET` |
| `api/approve.js` | Approve/reject a proposal; requires `APPROVER_PIN` (timing-safe compare) + approver name |
| `api/heartbeat.js` | Self-heal: runs a tick if the last one is > 9 min old. Open dashboards call it every 60 s |
| `api/analyze.js`, `api/search.js` | Stock report tab |
| `.github/workflows/desk.yml` | Scheduler: calls `/api/tick` every 15 min in market hours (secrets `DESK_KEY`, `DESK_URL`) |

## Running and testing
- `npm install`, then `npx vercel dev` (needs the env vars below in `.env.local`, which is never committed).
- There is no test suite. To verify a change, deploy (pushing to `main` auto-deploys) and check `/api/state`, `/api/quotes`, `/api/analyze?symbol=AAPL` and the dashboard in a browser.
- Force a cycle: `curl -X POST -H "x-desk-key: $TICK_SECRET" "$URL/api/tick?force=1"`.

## Environment variables (set in Vercel, never in code)
`BLOB_READ_WRITE_TOKEN`, `TICK_SECRET`, `CRON_SECRET`, `APPROVER_PIN`, `GROQ_API_KEY`, `GROQ_MODEL`, optional `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Rules: keep these when fixing things
1. **Human approval must stay.** Entries are only proposed; never auto-execute them. Exits stay automatic.
2. **Never commit secrets, keys or the PIN.** Run `git grep -nE "gsk_|sk-ant|vercel_blob_rw"` before pushing.
3. **Keep results honest.** The replay loses money and projection direction accuracy is close to a coin flip. Show those numbers; don't tune or hide them.
4. **Branding.** Use "MultiBank Automated Trading" with the blue theme. Show no personal names, and don't advertise the tech stack or AI vendor on the site. Keep the footer note "prototype, simulated money, not an official MultiBank Group service, not investment advice".
5. Vercel Hobby plan: cron jobs can run at most **once per day**, which is why scheduling uses GitHub Actions + heartbeat.

## Known issues / good first fixes
- **GitHub Actions cron is unreliable.** Scheduled runs are often delayed or skipped, so the desk only ticks reliably while a dashboard is open. Fix: an external pinger (cron-job.org → `/api/tick` with `x-desk-key`) or Vercel Pro crons.
- Yahoo endpoints are unofficial and can rate-limit or change shape. `lib/market.js` should degrade gracefully.
- The in-memory analyze cache is per-instance, so a cold start re-fetches the data.
- `state` is one JSON blob with last-write-wins. Two simultaneous writes (tick + approve) can still race. A version check / retry would harden it.
