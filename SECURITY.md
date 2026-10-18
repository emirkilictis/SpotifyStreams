# Security review — October 18, 2026

The security update was deployed to the existing production Render service on October 18, 2026 at 15:18 Istanbul time (UTC+3). Application revision `a1675828bd33009c3f79c465ffa65f5c8356983f` is serving at [Spotify Streams](https://spotify-streams-dashboard.onrender.com).

Production administrator credentials, the locked-profile code, and the IP hashing secret were rotated. The service uses Node 24.22.0, and the configured Supabase connection passes verified TLS using the bundled official CA.

## Implemented protections

- Removed public default administrator credentials and the default IP hashing key. The dashboard requires three different secrets of at least 32 characters and rejects invalid configuration at startup.
- Moved locked-artist access codes into the environment. Omitting them does not grant access to locked profiles.
- Removed administrator authentication through query strings. Administrator responses use `Cache-Control: no-store`, and credentials are accepted only through `X-Admin-Passcode`.
- Updated administrator and feedback throttling to use the IP resolved through the configured trusted proxy chain. Failure counters and submission tracking have bounded memory use.
- Applied a common database connection policy to the dashboard, scraper, migrations, and maintenance tools. Remote connections require TLS with certificate and hostname verification. URL flags cannot weaken verification; Supabase shared poolers use the bundled official public CA; custom certificates can be supplied through `DB_SSL_CA` or `DB_SSL_CA_FILE`.
- Enabled Content Security Policy. Inline scripts use hashes, inline event handlers were replaced with delegated listeners, and CDN scripts have pinned versions and integrity hashes.
- Restricted the image proxy to HTTPS, approved hosts, and validated public IPv4 addresses. Connections use the checked DNS result. Redirects and active SVG content are rejected, and downloads have size and time limits.
- Restricted push subscriptions to supported browser push services. Stored subscriptions are checked again before sending notifications.
- Validated database-sourced Spotify identifiers before they enter SQL fragments. User parameters and administrator column updates remain parameterized or allowlisted. This does not establish that every SQL path has received an exhaustive review.
- Removed partial Spotify cookie logging from login setup and restricted the local `.env` file to its owner.
- Updated dependencies with known vulnerabilities and migrated the scraper to Puppeteer 25 and Node 24. Added automated tests and dependency audits. Dashboard runtime helpers are contained within the Render service root.
- Replaced the legacy security test with isolated checks that do not mutate live data or trigger scraping. Updated an existing SQL regression assertion to match the current indexed query alias.

## Validation at the time of review

| Check | Result |
| --- | --- |
| Offline tests | 80 passed, including 15 security regressions |
| Chrome checks | Script loading, chart rendering, canvas generation, and card interactions worked under CSP; injected scripts and event handlers were blocked |
| Node 24 compatibility | Security tests, Puppeteer startup, and Secure/HttpOnly cookie setup passed |
| Dashboard dependency audit | 0 known vulnerabilities reported by `npm audit` |
| Scraper dependency audit | 0 known vulnerabilities reported by `npm audit` |
| Verified connection to the configured database | Passed with encryption and certificate authorization using the bundled Supabase CA; a read-only `SELECT 1` succeeded |

Gitleaks scanned the current Git-visible files and the complete local, non-shallow history of 486 commits. Its three matches were two public Cloudflare Analytics site identifiers and a Spotify track identifier. Previously published administrator passwords must still be treated as compromised; a scanner failing to classify them as secrets does not make them safe.

Dependency audit results are a dated snapshot. They do not guarantee that all application vulnerabilities have been found.

## Production rollout

- Render deployment `dep-dbabhnbbc2fs73apdllg` completed successfully for application revision `a1675828bd33009c3f79c465ffa65f5c8356983f`.
- The main and secondary administrator credentials, IP hashing key, and locked-profile code were updated without replacing unrelated service environment variables. The matching local values remain in the ignored `.env` file.
- Node 24.22.0 was confirmed in the production build logs. The existing Render service uses `npm install` with the committed lockfile; the Blueprint specifies `npm ci` for reproducible provisioning.
- Both GitHub security checks on the release passed. The production build also reported 0 known dependency vulnerabilities.
- All 12 production smoke checks passed: deployed revision, dashboard/CSP, public artist roster and statistics, anonymous administrator denial, rejection of both published passwords, acceptance of both rotated administrator credentials, secondary-role restrictions, loopback image-proxy rejection, and malformed artist-query rejection.

## Operating the deployment

Keep administrator credentials and the IP hashing key independent and rotate them if exposed. Never publish their values. Supabase shared poolers use the bundled CA automatically; review the [certificate provenance and expiry](services/web-dashboard/certs/README.md) when the provider rotates its CA. Other database endpoints can use explicit `DB_SSL_CA` or `DB_SSL_CA_FILE` overrides.

Verify `/healthz` and administrator role restrictions after future releases. At this rollout, Render's automatic Git integration did not start a deployment for the merge, and the optional `RENDER_DEPLOY_HOOK` GitHub secret was absent; the release was explicitly deployed through the connected Render integration with a cleared build cache.

A full scraper run with real Spotify credentials was not performed, production data was not modified, and this review does not claim to be a complete penetration test.

## References

- [node-postgres TLS configuration](https://node-postgres.com/features/ssl)
- [Supabase SSL enforcement and CA certificates](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Supabase Database Settings](https://supabase.com/dashboard/project/_/database/settings)
- [Render service root directories](https://render.com/docs/monorepo-support)
