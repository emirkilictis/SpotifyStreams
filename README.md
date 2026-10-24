# Spotify Streams

A multi-artist Spotify streaming analytics dashboard with historical trends, charts, milestones, and automated data collection.

The scraper collects Spotify play counts and artist statistics, stores observations in PostgreSQL, and serves them through a public Express dashboard. The artist roster is managed in the admin panel rather than fixed to a single artist.

## Features

- Song and album totals, daily gains, historical charts, and milestone tracking.
- Artist comparisons, category charts, and shareable image cards.
- Configurable artist tracking, including album-only and passcode-protected profiles.
- Duplicate recording reconciliation, stale play-count repair, and historical data maintenance.
- Optional browser push notifications and X posts.
- Administrator and secondary administrator roles with separate permissions.

## Project structure

| Location | Purpose |
| --- | --- |
| `services/web-dashboard/` | Express API, dashboard, admin panel, and tests |
| `services/web-dashboard/lib/` | Server helpers and database/deduplication logic shared with the scraper |
| `services/spotify-scraper/` | Spotify collection, discovery, diagnostics, and maintenance scripts |
| `services/spotify-scraper/migrations/` | PostgreSQL schema and view migrations |
| `.github/workflows/` | Scraping, diagnostics, deployment, and security checks |
| `render.yaml` | Render Blueprint configuration |

## Requirements

- **Node.js 24 or later.** The scraper uses Puppeteer 25. The root `.nvmrc` selects Node 24.
- **PostgreSQL.** Hosted connections require TLS with certificate and hostname verification. The current deployment uses a Supabase session pooler on port 5432.
- **A valid Spotify `sp_dc` cookie** for browser-based collection. Treat it as an account credential.
- **Chrome or Chromium** for the scraper. Puppeteer installs a compatible browser during a normal dependency installation; `CHROME_PATH` can select an existing executable.

The main scraper discovers releases through the web player. Spotify developer app credentials are only needed for tools that explicitly use the official API discovery functions.

## Local setup

### 1. Install dependencies

From the repository root:

```bash
npm ci --prefix services/spotify-scraper
npm ci --prefix services/web-dashboard
cp .env.example .env
```

If you use nvm, run `nvm use` first. Keep the `.env` file in the repository root; it is excluded from Git.

### 2. Configure the environment

Edit `.env` using the guidance in [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL |
| `SP_DC` | Spotify web player session cookie used by the scraper |
| `SP_KEY` | Additional Spotify cookie, when needed by a collection tool |
| `ADMIN_PASSCODE` | Main administrator credential; at least 32 characters |
| `SECADMIN_PASSCODE` | Secondary administrator credential; at least 32 characters |
| `IP_HASH_SECRET` | Independent key used to hash feedback submitter IPs; at least 32 characters |
| `JC_PASSCODES` | Optional comma-separated codes for locked artist profiles; each at least 32 characters |
| `DB_SSL_CA` or `DB_SSL_CA_FILE` | Optional provider CA override as PEM text or a file path |
| `DB_SSL_MODE` | `verify-full` by default; `disable` is restricted to local loopback development |
| `TRUST_PROXY_HOPS` | Number of trusted reverse proxies; defaults to 1 on Render and 0 locally |
| `PORT` | Dashboard port; defaults to 3000 |

Generate each administrator credential and the IP hashing key independently:

```bash
openssl rand -hex 32
```

Run the command separately for each secret. The dashboard refuses to start with missing, short, or reused required credentials. If locked-profile codes are omitted, locked profiles remain inaccessible.

To obtain `SP_DC`, sign in to the Spotify web player and inspect **Developer Tools → Application → Cookies → open.spotify.com**. Never commit cookies, database passwords, private keys, or access tokens.

### 3. Configure database certificate verification

Supabase shared pooler hosts (`*.pooler.supabase.com`) automatically use the bundled official public CA. No certificate download or secret is needed for the standard pooler connection. See the [certificate provenance and fingerprint](services/web-dashboard/certs/README.md).

For a custom CA or another provider, configure the appropriate certificate. To download the Supabase CA manually, open [Database Settings](https://supabase.com/dashboard/project/_/database/settings), select the project, and locate **SSL Configuration → Download certificate**. Configure either:

```dotenv
DB_SSL_CA_FILE=/absolute/path/to/provider-ca.crt
```

or `DB_SSL_CA` containing the PEM certificate. Escaped `\n` line breaks are supported. Do not configure both variables together.

All database clients use certificate and hostname verification. Legacy SSL parameters in `DATABASE_URL` cannot weaken that policy. Set `DB_SSL_MODE=disable` only for a PostgreSQL instance running on local loopback during development.

See the [Supabase SSL guide](https://supabase.com/docs/guides/platform/ssl-enforcement) and [node-postgres SSL documentation](https://node-postgres.com/features/ssl).

### 4. Apply database migrations

```bash
cd services/spotify-scraper
npm run migrate
```

The migration command applies the SQL files in the migrations directory to the configured database.

### 5. Collect Spotify data

From `services/spotify-scraper`:

```bash
# Collect updates when fresh data is available.
npm run scrape

# Bypass the freshness check and force a scrape.
node scraper.js --force

# Limit collection to selected artist IDs.
node scraper.js --artists=ARTIST_ID_1,ARTIST_ID_2
```

The scraper observes a time budget and can defer remaining artists to a later run. Maintenance scripts may modify stored data; inspect their options before running them against a production database.

### 6. Start the dashboard

```bash
cd services/web-dashboard

# Start with automatic restarts during development.
npm run dev

# Start normally.
npm start
```

Open [localhost:3000](http://localhost:3000). The main dashboard is public. The admin page is available at `/admin`, and its API requires an administrator credential. Locked artist profiles have a separate access-code check.

Administrator API requests use the `X-Admin-Passcode` header. Credentials are not accepted in query strings. The main administrator has access to privileged maintenance operations; the secondary administrator has additional restrictions, including changes to Justin Timberlake's data.

### Add missing songs from a playlist

In **Admin → Artists → Add songs from a playlist**, choose the artist and paste a public Spotify playlist (up to 50 songs). **Preview songs** queues a browser read through the `playlist-import.yml` GitHub Actions workflow. Reopen an in-progress preview from recent imports after leaving the page.

The preview distinguishes new songs, existing recordings to link, already included songs, hidden songs, and unrelated songs. Artist credits are selected automatically; an explicit feature credit found only in the song title requires manual selection. **Add selected songs** imports only those selections, with Spotify's observed counts and album pins for future collection. Region-restricted songs without a count stay unknown; no zero or historical daily gain is invented. Existing canonical recordings and history are preserved, and retries do not add them twice.

Apply migration `033_playlist_imports.sql` and configure the same `GH_DISPATCH_TOKEN` used for artist sync. The workflow uses the repository's existing `DATABASE_URL`, `SP_DC`, and optional `DB_SSL_CA` secrets. The web service does not need Chrome or Spotify cookies. Preview results expire after 24 hours; failed or timed-out reads can be retried with a new preview.

## Optional integrations

### Browser push notifications

Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` to enable notifications. Generate a key pair with `npx web-push generate-vapid-keys`. Keep the private key secret and retain the same key pair for existing subscriptions.

Set a strong, independent `PUSH_DISPATCH_SECRET` on Render and as a GitHub Actions repository secret. The workflow sends this credential to `/api/push/dispatch`. Subscriptions are restricted to supported browser push services.

### X posts

The scraping workflow includes optional monthly-listener and daily-recap posting steps. They use `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_SECRET` repository secrets. Configure the optional `TWEET_FOOTER` and `DASHBOARD_URL` repository variables as needed. Enabling these credentials allows the workflow to publish posts.

## GitHub Actions

| Workflow | Behavior |
| --- | --- |
| **Spotify Stream Scrape** | Runs through `workflow_dispatch`, including calls from an external scheduler or the admin panel. Supports forced runs and selected artist IDs. |
| **Diagnose** | Runs diagnostics manually or on configured development branches. Most steps are read-only; the one-off repair step requires the `[repair-stale]` commit marker. |
| **Security checks** | Runs offline tests and audits both services' dependencies on pushes and pull requests. Production credentials are not required. |
| **Deploy to Render** | Calls the optional `RENDER_DEPLOY_HOOK` on pushes to `main` or manual dispatch. Skips deployment when the secret is absent. |

The scraper requires `DATABASE_URL` and `SP_DC` repository secrets. Add `DB_SSL_CA` when the database provider requires a custom CA. The admin panel's workflow controls require a suitable server-side `GH_DISPATCH_TOKEN`.

## Render deployment

The Blueprint uses:

- **Root directory:** `services/web-dashboard`
- **Build command:** `npm ci`
- **Start command:** `node server.js`
- **Node version:** 24

The Blueprint generates independent administrator credentials and an IP hashing key for a new service. Existing or manually configured services need their environment variables updated in the Render dashboard. Supabase shared poolers use the bundled CA. Configure an explicit CA before deployment if a different database endpoint requires one.

`TRUST_PROXY_HOPS=1` assumes a single trusted Render proxy. Adjust it to match a different deployment topology. Use `/healthz` to check service health and the deployed commit.

## Tests

Run these commands from `services/web-dashboard`:

```bash
# Offline unit and security regression tests.
npm test

# Security regression tests only.
npm run test:security

# API integration tests against an already running dashboard and database.
npm run test:api
```

The legacy `node test_security.js` entry point also runs isolated security tests. It does not write to a live database or trigger scraping.

Audit dependencies in each service directory:

```bash
npm audit
```

## Security status

See [SECURITY.md](SECURITY.md) for the dated review, implemented protections, validation results, and required production rollout steps. Code-level fixes do not establish that an existing deployment has received the new credentials or application version.
