# Scenteno YouTube Auto-Commenter

Automatically comments + pins promotional links on the **Scenteno** YouTube channel's
Shorts and Community posts. Runs locally — connects to your own Chrome, so YouTube
sees a normal residential IP (no bot-detection blocks).

## What it does

- **Shorts** (`scenteno_shorts.py`) — processes the 10 newest Shorts, posts + pins a comment.
- **Posts** (`scenteno_posts.py`) — processes the 10 newest Community posts, posts + pins a comment.
- **Skips** anything that already has a pinned comment (never unpins/replaces).
- **Skips** promo posts (Sale / % off / OFF keywords).
- **Never duplicates** its own comment.

## Comment text

Default (most videos/posts):

> https://scenteno.com/yt12  Join the Brotherhood of Scent to get fragrance advice from a supportive community — and share advice, opinions, and experience with fragrance brothers.

House of Dastan (only when the title mentions "House of Dastan"):

> https://www.realmenrealstyle.com/best-frags  Ready to upgrade your fragrance game? Check out House of Dastan here.

## Option A — Browser extension (recommended; Chrome + Firefox)

No Python, no debug-port Chrome. Runs inside your normal browser using your normal
YouTube login. Folder: `extension/`.

**Install (Chrome / Edge):** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick the `extension/` folder.

**Install (Firefox):** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick `extension/manifest.json`.
Then `about:addons` → Scenteno Commenter → *Permissions* → enable access to youtube.com
(Firefox treats MV3 host permissions as opt-in). Temporary add-ons unload when Firefox closes;
for a permanent install, zip the folder and sign it at addons.mozilla.org (self-distribution, free).

**Use:** be signed in to YouTube as @Scenteno in that browser. Click the toolbar icon →
*Run Shorts* / *Run Posts* (tick *dry run* first time). *Dashboard* opens the full tracker:
totals, 30-day activity, every run, every item's status, failures with screenshots, JSON export.

**Schedule:** automatic — Shorts every 24h, Posts every 12h, first run 5 min after install,
as long as the browser is open. The extension never double-posts and never unpins anyone else's comment.

## Remote dashboard on Railway (optional)

The extension keeps its own dashboard, but it only lives in that browser. `server/` is a
small Node + Postgres service that receives each run from the extension and serves the same
dashboard at a URL you can open from your phone or any PC (password-protected). Railway
only *displays* results — the commenting still happens in your browser.

**Deploy (one time, ~10 min):**

1. Push this repo to GitHub.
2. Railway → *New Project* → *Deploy from GitHub repo* → select the repo. The root
   `railway.json` / `nixpacks.toml` tell it to run `server/`.
3. In the project, *+ New* → *Database* → *PostgreSQL*. Railway injects `DATABASE_URL` into the service
   automatically (if not: service → Variables → add a reference to `${{Postgres.DATABASE_URL}}`).
4. Service → *Variables* → add:
   - `INGEST_TOKEN` — any long random string (the extension uses it to post results)
   - `DASHBOARD_PASSWORD` — what you'll type to open the dashboard
5. Service → *Settings* → *Networking* → *Generate Domain*. Open it, enter the password
   (username blank) — you'll see an empty dashboard.
6. In the extension popup → *Remote dashboard (Railway)* → paste the domain URL and the
   `INGEST_TOKEN` → *Save*. From the next run on, results appear on Railway. Do this in every
   browser you run the extension in; each shows up as a separate source.

If Railway is unreachable the extension queues reports locally and retries on the next run
(the popup shows a ⚠ with the last error). Failure screenshots are stored in Postgres, last 50 kept.

**Run the server locally:** `cd server && npm install`, then set `DATABASE_URL`, `INGEST_TOKEN`,
`DASHBOARD_PASSWORD` and `npm start` (listens on `PORT`, default 3000).

## Option B — Python script (legacy)

## Prerequisites

1. **Python 3.8+**
2. **Google Chrome**
3. A YouTube account with access to post/pin on the @Scenteno channel

## Setup (one time)

### 1. Install Playwright

```bash
pip install playwright
```

(No browser download needed — we connect to your existing Chrome, not a Playwright browser.)

### 2. Launch Chrome with the debug port

Double-click `start-chrome.bat`, or run:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\chrome-debug-profile"
```

> ⚠️ The `--user-data-dir` is REQUIRED. Chrome 136+ ignores the debug port on your
> default profile. This opens a separate Chrome window with its own profile.

### 3. Sign in

In the Chrome window that just opened, go to youtube.com and **Sign in** as the
account that manages @Scenteno. Sign in once — it persists in the debug profile
for ~2 weeks (Google sessions expire; re-sign-in when comments stop working).

### 4. Test

```bash
python scenteno_shorts.py
python scenteno_posts.py
```

You should see a `📊 SCENTENO ... REPORT` with each short/post listed.

## Scheduling

The scripts are plain Python — schedule with any scheduler:

**Windows Task Scheduler** (recommended):
- Shorts: daily at a set time → run `scenteno_shorts.py`
- Posts: twice daily → run `scenteno_posts.py`

Or `cron` / `launchd` on Mac/Linux.

**Chrome must be running (with the debug port) when the scheduled task fires.**

## Flags & files

- `--dry-run` — visits everything, reports what it *would* do, posts nothing.
- `--force` — re-check items already recorded as done in `state.json`.
- `state.json` — per-item result log; done items are skipped on later runs (delete to reset).
- `failures/` — screenshot + HTML + error note for every failed item. Look here first when something breaks.
- `ALERT_WEBHOOK` env var (optional) — Slack/Discord incoming-webhook URL; gets a message on any failure, including "session expired".
- Exit code: 0 ok · 1 item errors · 2 Chrome not running · 3 not signed in · 4 listing empty.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `❌ Failed to connect to Chrome` | Chrome not running with debug port | Run `start-chrome.bat` |
| `❌ Not signed in` | Google session expired | Sign in as @Scenteno in the debug Chrome |
| `ERR comment box didn't load` | Comments off, rate-limit, or YouTube layout change | Check `failures/<id>.png`; re-run later |
| `ERR TimeoutError: ...` | A selector no longer matches (YouTube changed its DOM) | Open `failures/<id>.html`, fix the selector in `ytcommenter.py` |

## Files

- `server/` — Railway dashboard server (Express + Postgres); `railway.json` / `nixpacks.toml` — Railway deploy config
- `extension/` — browser extension (manifest, background.js scheduler, yt.js page logic, popup, dashboard)
- `ytcommenter.py` — shared engine (all the browser logic lives here)
- `scenteno_shorts.py` — Shorts runner
- `scenteno_posts.py` — Posts runner
- `start-chrome.bat` — launch Chrome with debug port
- `run-shorts.bat` / `run-posts.bat` — convenience runners
- `requirements.txt` — Python deps
