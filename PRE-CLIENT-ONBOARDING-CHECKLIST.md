# Relay pre-client onboarding checklist

This checklist separates repository work from tasks that require your provider accounts, confidential values, or client-specific decisions. Do not send passwords, database URLs, API keys, or tokens in chat.

## Current status

- **Repository fixes for the reported issues are complete** and the focused local tests pass.
- **The production backend is responding.** On 2026-11-04, live `/healthz` returned HTTP 200 with `{"status":"ok","database":"ok"}`; signed-out `/api/product/me` and `/inquiries` returned the expected HTTP 401 responses.
- **The Worker runtime issues are fixed and deployed.** The Cloudflare HTTP server adapter is invoked through its `.fetch()` handler, and Worker database connections are request-scoped so Hyperdrive can safely manage pooling.
- **The production Worker and direct Supabase Hyperdrive configuration are deployed.** The required secret names are configured; their values remain private in Cloudflare.
- **Database-backed integration tests have not run.** They require a disposable PostgreSQL database named exactly `relay_test`; never point tests at production. No local PostgreSQL service or running Docker engine was available during this review.
- **Ray is built in.** It uses curated Relay answers, not Workers AI or OpenAI. No AI binding, model, key, or AI quota setup is needed. It is not generative and uses a fallback when a question has no matching answer.
- **Client acceptance is still pending.** The backend health and authentication gates pass, but client-specific sign-in, customer-link submission, and selected-workflow checks with staging data have not been completed.

## Work you need to do

These steps require access to your provider accounts, confidential values, or client-specific decisions. Keep all secrets private.

### A. Set up Supabase and Cloudflare

- [ ] Create a Supabase project. Save its database password in a password manager.
- [ ] Check Supabase's current plan limits, pause/inactivity policy, backup/retention options, and suitability for a pilot.
- [x] Configure the Supabase direct PostgreSQL connection through Cloudflare Hyperdrive. The deployed health endpoint confirms database connectivity. Never send or commit the connection string.
- [x] Put the Hyperdrive configuration ID in `wrangler.jsonc`.
- [x] Confirm Wrangler is authenticated to the Cloudflare account and the `relayautomation.tech/*` route is deployed to the `relay` Worker.
- [x] Set separate `OWNER_ADMIN_TOKEN` and `INQUIRIES_API_TOKEN` Worker secrets. Do not share their values.

- [x] Configure non-secret Worker variables, including `PUBLIC_BASE_URL=https://relayautomation.tech`, and confirm trusted proxy settings.
- [ ] Confirm Cloudflare Free's CPU limit can support signup/sign-in with Relay's scrypt password hashing. If it cannot, use a plan with sufficient CPU or choose another host; do not weaken password hashing.
- [ ] If you want password-recovery emails, configure an email provider, `RESEND_API_KEY`, and a verified `AUTH_EMAIL_FROM`. Do not promise email recovery unless it is configured and tested.
- [x] Do not configure Workers AI or OpenAI for Ray. An empty local `.env` is expected for Cloudflare; the Worker gets its database connection from Hyperdrive and secrets from Cloudflare.
- [ ] Keep all connection strings, secret values, and Cloudflare login tokens private. Do not send them in chat or commit them.

### B. Confirm pilot decisions

- [ ] Confirm the Free-tier pause, quota, backup, and availability limits are acceptable for this pilot. Do not promise guaranteed uptime or zero bugs.
- [ ] Decide which features the first client will use so the live acceptance test covers their actual workflow.
- [ ] Decide whether password recovery and inquiry intake are part of the promised client experience.

### C. Deploy and verify with your account

- [x] Deploy from the repository folder after confirming the Worker, domain, Hyperdrive ID, and required secrets:

  ```powershell
  npm ci
  npm run deploy:cloudflare
  ```

- [x] Confirm `https://relayautomation.tech/healthz` returns HTTP 200 and reports a healthy database.
- [x] Confirm signed-out `https://relayautomation.tech/api/product/me` returns HTTP 401—not 404 or 503.
- [x] Confirm the `/inquiries` endpoint rejects unauthenticated requests with HTTP 401.
- [x] Confirm both the product page and API are served by the intended Worker.
- [ ] Create a temporary staging workspace/account. Test sign-in, sign-out, session persistence, and expired-subscription behavior.
- [ ] If email recovery is configured, test password reset using a test mailbox.
- [ ] Test customer onboarding against the deployed backend: create information requests, generate a link, open it signed out, submit valid and invalid responses, and confirm answers appear on the correct implementation.
- [ ] Test the customer portal with staging data: verify only explicitly customer-visible tasks are shown, milestones/progress are correct, and customers cannot complete hidden or prerequisite-blocked work.
- [ ] If email notifications are in scope, configure Resend and the scheduled event processor, enable workspace notifications, and verify event emails, due-date reminders, retries, and overdue reminders.
- [ ] If HubSpot or Slack is in scope, connect the staging workspace through OAuth and verify implementation progress sync and channel notifications before connecting a customer workspace.
- [ ] Check portfolio workload and health counts against staging tasks, and confirm CSV export opens with customer text treated as data rather than spreadsheet formulas.
- [ ] Test the client's selected features end-to-end using fictional/test data until ready for client data.
- [ ] If inquiry intake is in scope, submit a synthetic inquiry and confirm expected storage/notification behavior.
- [ ] Review Cloudflare logs for database/startup errors, CPU-limit errors, and failed requests. A Wrangler dry run proves bundling only; it does not prove runtime health.
- [ ] Make and test a database backup/restore plan before storing client data.
- [ ] Run the database-backed tests with a safe disposable PostgreSQL database named exactly `relay_test`; never use production for tests.
- [x] Confirm Hyperdrive points to the intended Supabase project and the database is reachable. Do not send the connection string or password in chat.
- [x] Confirm signed-out `/api/product/me` and `/inquiries` return HTTP 401 without authentication.

### D. Create and hand over the client workspace

- [ ] Proceed only after live acceptance checks pass and any blocker for the client's workflow is resolved or accepted.
- [ ] Confirm payment and client account details, then use the owner console to create the workspace.
- [ ] Test client sign-in with permission before handover.
- [ ] Send the initial password through a secure channel, never an ordinary public message.
- [ ] Show the client the workflows they will use, customer information submission, and how to get support.
- [ ] Explain the Free-tier storage, inactivity/pause, request, CPU, and availability limitations.

## Repository work completed

The reported code issues have been addressed:

- [x] **320px mobile overflow:** removed the forced body minimum width. Browser checks at 320, 375, 768, 1024, and 1440 CSS pixels found no horizontal overflow.
- [x] **Stale success toast:** failed task saves now clear earlier success feedback. Browser verification confirmed the toast disappears and the task form displays its error.
- [x] **Completion with missing required information:** implementations with all tasks done but required information missing are shown as **Needs information**, not **Complete**.
- [x] **Local demo customer link:** the localhost-only demo adapter supports customer link opening, required-field and email validation, submission persistence across tabs, and token rotation/revocation.
- [x] **Demo account-deletion copy:** Settings now states that deletion is disabled in the local demo and no live account or data will be changed.
- [x] **Public product/privacy copy:** Terms now describe Ray as a prepared-answer Relay guide, and the Privacy page no longer promises an unverified 30-day backup-expiry period.
- [x] **Cloudflare route and deployment guard:** the production route is declared, the Hyperdrive ID is validated, and the Worker deployment completed.
- [x] **Cloudflare Worker runtime:** fixed the server-handler invocation and changed Worker database use to request-scoped clients; live health is HTTP 200 with database `ok`.
- [x] **Test runner behavior without PostgreSQL:** the default full suite runs database-independent tests and clearly skips the three database integration checks instead of reporting setup failures. Those checks still require the disposable database; GitHub Actions provides a PostgreSQL service.
- [x] Checks passed: `npm test` (11 passed, 3 database checks skipped because no safe test database is configured), JavaScript syntax checks, `git diff --check`, deployment preflight, and Wrangler dry run.
- [x] Local browser verification confirmed the demo customer link opens, submitted information persists after reload, and the 320–1440px viewport checks do not overflow.

The backend health and unauthenticated API checks pass in production. Do not onboard a real client until the remaining staging and provider-plan checks below are completed.

## Final onboarding gate

Do not onboard a real client until all of these are true:

- [ ] Provider setup is complete and the intended Worker/domain are confirmed.
- [x] The deployed health endpoint and signed-out authentication endpoint return the expected results.
- [ ] The deployed customer link and submission flow pass with staging data.
- [ ] The customer portal exposes only approved tasks and customer task completion works end-to-end.
- [ ] Enabled email notifications and scheduled reminders work, or are clearly excluded from the client offer.
- [ ] Any promised HubSpot/Slack connection has passed staging OAuth and event-sync checks.
- [ ] Portfolio workload, risk indicators, estimated finish dates, and CSV export have been reviewed with staging data.
- [ ] Client sign-in and the specific workflows they will use pass in staging.
- [ ] Free-tier/runtime limitations, email-recovery availability, and backup expectations are understood and communicated.

## References

- Deployment instructions: [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- Worker configuration: [`wrangler.jsonc`](./wrangler.jsonc)
- Local-only fictional dashboard demo: `http://127.0.0.1:8899/product.html?demo=workspace` (if its preview server is running)
- Ray preview: `http://127.0.0.1:8898/product.html?demo=ray` (if its preview server is running)
