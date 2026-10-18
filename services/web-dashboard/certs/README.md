# Supabase pooler certificate authority

`supabase-prod-ca-2021.crt` is the public **Supabase Root 2021 CA** certificate.
It contains no private key or account credential.

The database helper loads this CA automatically only for hosts ending in
`.pooler.supabase.com`. Certificate and hostname verification stay enabled.
Explicit `DB_SSL_CA` or `DB_SSL_CA_FILE` settings take precedence. Other database
providers continue to use system trust unless a CA is explicitly configured.

## Provenance

The certificate was obtained over verified HTTPS from the production download
URL used by the official Supabase dashboard:

- [Supabase dashboard certificate URL configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json)
- [Supabase dashboard certificate download component](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/Settings/Database/SSLConfiguration.tsx)
- [Production CA download](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt)

Verified on October 18, 2026:

- **Subject:** Supabase Root 2021 CA, Supabase Inc
- **Expires:** April 26, 2031 at 10:56:53 UTC
- **SHA-256 fingerprint:** `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`

Review the official distribution and update the certificate before expiry or
when Supabase announces a CA rotation. Never replace verification with
`rejectUnauthorized: false` to work around a certificate failure.
