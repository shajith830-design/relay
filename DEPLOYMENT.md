# Relay deployment and operations

Relay requires PostgreSQL. It does not create, copy, or fall back to a local SQLite database. Database initialization applies the checked-in, versioned SQL migrations and the health endpoint waits for that initialization to finish.

## Cloudflare Workers production deployment

The Cloudflare Worker must deploy both the Worker entry point and the static assets. A static-only deployment serves the website but returns 404 for the API, health, and inquiry routes. `wrangler.jsonc` configures the existing app as a Worker with static assets and a PostgreSQL Hyperdrive binding.

An empty local `.env` does not affect the deployed Worker: it gets its database connection from Hyperdrive and its secrets from Cloudflare Worker settings. Do not copy production credentials into `.env` or Git.

1. For a $0 pilot, create a Supabase Free PostgreSQL project, then create a Cloudflare Hyperdrive configuration using that database's connection details. Supabase Free includes 500 MB and can pause a project after one week of inactivity; Hyperdrive's Free allocation is 100,000 database statements per day.
2. Replace `REPLACE_WITH_CLOUDFLARE_HYPERDRIVE_ID` in `wrangler.jsonc` with the Hyperdrive configuration ID. The ID is a resource identifier, not the database password.
3. Ray uses built-in Relay-specific answers and does not require an AI binding, model, or external provider credentials. Its responses are curated rather than generative, so questions without a matching built-in answer receive a clear fallback.
4. Configure Worker secrets in Cloudflare or with Wrangler. Set the required `INQUIRIES_API_TOKEN` and `OWNER_ADMIN_TOKEN` as separate high-entropy secrets. Add `RESEND_API_KEY` if password recovery/email notifications are enabled. Never store these values in `wrangler.jsonc`, `.env.example`, or Git.
5. Configure the non-secret Worker variable `PUBLIC_BASE_URL=https://relayautomation.tech`. Add `AUTH_EMAIL_FROM` (a sender verified with your email provider) and `INQUIRY_NOTIFICATION_EMAIL` if email notifications are wanted.
6. From a trusted machine with Node.js installed, authenticate Wrangler to the correct Cloudflare account and deploy:

   ```powershell
   npm ci
   npx wrangler login
   npm run deploy:cloudflare
   ```

   Confirm the Worker named `relay` is the Worker currently serving `relay.shajith830.workers.dev` and that the production custom domain `relayautomation.tech` remains attached to it. Do not copy Cloudflare authentication tokens into this repository.
7. Verify against the production domain:
   - `GET /healthz` returns `200` with `{"status":"ok","database":"ok"}`.
   - Signed-out `GET /api/product/me` returns `401`, not `404`.
   - `GET /inquiries` without a bearer token returns `401`, not `404`.
   - A valid dummy contact/demo submission to `POST /api/inquiries` returns `201`.
   - Test sign-in, password recovery (if configured), customer link submission, and workspace actions with a dedicated staging account before onboarding clients.

This is a low-cost pilot setup, not an uptime guarantee. Workers Free allows 100,000 Worker requests per day and 10 ms CPU per request. Relay's scrypt password hashing may exceed that CPU limit, so verify account creation and sign-in on the deployed Free Worker before inviting the client; do not weaken password hashing to bypass the limit. Supabase Free can pause after a week without activity. Review each provider's current quotas and have a recovery plan before relying on the service for client operations. See Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), and [Supabase pricing](https://supabase.com/pricing).

## Supabase setup

1. Create a Supabase project and choose the production region and backup/PITR plan.
2. In **Connect**, select the **Transaction pooler** connection string (port `6543`) for the serverless application. The username is usually `postgres.<project-ref>`. Do not use the project database password placeholder; use the password generated for the project.
3. Use the URL form below as a reference and replace every bracketed value. Supabase connections always use TLS. Relay defaults Supabase connections to `sslmode=require` if the URL omits it: traffic is encrypted but the server certificate is not verified, matching PostgreSQL's `require` mode and supporting poolers with self-signed certificate chains. This is a compatibility setting; use a trusted CA and certificate-verification mode for deployments that require protection against server impersonation.

   ```text
   postgresql://postgres.<project-ref>:<database-password>@<region>.pooler.supabase.com:6543/postgres?sslmode=require
   ```

   Keep the URL private. Do not put it in browser code, logs, screenshots, source control, or support requests. Relay uses a small `pg` connection pool (maximum three clients per process), ordinary parameterized queries with PostgreSQL `$1` placeholders, and no named/prepared statements or session state. Configure this URL in Cloudflare Hyperdrive; do not expose it as a Worker variable.
4. Configure separate Hyperdrive/database resources for production and non-production environments. Never point a staging Worker at the production database.
5. Add the other required provider secrets listed below to the Cloudflare Worker. Do not commit `.env`; `.env.example` contains placeholders only.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL URL for Node/Docker deployments. The Cloudflare Worker gets its connection string from the `HYPERDRIVE` binding instead. |
| `PORT` | HTTP port for Node/Docker deployments. The Cloudflare Worker does not use it. |
| `INQUIRIES_API_TOKEN` | Strong random bearer token for reading website inquiries. |
| `OWNER_ADMIN_TOKEN` | Separate strong random bearer token for the hidden owner console and paid workspace provisioning/renewal. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional inquiry notification provider credentials. |
| `RESEND_API_KEY` | Email provider API key for password recovery. |
| `AUTH_EMAIL_FROM` | Sender address verified with the email provider. |
| `INQUIRY_NOTIFICATION_EMAIL` | Inbox for contact and demo inquiry notifications. |
| `PUBLIC_BASE_URL` | Public HTTPS origin used in password recovery links. |
| `TRUST_PROXY_HOPS` | Number of trusted reverse proxies in front of Relay. Configure only when appropriate for the host. |
| Ray responses | Built-in Relay answer library; no external AI service or provider configuration is used. |

Use unique production credentials and rotate them if exposed. Never put secrets in frontend configuration.

## Manual paid workspace access

Relay does not process payments. Public workspace creation is disabled. Clients use **Book a Demo** or **Contact**; after you confirm payment, activate them in the separate owner console. The page is intentionally not linked from customer-facing navigation and asks for an owner-only secret; it is not a public signup or approval link.

1. In Cloudflare, open the `relay` Worker settings and add `OWNER_ADMIN_TOKEN` as a secret. Generate a strong value locally in PowerShell:

   ```powershell
   $bytes = New-Object byte[] 32
   $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
   $rng.GetBytes($bytes)
   $ownerAdminToken = [Convert]::ToBase64String($bytes)
   $rng.Dispose()
   $ownerAdminToken
   ```

   Copy the generated value directly into the Cloudflare Worker secret. Treat it as a password: it can create and renew paid client workspaces. Do not put it in source control, send it to customers, or reuse `INQUIRIES_API_TOKEN`. If exposed, replace it in Cloudflare and redeploy.
3. Keep `INQUIRIES_API_TOKEN` as a separate secret for the inquiries dashboard; it does not grant owner-console access.
4. Save the variable and redeploy the Production deployment so the server receives it.
5. Open `https://<your-domain>/relay-owner-console.html` directly, enter `OWNER_ADMIN_TOKEN`, and select **Continue**. This page is not linked in customer navigation and has `noindex`; actual workspace data and actions are protected by the server token. Do not rely on the hidden URL as the security boundary.
6. After payment is confirmed, enter the workspace name and the client's owner's email, then select **Approve payment & create access**. Relay creates the account and grants one calendar month starting immediately.
7. Copy the generated initial password from the result and send it to the client through a secure channel. It is shown only in that result; it is not emailed. The client can sign in at `https://<your-domain>/product`; this redirects to `product.html` and preserves query parameters such as `?demo=ray`.
8. After renewal payment, find the client in **Client workspaces** and select **Add 1 month**. If the subscription has expired, the month starts immediately; if still active, the extra month is added after its current expiry.

The client can invite teammates to their active workspace without separate approval or payment; there is no seat limit currently. All workspace members lose access when that workspace's subscription expires. The workspace provisioning command remains available for operator use, but is not needed for this owner-console workflow. The database migration does not grant access to existing workspaces automatically.

Demo and contact forms submit to Relay's `/api/inquiries` endpoint and require the deployed Worker and its configured Hyperdrive database. Opening an HTML page directly as a `file://` URL will not submit inquiries; use the deployed HTTPS website or run Relay with its database configured.

To receive each submitted contact or demo inquiry by email, configure `INQUIRY_NOTIFICATION_EMAIL`, `RESEND_API_KEY`, and `AUTH_EMAIL_FROM` in the deployment environment. Verify the sender address/domain with Resend. The inquiry is saved even if the notification provider is temporarily unavailable; check the `inquiry_email_notification_failed` server event if an email does not arrive.

## Schema initialization and deployment

The application automatically applies unapplied files in `migrations/` in numeric order, records them in `relay_schema_migrations`, and only begins serving after initialization succeeds. Migrations run transactionally and the initial schema is safe for a new, empty Supabase database.

For an explicit pre-deploy initialization, run from a trusted machine with the target `DATABASE_URL` configured:

```powershell
npm ci
npm run db:migrate
```

Deploy the Worker only after confirming Hyperdrive points to the intended production database. Configure the Worker secrets and variables, deploy, and verify:

1. `https://<your-domain>/healthz` returns HTTP `200` with `{"status":"ok","database":"ok"}`.
2. A manually provisioned, paid test workspace can sign in/out, and its session is denied when the subscription expires.
3. Password recovery, invitation acceptance, process/template creation, implementation tasks, requirements/customer input, account deletion, and inquiry intake behave as expected using test data.
4. Ray uses built-in answers without provider configuration. Verify a greeting, a supported Relay workflow, and the out-of-scope fallback before inviting clients.
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
