# MBG · MultiBank Automated Trading (US Equities)

Human-approved automated trading desk for the S&P 500, running on a **$10,000 simulated demo account** with live market prices.

**Live:** https://multibank-automated-trading.vercel.app

## What it does
- Scans all 503 S&P 500 stocks every 30 minutes during US market hours and **recommends** gap-up trades with entry, stop, target and maximum loss already calculated.
- **Nothing is bought until a person approves it** (name + approver PIN). The live price is re-checked at approval.
- Exits are automatic risk controls: stop-loss, move-stop-to-breakeven, trailing stop, 3R target, flat before the closing bell.
- Dashboard: demo account P&L (refreshes every 5 s), approvals with plain-language reasons, positions, scans, trade history, equity curve.
- **Stock report** tab: search any US stock → last 30 days, 5-day statistical projection with likely ranges, measured past accuracy, and an AI plain-language summary.
- **Strategy report**: the rules replayed on 60 sessions of real 5-minute data.

## Project layout
| Path | Purpose |
|---|---|
| `public/index.html` | Dashboard (single page) |
| `api/tick.js` | One cycle of the desk (scan, manage positions, propose trades) |
| `api/approve.js` | Approve / reject a proposed trade |
| `api/state.js`, `api/quotes.js`, `api/scan.js` | Dashboard data |
| `api/analyze.js`, `api/search.js`, `api/symbols.js` | Stock report and search |
| `api/report.js` | Strategy replay report |
| `api/heartbeat.js` | Self-healing nudge from an open dashboard |
| `lib/engine.js` | Trading rules, proposals, approvals, exits |
| `lib/analyze.js` | 30-day metrics, 5-day projection, accuracy check |
| `lib/ai.js`, `lib/ai-groq.js`, `lib/ai-claude.js` | AI analyst (uses whichever key is configured) |
| `.github/workflows/desk.yml` | Scheduler (every 15 min in market hours) |

## Settings (server environment variables)
| Name | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Private storage for desk state |
| `TICK_SECRET`, `CRON_SECRET` | Protect the cycle endpoint |
| `APPROVER_PIN` | PIN required to approve or reject trades |
| `GROQ_API_KEY`, `GROQ_MODEL` | AI analyst |
| `ANTHROPIC_API_KEY` (optional) | Switches the AI analyst to Claude |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional) | Phone alerts |

Repository secrets for the scheduler: `DESK_KEY`, `DESK_URL`.

> Prototype for demonstration. Simulated money, not an official MultiBank Group service, not investment advice.
