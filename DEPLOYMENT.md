# Relay deployment and operations

Relay requires PostgreSQL. It does not create, copy, or fall back to a local SQLite database. Set `DATABASE_URL` before starting the server; database initialization applies the checked-in, versioned SQL migrations and the health endpoint waits for that initialization to finish. `vercel.json` explicitly includes the migration SQL files in the serverless function bundle.

## Supabase setup

1. Create a Supabase project and choose the production region and backup/PITR plan.
2. In **Connect**, select the **Transaction pooler** connection string (port `6543`) for the serverless application. The username is usually `postgres.<project-ref>`. Do not use the project database password placeholder; use the password generated for the project.
3. Use the URL form below as a reference and replace every bracketed value. Supabase connections always use TLS. Relay defaults Supabase connections to `sslmode=require` if the URL omits it: traffic is encrypted but the server certificate is not verified, matching PostgreSQL's `require` mode and supporting poolers with self-signed certificate chains. This is a compatibility setting; use a trusted CA and certificate-verification mode for deployments that require protection against server impersonation.

   ```text
   postgresql://postgres.<project-ref>:<database-password>@<region>.pooler.supabase.com:6543/postgres?sslmode=require
   ```

   Keep the URL private. Do not put it in browser code, logs, screenshots, source control, or support requests. Relay uses a small `pg` connection pool (maximum three clients per process), ordinary parameterized queries with PostgreSQL `$1` placeholders, and no named/prepared statements or session state. The transaction pooler is therefore suitable for Vercel serverless deployments.
4. Set `DATABASE_URL` in the deployment secret manager. On Vercel, add it under **Project → Settings → Environment Variables** for Production, Preview, and Development as needed. Use a separate, isolated database or explicitly separate schema for Preview/Development; never point those environments at production.
5. Add the other required provider secrets listed below. Do not commit `.env`; `.env.example` contains placeholders only.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL URL. Use Supabase's transaction pooler for Vercel/serverless. |
| `PORT` | HTTP port; Vercel provides this automatically. Docker Compose defaults to `3000`. |
| `INQUIRIES_API_TOKEN` | Strong random bearer token for reading website inquiries. |
| `OWNER_ADMIN_TOKEN` | Separate strong random bearer token for the hidden owner console and paid workspace provisioning/renewal. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional inquiry notification provider credentials. |
| `RESEND_API_KEY` | Email provider API key for password recovery. |
| `AUTH_EMAIL_FROM` | Sender address verified with the email provider. |
| `INQUIRY_NOTIFICATION_EMAIL` | Inbox for contact and demo inquiry notifications. |
| `PUBLIC_BASE_URL` | Public HTTPS origin used in password recovery links. |
| `TRUST_PROXY_HOPS` | Number of trusted reverse proxies in front of Relay. Configure only when appropriate for the host. |
| `OPENAI_API_KEY` | Optional server-side secret for Ray. Leave unset to disable Ray. |
| `OPENAI_MODEL` | Optional Ray model name; defaults to `gpt-4o-mini`. |

Use unique production credentials and rotate them if exposed. Never put secrets in frontend configuration.

## Manual paid workspace access

Relay does not process payments. Public workspace creation is disabled. Clients use **Book a Demo** or **Contact**; after you confirm payment, activate them in the separate owner console. The page is intentionally not linked from customer-facing navigation and asks for an owner-only secret; it is not a public signup or approval link.

1. In Vercel, open the Relay project and go to **Settings → Environment Variables**.
2. Add `OWNER_ADMIN_TOKEN` for **Production**. Generate a strong value locally in PowerShell:

   ```powershell
   $bytes = New-Object byte[] 32
   $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
   $rng.GetBytes($bytes)
   $ownerAdminToken = [Convert]::ToBase64String($bytes)
   $rng.Dispose()
   $ownerAdminToken
   ```

   Copy the generated value directly into Vercel as `OWNER_ADMIN_TOKEN`. Treat it as a password: it can create and renew paid client workspaces. Do not put it in source control, send it to customers, or reuse `INQUIRIES_API_TOKEN`. If exposed, replace it in Vercel and redeploy.
3. Keep `INQUIRIES_API_TOKEN` as a separate secret for the inquiries dashboard; it does not grant owner-console access.
4. Save the variable and redeploy the Production deployment so the server receives it.
5. Open `https://<your-domain>/relay-owner-console.html` directly, enter `OWNER_ADMIN_TOKEN`, and select **Continue**. This page is not linked in customer navigation and has `noindex`; actual workspace data and actions are protected by the server token. Do not rely on the hidden URL as the security boundary.
6. After payment is confirmed, enter the workspace name and the client's owner's email, then select **Approve payment & create access**. Relay creates the account and grants one calendar month starting immediately.
7. Copy the generated initial password from the result and send it to the client through a secure channel. It is shown only in that result; it is not emailed. The client can sign in at `https://<your-domain>/product`; this redirects to `product.html` and preserves query parameters such as `?demo=ray`.
8. After renewal payment, find the client in **Client workspaces** and select **Add 1 month**. If the subscription has expired, the month starts immediately; if still active, the extra month is added after its current expiry.

The client can invite teammates to their active workspace without separate approval or payment; there is no seat limit currently. All workspace members lose access when that workspace's subscription expires. The workspace provisioning command remains available for operator use, but is not needed for this owner-console workflow. The database migration does not grant access to existing workspaces automatically.

Demo and contact forms submit to Relay's `/api/inquiries` endpoint and require the deployed website/server and a configured `DATABASE_URL`. Opening an HTML page directly as a `file://` URL will not submit inquiries; use the deployed HTTPS website or run Relay with its database configured.

To receive each submitted contact or demo inquiry by email, configure `INQUIRY_NOTIFICATION_EMAIL`, `RESEND_API_KEY`, and `AUTH_EMAIL_FROM` in the deployment environment. Verify the sender address/domain with Resend. The inquiry is saved even if the notification provider is temporarily unavailable; check the `inquiry_email_notification_failed` server event if an email does not arrive.

## Schema initialization and deployment

The application automatically applies unapplied files in `migrations/` in numeric order, records them in `relay_schema_migrations`, and only begins serving after initialization succeeds. Migrations run transactionally and the initial schema is safe for a new, empty Supabase database.

For an explicit pre-deploy initialization, run from a trusted machine with the target `DATABASE_URL` configured:

```powershell
npm ci
npm run db:migrate
```

Deploy the application only after checking that the URL points to the intended Supabase project. For Vercel, configure the project environment variables, deploy, and verify:

1. `https://<your-domain>/healthz` returns HTTP `200` with `{"status":"ok","database":"ok"}`.
2. A manually provisioned, paid test workspace can sign in/out, and its session is denied when the subscription expires.
3. Password recovery, invitation acceptance, process/template creation, implementation tasks, requirements/customer input, account deletion, and inquiry intake behave as expected using test data.
4. Ray responds only when configured; without its provider key the API reports that Ray is unavailable. Verify inquiry and password-recovery providers using non-customer test recipients.
5. Review logs and confirm they contain no credentials, passwords, reset/invitation/customer-link tokens, authorization headers, or customer-submitted values.

The checked-in migrations create an empty PostgreSQL schema. They do **not** import `relay.db` or any other local SQLite file. Existing SQLite data is left untouched; no hosted database was contacted or modified for this repository change. A data transfer requires separate authorization, an explicitly designed export/import process, verified backups, and a tested cutover plan.

For Docker Compose, copy `.env.example` to `.env` and set the required `DATABASE_URL`, `INQUIRIES_API_TOKEN`, `OWNER_ADMIN_TOKEN`, `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, and `PUBLIC_BASE_URL` values, then run:

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 relay
```

Telegram inquiry notifications are optional; set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable them. Inquiry email notifications are also optional; set `INQUIRY_NOTIFICATION_EMAIL` along with the configured Resend credentials to enable them.

Compose runs the service as non-root with a read-only root filesystem. PostgreSQL persistence and backups are managed by Supabase, not by an application volume.

## Tests and CI

Tests require `RELAY_TEST_DATABASE_URL` and refuse to run unless its database name is exactly `relay_test`. The product suite creates a unique random schema, points its server/test connections at that schema, and drops only that schema afterward. It never truncates or drops a database or shared schema. To run locally, create a dedicated disposable database named `relay_test`, then set the variable to its connection URL:

```powershell
$env:RELAY_TEST_DATABASE_URL = "postgresql://postgres:password@localhost:5432/relay_test"
npm test
```

GitHub Actions starts an isolated PostgreSQL service for the job, runs tests against unique schemas, and uses a separate `relay_smoke` schema for its container smoke test. The local suite requires a reachable PostgreSQL service; without one, database execution is not locally verified.

## Backups and restore

Use Supabase's managed backup/PITR facilities where available. To create a portable custom-format dump from a trusted machine, install the PostgreSQL client tools (`pg_dump`), set `DATABASE_URL` in the environment, and run:

```powershell
npm run backup -- .\backups\relay-2026-10-29.dump
pg_restore --list .\backups\relay-2026-10-29.dump
```

The helper uses `pg_dump`, refuses to overwrite an existing destination, and restricts output file permissions. Keep encrypted backups separately from the service, limit access, and follow a retention schedule consistent with customer obligations. A dump is not verified until its contents are listed and it has been restored to an isolated non-production database and checked.

Restore only into a deliberately selected non-production database first. For example, with `DATABASE_URL` explicitly set to a disposable restore target, use:

```powershell
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$env:DATABASE_URL" .\backups\relay-2026-10-29.dump
npm run db:migrate
```

Do not run a restore command against production without an approved incident/recovery plan. Before restoring an older snapshot, account for any later account deletions, ownership changes, or other requests that must not be reversed. Record and rehearse recovery steps; confirm the target URL before each operation.

## Monitoring and incident response

- Monitor `/healthz` externally and alert on repeated failures. The endpoint reports database readiness, not provider health or an alerting service.
- Review `request_failed`, `health_check_failed`, `database_initialization_failed`, `inquiry_notification_failed`, `password_reset_email_failed`, and `relay_help_provider_failed` events. Restrict log access and retention.
- Monitor Supabase connection usage, database capacity, backup/PITR status, application errors, email delivery, inquiry notifications, and provider error rates.
- Set a named operator and support contact. For suspected credential exposure, rotate the provider secret and redeploy; restrict access to snapshots and logs during an incident.
- Account deletion removes the user's records, removes sole-member workspaces, and requires transferring ownership of shared workspaces. Confirm applicable retention and deletion obligations with qualified counsel.
- Review `PRIVACY-TERMS-REVIEW.md` against the actual operator, host, region, providers, retention, support, and customer agreement before accepting customer information or payment.

These are operational instructions, not a configured monitoring or incident-response service. Test the alert path and recovery process using non-production data before onboarding customers.
