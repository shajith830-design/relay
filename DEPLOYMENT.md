# Relay deployment and operations

Relay requires PostgreSQL. It does not create, copy, or fall back to a local SQLite database. Database initialization applies the checked-in, versioned SQL migrations and the health endpoint waits for that initialization to finish.

## Cloudflare Workers production deployment

The Cloudflare Worker must deploy both the Worker entry point and the static assets. A static-only deployment serves the website but returns 404 for the API, health, and inquiry routes. `wrangler.jsonc` configures the existing app as a Worker with static assets, a PostgreSQL Hyperdrive binding, and the `relayautomation.tech/*` route. The deploy script validates the route and Hyperdrive ID before Wrangler can publish.

An empty local `.env` does not affect the deployed Worker: it gets its database connection from Hyperdrive and its secrets from Cloudflare Worker settings. Relay does not currently use `SUPABASE_URL` or `SUPABASE_ANON_KEY` to connect to PostgreSQL. Do not copy production credentials into `.env` or Git.

1. For a $0 pilot, create a Supabase Free PostgreSQL project, then create a Cloudflare Hyperdrive configuration using the database's **direct connection** details. Cloudflare Hyperdrive should manage connection pooling; do not put Supabase's transaction pooler in front of it. Supabase Free includes 500 MB and can pause a project after one week of inactivity; Hyperdrive's Free allocation is 100,000 database statements per day.
2. Replace `REPLACE_WITH_CLOUDFLARE_HYPERDRIVE_ID` in `wrangler.jsonc` with the 32-character Hyperdrive configuration ID. The ID is a resource identifier, not the database password. `npm run deploy:cloudflare` stops before publishing if the ID is still a placeholder or the production route is missing.
3. Ray uses built-in Relay-specific answers and does not require an AI binding, model, or external provider credentials. Its responses are curated rather than generative, so questions without a matching built-in answer receive a clear fallback.
4. Configure Worker secrets in Cloudflare or with Wrangler. Set the required `INQUIRIES_API_TOKEN` and `OWNER_ADMIN_TOKEN` as separate high-entropy secrets. Add `RESEND_API_KEY` if password recovery/email notifications are enabled. Never store these values in `wrangler.jsonc`, `.env.example`, or Git.
5. Configure the non-secret Worker variable `PUBLIC_BASE_URL=https://relayautomation.tech`. Add `AUTH_EMAIL_FROM` (a sender verified with your email provider) and `INQUIRY_NOTIFICATION_EMAIL` if email notifications are wanted.
6. From a trusted machine with Node.js installed, authenticate Wrangler to the correct Cloudflare account and deploy:

   ```powershell
   npm ci
   npx wrangler login
   npm run deploy:cloudflare
   ```

   The configured route directs `relayautomation.tech/*` to the `relay` Worker; confirm in Cloudflare that the zone and route are correct before deployment. Do not copy Cloudflare authentication tokens into this repository.
7. Verify against the production domain:
   - `GET /healthz` returns `200` with `{"status":"ok","database":"ok"}`.
   - Signed-out `GET /api/product/me` returns `401`, not `404`.
   - `GET /inquiries` without a bearer token returns `401`, not `404`.
   - A valid dummy contact/demo submission to `POST /api/inquiries` returns `201`.
   - Test sign-in, password recovery (if configured), customer link submission, and workspace actions with a dedicated staging account before onboarding clients.
   - Verify customer-facing tasks are explicitly selected, only those tasks appear in the customer portal, and a customer can complete only an eligible task.

## Customer portal, notifications, and integrations

Migration `006_customer_portal_notifications_integrations.sql` is applied automatically at startup and by the Worker. Only tasks explicitly marked **Show this task to the customer in their portal** are visible through a customer link. Customer-visible task titles, instructions, stages, due dates, and completion state are public to anyone holding that link; never mark internal-only work visible.

Workspace owners can enable email notifications in **Settings**. Configure `RESEND_API_KEY` and a verified `AUTH_EMAIL_FROM` first. Event emails go to workspace members; due-date reminders go to the assignee, or workspace members if the task is unassigned. Reminders are generated once per due date and then once per day for overdue tasks. Delivery failures are logged and retried up to five times.

Cloudflare runs the event queue every five minutes using the Worker Cron Trigger in `wrangler.jsonc`; set the secret `NOTIFICATIONS_CRON_SECRET` before enabling notifications. For Node/Docker hosting, configure an external scheduler to POST to `/api/product/internal/process-events` every five minutes with `Authorization: Bearer <NOTIFICATIONS_CRON_SECRET>`. Do not expose or paste that token. If email is enabled without working Resend credentials, event delivery is retried and logged as a failure.

To enable workspace OAuth connections, configure these secrets in Cloudflare (or the local Node environment):

| Variable | Purpose |
| --- | --- |
| `INTEGRATION_ENCRYPTION_KEY` | Base64-encoded random 32-byte key used to encrypt stored OAuth tokens and Slack webhook URLs. Keep it backed up securely; rotating it requires disconnecting and reconnecting integrations. |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | HubSpot OAuth app credentials. Request `crm.objects.deals.read` and `crm.objects.deals.write`. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Slack OAuth app credentials with the `incoming-webhook` scope. |
| `NOTIFICATIONS_CRON_SECRET` | High-entropy bearer secret for the scheduled event processor. |

Generate the encryption key locally; do not commit it:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set the HubSpot and Slack app redirect/callback URL to `https://relayautomation.tech/api/product/integrations/callback/hubspot` or `https://relayautomation.tech/api/product/integrations/callback/slack`, respectively (replace the hostname for non-production environments). Workspace owners connect tools from **Product → Settings**. HubSpot receives Relay implementation deals with progress, overdue, and blocked-task summaries; Slack receives implementation/task updates and reminders. Relay does not import CRM records. OAuth tokens are encrypted at rest; do not change the encryption key after connections have been stored unless you plan to reconnect each integration.

The **Portfolio** view shows task load, overdue work, implementation health, and a directional finish-date estimate based on completed-task pace. **Export CSV** downloads the current workspace portfolio. Treat the estimate as planning guidance, not a delivery commitment.

This is a low-cost pilot setup, not an uptime guarantee. Workers Free allows 100,000 Worker requests per day and 10 ms CPU per request. Relay's scrypt password hashing may exceed that CPU limit, so verify account creation and sign-in on the deployed Free Worker before inviting the client; do not weaken password hashing to bypass the limit. Supabase Free can pause after a week without activity. Review each provider's current quotas and have a recovery plan before relying on the service for client operations. See Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), and [Supabase pricing](https://supabase.com/pricing).

## Supabase setup

1. Create a Supabase project and choose the production region and backup/PITR plan.
2. In Supabase's **Connect** panel, choose **Direct connection**, not a pooled connection. Use the direct database hostname and port shown for your project (normally port `5432`) and the project database credentials. Cloudflare's Supabase/Hyperdrive guide specifically recommends the direct connection because Hyperdrive performs the connection pooling. Do not copy the transaction pooler's port `6543` connection into Hyperdrive.
3. If Supabase indicates that the direct endpoint is IPv6-only, use the direct endpoint with Hyperdrive as described by Cloudflare's [Supabase Hyperdrive guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/). Do not switch to a pooler without confirming that combination is supported. Supabase connections use TLS. Relay defaults Supabase connections to `sslmode=require` if the URL omits it: traffic is encrypted but the server certificate is not verified. Use a trusted CA and certificate-verification mode where supported and required by your deployment.

   ```text
   postgresql://postgres:<database-password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
   ```

   Keep the URL private. Do not put it in browser code, logs, screenshots, source control, or chat. Node/Docker deployments use a small `pg` connection pool (maximum three clients per process). The Cloudflare Worker opens and closes a PostgreSQL client for each backend request; Hyperdrive manages the underlying connection pool. Relay uses parameterized PostgreSQL queries with `$1` placeholders and no named/prepared statements or session state. Configure the direct URL in Cloudflare Hyperdrive; do not expose it as a Worker variable.
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
| `NOTIFICATIONS_CRON_SECRET` | Secret bearer token for the scheduled notification/event processor. |
| `INTEGRATION_ENCRYPTION_KEY` | Base64-encoded random 32-byte AES key for connected-provider credentials. |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | HubSpot OAuth app credentials. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Slack OAuth app credentials. |
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
6. After payment is confirmed, enter the workspace name and the client's owner's email. Select Starter (₹2,999/month), Growth (₹3,999/month), or Custom; for Custom, enter the agreed positive whole-number limits for members, active implementations, and templates. Prices are before applicable taxes. Then select **Approve payment & create access**. Relay creates the account and grants one calendar month starting immediately.
7. Copy the generated initial password from the result and send it to the client through a secure channel. It is shown only in that result; it is not emailed. The client can sign in at `https://<your-domain>/product`; this redirects to `product.html` and preserves query parameters such as `?demo=ray`.
8. After renewal payment, find the client in **Client workspaces** and select **Add 1 month**. If the subscription has expired, the month starts immediately; if still active, the extra month is added after its current expiry.

Starter includes 3 members, 5 active implementations, and 3 templates. Growth includes 10 members, 20 active implementations, and unlimited templates. Custom limits are agreed in advance. Limits are enforced by the API as well as shown in the workspace; members include pending invitations, and an implementation is active while it has unfinished tasks or required customer information not yet submitted. Growth and Custom also include task prerequisites, blocker tracking with next actions, and template revision history and restore. All workspace members lose access when that workspace's subscription expires.

Migration `004_workspace_plans.sql` preserves existing subscriptions as Custom with no capacity caps, so current access and features are not reduced. Review existing workspaces in the owner console and change each to its agreed plan and limits. The `npm run provision:workspace` operator command also asks for a plan and, for Custom, its limits.

Demo and contact forms submit to Relay's `/api/inquiries` endpoint and require the deployed Worker and its configured Hyperdrive database. Submissions are stored in PostgreSQL with separate name, company, work email, phone, inquiry type, message, and timestamp fields. Opening an HTML page directly as a `file://` URL will not submit inquiries; use the deployed HTTPS website or run Relay with its database configured.

To receive each submitted contact or demo inquiry by email, configure `INQUIRY_NOTIFICATION_EMAIL`, `RESEND_API_KEY`, and `AUTH_EMAIL_FROM` in the deployment environment. Verify the sender address/domain with Resend. For local Node development, copy `.env.example` to `.env`, replace the example values with your real settings, and run `npm start`; the server loads `.env` automatically. Do not commit `.env` or paste credentials into source code. The inquiry is saved even if the notification provider is temporarily unavailable; check the `inquiry_email_notification_failed` server event if an email does not arrive.

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
