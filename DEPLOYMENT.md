# Relay release and operations checklist

This checklist covers repository and deployment work. A successful test run or local preview does not confirm that a public deployment is ready.

## Before every release

- Review `git status --short`, `git diff --cached`, and `git diff`. Understand every changed file before including it; do not commit local databases, secrets, scratch files, or unrelated work.
- Run `npm test` and `git diff --check`.
- Build the production image with `docker compose build`.
- Confirm `.env` is local-only and contains deployment values, not examples. Never commit `.env`, provider keys, database backups, customer exports, or production database files.
- Confirm the intended public domain serves HTTPS and `PUBLIC_BASE_URL` exactly matches it.
- Review `public/privacy.html` and `public/terms.html` against the real operator, hosting, provider, retention, support, legal, payment, and cancellation arrangements before accepting customer information or payment.

## Required configuration

Set these values in the deployment secret manager or an appropriately protected `.env` file:

| Variable | Purpose |
| --- | --- |
| `PORT` | Application port; Compose sets this to `3000`. |
| `DATABASE_PATH` | SQLite database path; Compose sets this to `/app/data/relay.db`. Keep `/app/data` on persistent storage. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot credential for inquiry notifications; required by the current Compose configuration. |
| `TELEGRAM_CHAT_ID` | Destination for inquiry notifications; required by the current Compose configuration. |
| `INQUIRIES_API_TOKEN` | Strong random bearer token for the inquiry dashboard API. |
| `RESEND_API_KEY` | Email provider API key used to deliver password recovery links. |
| `AUTH_EMAIL_FROM` | Sender address verified with the email provider. |
| `PUBLIC_BASE_URL` | Public HTTPS origin used in password recovery links. |
| `TRUST_PROXY_HOPS` | Number of trusted reverse proxies in front of Relay. Compose defaults to one local host proxy; only use this when the application port is not directly reachable by untrusted clients. |
| `OPENAI_API_KEY` | Server-side secret used by Relay Help to request focused product-support answers from the configured AI service. Never expose this value to browser code. |
| `OPENAI_MODEL` | AI model identifier used for Relay Help; defaults to `gpt-4o-mini`. |

Do not put any secret in browser code, page source, screenshots, support messages, or source control. Use unique production credentials and rotate them if exposed.

## First deployment

1. Choose a production host and configure a domain, HTTPS, restart behavior, access to deployment logs, and a persistent Docker volume for `/app/data`. The Compose port binds to host loopback (`127.0.0.1:3000`); configure a host reverse proxy to terminate HTTPS and forward traffic locally to that port.
2. Copy `.env.example` to `.env` locally or transfer its variables to the host's secret manager. Replace every example value. Verify the sending domain and sender address with the email provider.
3. Build and start the service:

   ```powershell
   docker compose build
   docker compose up -d
   docker compose ps
   docker compose logs --tail 100 relay
   ```

4. From a browser or shell, check the public `https://<your-domain>/healthz`, homepage, pricing, terms, privacy, and product pages. Health must return `200` and report `"database":"ok"`.
5. Using a test account and test customer data, verify account creation, sign-in/out, password recovery email delivery, password reset and old-session invalidation, teammate invitation, process/template setup, implementation creation, customer information submission, and workspace separation.
6. Submit an inquiry using the public form. Confirm the response is successful, the inquiry is available to the authorized dashboard, and the notification arrives. Check logs for notification failures. Do not use real customer data for this smoke test.
7. Restart the service and repeat the health check and sign-in check. Confirm the named volume still contains the database.

The GitHub Actions workflow runs the tests, builds the production image, starts it with an isolated test volume, and checks its health and product page on every push and pull request. Treat the workflow as the Docker build verification; the local test suite does not replace it.

## SQLite backup

The backup command uses SQLite's online backup API and checks the output integrity. It refuses to overwrite an existing destination:

```powershell
npm run backup -- .\backups\relay-2026-10-26.db
```

Set `DATABASE_PATH` to the database being backed up. For a Compose deployment, create the snapshot inside the mounted data volume, then copy it out to a separate protected destination:

```powershell
docker compose exec -T relay node scripts/backup-database.js /app/data/relay-backup.db
docker compose cp relay:/app/data/relay-backup.db .\relay-backup.db
```

The copied backup must not live only in the same host or volume as the service. Restrict access and encrypt it using the chosen backup storage. Establish an appropriate schedule and retention policy outside the application.

## Restore exercise

Practice with a non-production copy before relying on a backup:

1. Stop the service without removing its container: `docker compose stop relay`.
2. Preserve a copy of the current database before replacing it:

   ```powershell
   docker compose cp relay:/app/data/relay.db .\relay-before-restore.db
   ```

   Do not replace a live database. If SQLite sidecars remain after a clean stop, preserve them with the database.
3. Copy the selected backup to `/app/data/relay.db` in the mounted volume:

   ```powershell
   docker compose cp .\relay-backup.db relay:/app/data/relay.db
   ```

4. Start the service: `docker compose start relay`.
5. Check `/healthz`, sign in with the test account, and verify the expected test records.
6. Record the restore result and elapsed time. Keep the preserved files until recovery is confirmed.

## Operational responsibilities

- Configure external uptime and log monitoring; the health endpoint is a probe, not an alerting service.
- Review `inquiry_notification_failed`, `password_reset_email_failed`, and `request_failed` events. Inquiry records are stored even if notification delivery fails.
- After explicit consent, Relay Help sends the user's question and recent private conversation to the configured AI service. The assistant receives only a curated user-facing Relay guide, never account or customer workspace records. Users can clear their own help history and withdraw consent in the chat panel.
- Set a person and monitored support channel responsible for customer requests and incidents.
- Decide and document data retention and deletion handling. The product currently has no self-service account/data deletion control.
- Before charging customers, have the service provider, pricing, billing, renewal, cancellation/refund terms, governing law, privacy obligations, and support commitments reviewed and stated in writing.
- Keep release artifacts and backups separate from the working directory and user-local database.
