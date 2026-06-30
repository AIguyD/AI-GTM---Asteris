# GTM Dashboard — StableTrack Content Pipeline

A **password-protected web dashboard** over the live Supabase `reporting` views, with a built-in
**AI chat** assistant. Hosted on a Cloudflare Worker, branded to StableTrack.

**Live:** https://content-dashboard.tools-db4.workers.dev — login with username `stabletrack` (password stored as a Worker secret).

---

## What's here
| File | Purpose |
|------|---------|
| `public/index.html` | **THE dashboard** (HTML + CSS + JS). Edit this for any UI change. |
| `public/logo.png`, `public/icon.png` | StableTrack brand images (wordmark + horse icon). |
| `src/index.js` | The Worker: login (cookie session), `/api/chat` (Claude over the reporting views), serves the dashboard. |
| `wrangler.toml` | Cloudflare config — worker name `content-dashboard`, static assets, `run_worker_first`, public Supabase vars. |
| `scripts/wipe_test_dashboard.js` | Backup / wipe / restore the 8 source tables (used to prove the dashboard is live). |

## Make a UI change
1. Edit `public/index.html`.
2. Deploy (below). That's it — the whole UI is that one file.

## Deploy
Requires Cloudflare access (account `tools@asteris.com`) + Node installed.
```bash
cd "GTM Dashboard"
npm_config_cache=/tmp/npmcache npx -y wrangler@latest deploy
```

## Secrets (set once on the Worker — never committed)
- `CLAUDE_API_KEY` — Anthropic key for the AI chat.
- `DASH_USER` / `DASH_PASS` — the dashboard login.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — in `wrangler.toml [vars]` (anon key is read-only over the `reporting` views, safe to expose).

Set or rotate a secret — **write the value to a temp file first** (piping `$(node -e 'dotenv…')` corrupts it because dotenvx prints a banner to stdout):
```bash
printf '%s' "THE_VALUE" > /tmp/v
npm_config_cache=/tmp/npmcache npx -y wrangler@latest secret put DASH_PASS < /tmp/v
rm /tmp/v
```

## Data
The dashboard reads the Supabase **`reporting`** schema views live on every page load (and the AI chat reads
them server-side). Those views read the `stabletrack_content_pipeline` tables, which the n8n pipelines
(Market Intel / Performance Monitor / Strategy Brain) populate. So it's always current with the database;
the database changes when a pipeline runs.

## Access model
- Open the URL → branded login → session cookie (30 days) → dashboard. `⎋ logout` in the header.
- The AI chat endpoint is also behind the login (401 without a session).
