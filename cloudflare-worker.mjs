import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import initialMigration from "./migrations/001_initial.sql";
import subscriptionMigration from "./migrations/002_manual_subscriptions.sql";
import removeHelpConsentsMigration from "./migrations/003_remove_help_consents.sql";
import workspacePlansMigration from "./migrations/004_workspace_plans.sql";
import inquiryContactFieldsMigration from "./migrations/005_inquiry_contact_fields.sql";
import customerPortalMigration from "./migrations/006_customer_portal_notifications_integrations.sql";

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
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "NOTIFICATIONS_CRON_SECRET"
  ]) {
    if (env[key]) process.env[key] = env[key];
  }
  globalThis.__RELAY_MIGRATIONS__ ??= {
    "001_initial.sql": initialMigration,
    "002_manual_subscriptions.sql": subscriptionMigration,
    "003_remove_help_consents.sql": removeHelpConsentsMigration,
    "004_workspace_plans.sql": workspacePlansMigration,
    "005_inquiry_contact_fields.sql": inquiryContactFieldsMigration,
    "006_customer_portal_notifications_integrations.sql": customerPortalMigration
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
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const { serverHandler, database } = await getBackendHandler(env);
      const response = await database.database.withRequestClient(() => serverHandler.fetch(
        new Request("https://relayautomation.tech/api/product/internal/process-events", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.NOTIFICATIONS_CRON_SECRET || ""}` }
        }),
        env,
        ctx
      ));
      if (!response.ok) {
        console.error(JSON.stringify({ event: "scheduled_event_processing_failed", status: response.status }));
      }
    })());
  }
};
