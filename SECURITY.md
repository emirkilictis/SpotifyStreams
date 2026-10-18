# Security review — October 18, 2026

The code changes described below are prepared in the working tree. They have not been deployed to the production Render service. Production credential rotation and deployment remain required. The configured Supabase connection now passes verified TLS using the bundled official CA.

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

## Required production rollout

1. Set strong, independent `ADMIN_PASSCODE`, `SECADMIN_PASSCODE`, and `IP_HASH_SECRET` values on Render. The local ignored `.env` file has new values for these credentials and the locked-profile code. Keep them out of public commits and chat messages.
2. Standard Supabase shared poolers use the bundled CA automatically. For a different database endpoint, configure `DB_SSL_CA` or `DB_SSL_CA_FILE` on Render and the `DB_SSL_CA` repository secret for GitHub Actions if a custom CA is needed. Confirm verified TLS after deployment. See the [certificate provenance](services/web-dashboard/certs/README.md).
3. Configure `JC_PASSCODES` if locked-profile access is needed. The old published codes are no longer accepted by the updated code. Keep the push dispatch secret strong and independent.
4. Set Render to Node 24. For services not managed through the Blueprint, update their dashboard settings manually: root `services/web-dashboard`, build `npm ci`, start `node server.js`.
5. Deploy after the required settings are in place. Verify service health, administrator login, role restrictions, and read-only data endpoints in production.

A full scraper run with real Spotify credentials was not performed, production data was not modified, and this review does not claim to be a complete penetration test.

## References

- [node-postgres TLS configuration](https://node-postgres.com/features/ssl)
- [Supabase SSL enforcement and CA certificates](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Supabase Database Settings](https://supabase.com/dashboard/project/_/database/settings)
- [Render service root directories](https://render.com/docs/monorepo-support)
