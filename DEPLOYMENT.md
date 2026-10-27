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
| `OPENAI_API_KEY` | Optional server-side secret for Relay Help. Leave unset to disable Ray; configure only if Ray is enabled for launch. Never expose this value to browser code. |
| `OPENAI_MODEL` | Optional AI model identifier for Relay Help; defaults to `gpt-4o-mini` when Ray is configured. |

Do not put any secret in browser code, page source, screenshots, support messages, or source control. Use unique production credentials and rotate them if exposed.

## First deployment

1. Choose a production host and configure a domain, HTTPS, restart behavior, access to deployment logs, and a persistent Docker volume for `/app/data`. The Compose port binds to host loopback (`127.0.0.1:3000`); configure a host reverse proxy to terminate HTTPS and forward traffic locally to that port.
2. Copy `.env.example` to `.env` locally or transfer its variables to the host's secret manager. Replace every example value. `OPENAI_API_KEY` may remain blank if Ray is disabled. Verify the sending domain and sender address with the email provider.
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

The GitHub Actions workflow runs the tests, validates Compose without an AI provider key, builds the production image, and starts it with an isolated volume under the Compose read-only, non-root, dropped-capability runtime constraints. Its smoke test checks health, static product delivery, production HSTS and cookie attributes, account creation and authenticated access, session/data persistence after container restart, graceful password-recovery and Ray behavior without provider keys, and inquiry acceptance with no Telegram provider. It does not send data to real third-party providers. Treat a successful workflow run as the Docker build verification; the local test suite does not replace it.

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

The copied backup must not live only in the same host or volume as the service. Restrict access and encrypt it using the chosen backup storage. The 30-day maximum is a proposed operational target in this checklist, not a verified host setting or legal conclusion; confirm it is appropriate and achievable with the actual provider and applicable obligations. Maintain a restricted deletion ledger outside the application database and backup snapshots, containing only the account identifier and deletion date needed to replay removals. Record workspace ownership transfers/deletions that must be replayed as well. Before restoring a snapshot, apply every later deletion and ownership change so deleted records are not returned to service or removed users regain control. Remove ledger entries after all backups that could contain the data have expired. These backup and restore controls are operational responsibilities outside the application and must be exercised before onboarding customers.

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

## Monitoring and incident response

### Routine checks

- Monitor `/healthz` from outside the host at an interval appropriate to the service. Alert on repeated failures, not a single transient probe; test that alerts reach a monitored person.
- Collect container/application logs centrally with restricted access and a defined retention period. Do not log request bodies, passwords, reset/invitation/customer-link tokens, authorization headers, AI keys, or customer-submitted values.
- Review `request_failed`, `health_check_failed`, `inquiry_notification_failed`, `password_reset_email_failed`, and `relay_help_provider_failed` events. Correlate by event and timestamp; do not copy credentials or sensitive payloads into support tickets.
- Monitor disk space and SQLite volume capacity, backup job success and age, container restarts, email delivery, inquiry notifications, and provider error rates.
- Keep an operator and backup contact assigned. Document who receives alerts, who can stop/restart the service, and where the recovery instructions and encrypted backups are held.

### Incident response runbook

1. **Triage and record:** note start time, affected service/workspaces, symptoms, and actions. Use synthetic/test accounts to reproduce where possible. Do not put customer secrets or full customer records into incident notes.
2. **Contain:** for suspected credential exposure, revoke/rotate the affected provider key at the provider, update the host secret store, and restart/redeploy. For suspected customer-link exposure, rotate the affected link. If the application itself is actively exposing data, restrict public access at the reverse proxy/host while preserving the database for investigation.
3. **Protect evidence:** restrict access to relevant logs and database/volume snapshots. Do not overwrite or publicly share evidence. Preserve timestamps and record who accessed or changed production systems.
4. **Restore service safely:** use the restore exercise above on a copy first when feasible. Before restoring an older snapshot, replay the deletion/ownership ledger and verify the resulting database. Never restore a test snapshot over production.
5. **Notify and escalate:** promptly contact the named service operator and hosting/provider support. Assess whether affected customers, regulators, or other parties need notice under applicable contracts and law; obtain appropriate qualified advice. Do not promise a notice deadline from this generic checklist.
6. **Recover and verify:** restore normal access only after checking `/healthz`, sign-in, a test workflow, database persistence, and provider connectivity. Confirm rate/error monitoring is active.
7. **Learn and close:** document root cause, scope, data involved, containment, recovery time, customer communications, and corrective actions. Review secrets, access, backup state, and tests; assign owners and due dates.

These are operational instructions, not a configured monitoring or incident-response service. Test the alert path and runbook with a non-production exercise before inviting customers.

## Operational responsibilities

- Configure external uptime and log monitoring; the health endpoint is a probe, not an alerting service.
- Review `inquiry_notification_failed`, `password_reset_email_failed`, and `request_failed` events. Inquiry records are stored even if notification delivery fails.
- After explicit consent, Relay Help sends the user's question and recent private conversation to the configured AI service. The assistant receives only a curated user-facing Relay guide, never account or customer workspace records. Users can clear their own help history and withdraw consent in the chat panel.
- Ray is optional at deployment. If `OPENAI_API_KEY` is absent, the product API reports that Ray is unavailable; verify the UI communicates this clearly before disabling it for a customer-facing launch.
- Set a person and monitored support channel responsible for customer requests and incidents.
- Account deletion is available in Settings. It removes the account from the live database, deletes workspaces where that account was the sole member, and removes a departing member from shared workspaces; an owner must transfer ownership to a remaining member. Configure backup expiry at 30 days or less and reapply post-snapshot deletion requests before restoring a database.
- Before charging customers, have the service provider, pricing, billing, renewal, cancellation/refund terms, governing law, privacy obligations, and support commitments reviewed and stated in writing.
- Complete the privacy and service-terms review checklist in `PRIVACY-TERMS-REVIEW.md` using the actual operator, jurisdiction, host, providers, and customer agreement; it is a review aid, not legal advice.
- Keep release artifacts and backups separate from the working directory and user-local database.
