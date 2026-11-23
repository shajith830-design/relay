import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import initialMigration from "./migrations/001_initial.sql";
import subscriptionMigration from "./migrations/002_manual_subscriptions.sql";
import removeHelpConsentsMigration from "./migrations/003_remove_help_consents.sql";
import workspacePlansMigration from "./migrations/004_workspace_plans.sql";
import inquiryContactFieldsMigration from "./migrations/005_inquiry_contact_fields.sql";
import customerPortalMigration from "./migrations/006_customer_portal_notifications_integrations.sql";
import customerEscalationMigration from "./migrations/007_customer_contact_escalation.sql";
import clientOnboardingMigration from "./migrations/008_client_onboarding_collaboration.sql";
import launchReadinessMigration from "./migrations/009_launch_readiness.sql";
import onboardingGapMigration from "./migrations/010_onboarding_gap_resolution.sql";
import competitiveCapabilitiesMigration from "./migrations/011_relay_competitive_capabilities.sql";
import implementationArchiveMigration from "./migrations/012_implementation_archive.sql";
import phaseOneMigration from "./migrations/013_phase1_critical_path_change_orders_delegation.sql";
import phaseTwoMigration from "./migrations/014_phase2_financial_protection.sql";
import enterpriseRolesMigration from "./migrations/015_enterprise_roles.sql";
import phaseThreeCsvValidationMigration from "./migrations/016_phase3_csv_validation.sql";
import enterpriseOperationsMigration from "./migrations/017_enterprise_operations.sql";
import enterpriseIntegrationsMigration from "./migrations/018_enterprise_integrations.sql";

const backendPaths = [
  "/api",
  "/health",
  "/healthz",
  "/inquiries",
  "/admin"
];
let handlerPromise;

function isBackendPath(pathname) {
  return backendPaths.some((path) =>
    pathname === path || pathname.startsWith(`${path}/`) || (path === "/api" && pathname.startsWith("/api?"))
  );
}

async function getBackendHandler(env) {
  if (!env.HYPERDRIVE?.connectionString) {
    throw new Error("The HYPERDRIVE binding is not configured.");
  }

  process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
  process.env.RELAY_CLOUDFLARE_WORKER = "1";
  for (const key of [
    "PUBLIC_BASE_URL",
    "RESEND_API_KEY",
    "AUTH_EMAIL_FROM",
    "INQUIRY_NOTIFICATION_EMAIL",
    "INTEGRATION_ENCRYPTION_KEY",
    "HUBSPOT_CLIENT_ID",
    "HUBSPOT_CLIENT_SECRET",
    "SALESFORCE_CLIENT_ID",
    "SALESFORCE_CLIENT_SECRET",
    "SALESFORCE_LOGIN_URL",
    "NOTIFICATIONS_CRON_SECRET",
    "MALWARE_SCANNER_URL",
    "MALWARE_SCANNER_TOKEN",
    "JUSTONECX_SECRET_KEY"
  ]) {
    if (env[key]) process.env[key] = env[key];
  }
  globalThis.__RELAY_MIGRATIONS__ ??= {
    "001_initial.sql": initialMigration,
    "002_manual_subscriptions.sql": subscriptionMigration,
    "003_remove_help_consents.sql": removeHelpConsentsMigration,
    "004_workspace_plans.sql": workspacePlansMigration,
    "005_inquiry_contact_fields.sql": inquiryContactFieldsMigration,
    "006_customer_portal_notifications_integrations.sql": customerPortalMigration,
    "007_customer_contact_escalation.sql": customerEscalationMigration,
    "008_client_onboarding_collaboration.sql": clientOnboardingMigration,
    "009_launch_readiness.sql": launchReadinessMigration,
    "010_onboarding_gap_resolution.sql": onboardingGapMigration,
    "011_relay_competitive_capabilities.sql": competitiveCapabilitiesMigration,
    "012_implementation_archive.sql": implementationArchiveMigration,
    "013_phase1_critical_path_change_orders_delegation.sql": phaseOneMigration,
    "014_phase2_financial_protection.sql": phaseTwoMigration,
    "015_enterprise_roles.sql": enterpriseRolesMigration,
    "016_phase3_csv_validation.sql": phaseThreeCsvValidationMigration,
    "017_enterprise_operations.sql": enterpriseOperationsMigration,
    "018_enterprise_integrations.sql": enterpriseIntegrationsMigration
  };

  handlerPromise ??= (async () => {
    const [{ default: database }, { default: app }] = await Promise.all([
      import("./db.js"),
      import("./server.js")
    ]);
    await database.ready;
    return {
      serverHandler: httpServerHandler(createServer(app)),
      database
    };
  })().catch((error) => {
    handlerPromise = undefined;
    throw error;
  });

  return handlerPromise;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (!isBackendPath(pathname)) {
      return env.ASSETS.fetch(request);
    }

    try {
      const { serverHandler, database } = await getBackendHandler(env);
      const headers = new Headers(request.headers);
      const clientIp = request.headers.get("CF-Connecting-IP");
      if (clientIp) headers.set("X-Forwarded-For", clientIp);
      return await database.database.withRequestClient(
        () => serverHandler.fetch(new Request(request, { headers }), env, ctx)
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "cloudflare_backend_unavailable",
        message: error.message
      }));
      return Response.json(
        { error: "Relay backend is temporarily unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const job = event.cron === "0 0 * * *" ? "shift_go_live" : "process_events";
      const path = job === "shift_go_live"
        ? "/api/product/internal/shift-go-live"
        : "/api/product/internal/process-events";
      try {
        const { serverHandler, database } = await getBackendHandler(env);
        const response = await database.database.withRequestClient(() => serverHandler.fetch(
          new Request(`https://relayautomation.tech${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.NOTIFICATIONS_CRON_SECRET || ""}` }
          }),
          env,
          ctx
        ));
        if (!response.ok) {
          console.error(JSON.stringify({
            event: "scheduled_job_failed",
            job,
            status: response.status
          }));
          return;
        }
        const result = await response.json().catch(() => ({}));
        const metrics = job === "shift_go_live"
          ? {
            shiftedImplementations: Number(result.shiftedImplementations) || 0,
            shiftedTasks: Number(result.shiftedTasks) || 0
          }
          : {
            processed: Number(result.processed) || 0,
            failures: Number(result.failures) || 0,
            remindersQueued: Number(result.remindersQueued) || 0,
            hubspotImportFailures: Number(result.hubspotImportFailures) || 0,
            salesforceImportsCreated: Number(result.salesforceImportsCreated) || 0,
            salesforceImportFailures: Number(result.salesforceImportFailures) || 0,
            engineeringIssuesCompleted: Number(result.engineeringIssuesCompleted) || 0,
            engineeringIssueFailures: Number(result.engineeringIssueFailures) || 0
          };
        console.info(JSON.stringify({
          event: "scheduled_job_completed",
          job,
          status: response.status,
          ...metrics
        }));
      } catch (error) {
        console.error(JSON.stringify({
          event: "scheduled_job_execution_failed",
          job,
          errorName: error?.name || "Error"
        }));
        throw new Error("Scheduled job execution failed.");
      }
    })());
  }
};
