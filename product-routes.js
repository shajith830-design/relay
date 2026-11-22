"use strict";

const {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv
} = require("node:crypto");
const { makePasswordHash, checkPassword } = require("./product-auth");
const { getPlanDetails } = require("./product-plans");
const { relayHelpReply } = require("./public/relay-help");
const { createJustOneCXIdentity } = require("./justonecx-identity");

const SESSION_COOKIE = "relay_session";
const SESSION_DAYS = 14;
const CUSTOMER_LINK_DAYS = 30;
const CUSTOMER_FILE_LIMIT = 5 * 1024 * 1024;
const CUSTOMER_FILE_COUNT_LIMIT = 20;
const CUSTOMER_FILE_TOTAL_LIMIT = 25 * 1024 * 1024;
const rateLimitBuckets = new Map();

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function integrationKey() {
  const value = process.env.INTEGRATION_ENCRYPTION_KEY?.trim() || "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

function encryptIntegrationValue(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", integrationKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptIntegrationValue(value) {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", integrationKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function validId(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requiredText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : "";
}

function cookieToken(req) {
  const cookieHeader = req.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)relay_session=([A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}

function setSessionCookie(res, token, isProduction) {
  const secure = isProduction ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function clearSessionCookie(res, isProduction) {
  const secure = isProduction ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function sameOrigin(req, res, next) {
  const origin = req.get("Origin");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: "Request origin could not be verified." });
  }
  if (originHost !== req.get("host")) {
    return res.status(403).json({ error: "Request origin could not be verified." });
  }
  return next();
}

function rateLimit(key, limit, windowMs, message) {
  const now = Date.now();
  for (const [bucketKey, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart >= bucket.windowMs) rateLimitBuckets.delete(bucketKey);
  }
  const bucket = rateLimitBuckets.get(key) || { count: 0, windowStart: now, windowMs };
  if (bucket.count >= limit) {
    return { limited: true, message };
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return { limited: false };
}

function limitRequests(key, limit, windowMs, message) {
  return (req, res, next) => {
    const result = rateLimit(`${key}:${req.ip || "unknown"}`, limit, windowMs, message);
    if (result.limited) return res.status(429).json({ error: result.message });
    return next();
  };
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

const INPUT_TYPES = new Set(["text", "email", "url", "number", "date"]);

function inputValueError(type, value) {
  if (!value) return "";
  if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Enter a valid email address.";
  if (type === "url") {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) {
        return "Enter a complete website URL beginning with https://.";
      }
    } catch {
      return "Enter a complete website URL beginning with https://.";
    }
  }
  if (type === "number" && !Number.isFinite(Number(value))) return "Enter a valid number.";
  if (type === "date" && !validDate(value)) {
    return "Enter a valid date.";
  }
  return "";
}

function customerFileType(contentType, filename, content) {
  const extension = filename.toLowerCase().split(".").pop();
  const allowed = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg"
  };
  if (!Buffer.isBuffer(content) || content.length < 1 || content.length > CUSTOMER_FILE_LIMIT
    || allowed[extension] !== contentType) return "";
  if (contentType === "application/pdf" && content.subarray(0, 5).toString("ascii") !== "%PDF-") return "";
  if (contentType === "image/png"
    && !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "";
  if (contentType === "image/jpeg"
    && !(content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)) return "";
  return contentType;
}

function safeCustomerFilename(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\/\\\u0000-\u001f\u007f]/g, "_").trim().slice(0, 150);
}

async function sendProductEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!apiKey || !from) return { sent: false, error: "Customer email is not configured. Copy the secure link and share it directly." };
  const emailUrl = process.env.NODE_ENV === "test" && process.env.AUTH_EMAIL_API_URL
    ? process.env.AUTH_EMAIL_API_URL
    : "https://api.resend.com/emails";
  const response = await fetch(emailUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
  return { sent: true };
}

async function hubspotAccessToken(integration, workspaceId, database) {
  let accessToken = decryptIntegrationValue(integration.access_token_cipher);
  if (!integration.token_expires_at || Date.parse(integration.token_expires_at) > Date.now() + 30_000) {
    return accessToken;
  }
  if (!integration.refresh_token_cipher) throw new Error("HubSpot authorization expired. Reconnect HubSpot.");
  const refreshResponse = await fetch("https://api.hubapi.com/oauth/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.HUBSPOT_CLIENT_ID || "",
      client_secret: process.env.HUBSPOT_CLIENT_SECRET || "",
      refresh_token: decryptIntegrationValue(integration.refresh_token_cipher)
    }),
    signal: AbortSignal.timeout(10000)
  });
  const refreshed = await refreshResponse.json().catch(() => ({}));
  if (!refreshResponse.ok || !refreshed.access_token || !Number.isFinite(refreshed.expires_in)) {
    throw new Error("HubSpot authorization could not be refreshed.");
  }
  accessToken = refreshed.access_token;
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const encryptedToken = encryptIntegrationValue(accessToken);
  await database.prepare(`
    UPDATE product_workspace_integrations SET access_token_cipher = $1,
      token_expires_at = $2, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = $3 AND provider = 'hubspot'
  `).run(encryptedToken, expiresAt, workspaceId);
  integration.token_expires_at = expiresAt;
  integration.access_token_cipher = encryptedToken;
  return accessToken;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function hasCycle(steps) {
  const graph = new Map(steps.map((step) => [step.id, step.dependsOn || []]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return [...graph.keys()].some(visit);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function installProductRoutes(app, db, isProduction) {
  const database = db.database;

  async function enqueueWorkspaceEvent(workspaceId, implementationId, eventType, payload = {}) {
    const eventKey = `${eventType}:${implementationId}:${randomUUID()}`;
    await database.prepare(`
      INSERT INTO product_workspace_events
        (event_key, workspace_id, implementation_id, event_type, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `).run(eventKey, workspaceId, implementationId, eventType, JSON.stringify(payload));
  }

  async function resolveCustomerAccess(token) {
    const hashedToken = hashToken(token);
    const contact = await database.prepare(`
      SELECT c.id AS contact_id, c.email AS contact_email, c.display_name AS contact_name,
        c.implementation_id, c.expires_at, i.id, i.workspace_id, i.template_id,
        i.customer_name, i.target_launch_date, i.customer_owner_name, i.customer_owner_email,
        i.success_criteria, i.acceptance_status, i.test_plan, i.training_status,
        i.support_owner_name, i.support_owner_email, i.rollback_plan, i.go_live_status
        , i.communication_channel, i.communication_cadence, i.communication_owner_name,
        i.communication_owner_email, i.procurement_status, i.security_status, i.security_notes,
        i.integration_inventory, i.integration_status, i.technical_setup_status,
        i.technical_setup_notes, i.change_management_status, i.adoption_notes,
        i.early_validation_status, i.early_validation_notes, i.post_launch_support_plan,
        i.duplicate_request_control
      FROM product_customer_contacts c
      JOIN product_implementations i ON i.id = c.implementation_id
      JOIN product_workspace_subscriptions s ON s.workspace_id = i.workspace_id
      WHERE c.token_hash = $1 AND c.revoked_at IS NULL
        AND c.expires_at > CURRENT_TIMESTAMP AND s.expires_at > CURRENT_TIMESTAMP
    `).get(hashedToken);
    if (contact) return { implementation: contact, contact };

    const implementation = await database.prepare(`
      SELECT i.id AS implementation_id, i.workspace_id, i.template_id, i.customer_name,
        i.target_launch_date, i.customer_owner_name, i.customer_owner_email,
        i.success_criteria, i.acceptance_status, i.test_plan, i.training_status,
        i.support_owner_name, i.support_owner_email, i.rollback_plan, i.go_live_status
        , i.communication_channel, i.communication_cadence, i.communication_owner_name,
        i.communication_owner_email, i.procurement_status, i.security_status, i.security_notes,
        i.integration_inventory, i.integration_status, i.technical_setup_status,
        i.technical_setup_notes, i.change_management_status, i.adoption_notes,
        i.early_validation_status, i.early_validation_notes, i.post_launch_support_plan,
        i.duplicate_request_control
      FROM product_implementations i
      JOIN product_workspace_subscriptions s ON s.workspace_id = i.workspace_id
      WHERE i.portal_token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP
    `).get(hashedToken);
    return implementation ? { implementation, contact: null } : null;
  }

  async function sendCustomerContactInvitation({ req, implementation, contactEmail, contactName, token }) {
    const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || `${req.protocol}://${req.get("host")}`;
    let customerUrl;
    try {
      customerUrl = new URL("/customer.html", baseUrl);
      if (!["http:", "https:"].includes(customerUrl.protocol) || customerUrl.username || customerUrl.password) {
        throw new Error("The customer portal URL is invalid.");
      }
    } catch {
      throw new Error("The customer portal URL is not configured correctly.");
    }
    customerUrl.searchParams.set("token", token);
    const link = customerUrl.href;
    const greeting = contactName ? `Hello ${contactName},` : "Hello,";
    const launchDate = implementation.target_launch_date
      ? `The current target launch date is ${implementation.target_launch_date}.`
      : "Your implementation team will share the launch plan in the portal.";
    try {
      const emailResult = await sendProductEmail({
        to: contactEmail,
        subject: `Your ${implementation.customer_name} onboarding with Relay`,
        text: `${greeting}\n\nYour team has invited you to the ${implementation.customer_name} onboarding portal. Use this private link to share requested information, upload files, see progress, and ask questions:\n\n${link}\n\n${launchDate}\n\nThis link is personal and expires in ${CUSTOMER_LINK_DAYS} days. If you did not expect this invitation, contact your implementation team.`
      });
      return { ...emailResult, link: emailResult.sent ? "" : link };
    } catch (error) {
      return { sent: false, error: `Invitation email could not be sent: ${error.message}`, link };
    }
  }

  async function loadHubSpotPipelines(workspaceId) {
    const integration = await database.prepare(`
      SELECT access_token_cipher, refresh_token_cipher, token_expires_at,
        hubspot_onboarding_pipeline_id, hubspot_onboarding_stage_id, hubspot_onboarding_template_id
      FROM product_workspace_integrations
      WHERE workspace_id = $1 AND provider = 'hubspot'
    `).get(workspaceId);
    if (!integration) throw new Error("Connect HubSpot before configuring onboarding handoff.");
    const accessToken = await hubspotAccessToken(integration, workspaceId, database);
    const response = await fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(result.results)) {
      throw new Error(`HubSpot pipeline list could not be loaded (HTTP ${response.status}).`);
    }
    return {
      integration,
      pipelines: result.results.map((pipeline) => ({
        id: String(pipeline.id),
        label: String(pipeline.label || pipeline.id),
        stages: (pipeline.stages || []).map((stage) => ({
          id: String(stage.id),
          label: String(stage.label || stage.id),
          isClosedWon: Number(stage.metadata?.probability) === 1
        }))
      }))
    };
  }

  async function pollHubSpotOnboarding(integration, req) {
    const workspaceId = integration.workspace_id;
    const accessToken = await hubspotAccessToken(integration, workspaceId, database);
    const previousSync = Date.parse(integration.hubspot_onboarding_last_synced_at) || Date.now();
    const modifiedSince = Math.max(0, previousSync - 10 * 60 * 1000);
    if (process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM) {
      const unsentInvitations = await database.prepare(`
        SELECT h.deal_id, h.invitation_sent_at, i.id, i.customer_name, i.target_launch_date,
          i.customer_owner_name, i.customer_owner_email
        FROM product_hubspot_imports h
        JOIN product_implementations i ON i.id = h.implementation_id
        WHERE h.workspace_id = $1 AND h.invitation_sent_at IS NULL
          AND BTRIM(i.customer_owner_email) != ''
      `).all(workspaceId);
      for (const imported of unsentInvitations) {
        const contact = await database.prepare(`
          SELECT id, invitation_sent_at FROM product_customer_contacts
          WHERE implementation_id = $1 AND email = $2
        `).get(imported.id, imported.customer_owner_email);
        if (contact?.invitation_sent_at) {
          await database.prepare(`
            UPDATE product_hubspot_imports SET invitation_sent_at = $1
            WHERE workspace_id = $2 AND deal_id = $3
          `).run(contact.invitation_sent_at, workspaceId, imported.deal_id);
          continue;
        }
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
        await database.prepare(`
          INSERT INTO product_customer_contacts
            (implementation_id, email, display_name, token_hash, expires_at, revoked_at)
          VALUES ($1, $2, $3, $4, $5, NULL)
          ON CONFLICT (implementation_id, email) DO UPDATE SET
            display_name = excluded.display_name, token_hash = excluded.token_hash,
            expires_at = excluded.expires_at, invitation_sent_at = NULL,
            revoked_at = NULL, last_activity_at = CURRENT_TIMESTAMP
        `).run(imported.id, imported.customer_owner_email, imported.customer_owner_name, hashToken(token), expiresAt);
        const invitation = await sendCustomerContactInvitation({
          req,
          implementation: imported,
          contactEmail: imported.customer_owner_email,
          contactName: imported.customer_owner_name,
          token
        });
        if (invitation.sent) {
          await database.prepare(`
            UPDATE product_customer_contacts SET invitation_sent_at = CURRENT_TIMESTAMP
            WHERE implementation_id = $1 AND email = $2
          `).run(imported.id, imported.customer_owner_email);
          await database.prepare(`
            UPDATE product_hubspot_imports SET invitation_sent_at = CURRENT_TIMESTAMP
            WHERE workspace_id = $1 AND deal_id = $2
          `).run(workspaceId, imported.deal_id);
        } else {
          throw new Error(invitation.error || "A customer invitation could not be sent.");
        }
      }
    }
    let after;
    let pages = 0;
    let created = 0;
    do {
      if (++pages > 10) {
        throw new Error("The HubSpot handoff found more than 1,000 recently changed matching deals. Choose a narrower pipeline or contact support before retrying.");
      }
      const body = {
        filterGroups: [{
          filters: [
            { propertyName: "pipeline", operator: "EQ", value: integration.hubspot_onboarding_pipeline_id },
            { propertyName: "dealstage", operator: "EQ", value: integration.hubspot_onboarding_stage_id },
            { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(modifiedSince) }
          ]
        }],
        properties: ["dealname", "pipeline", "dealstage", "hs_lastmodifieddate"],
        sorts: ["hs_lastmodifieddate"],
        limit: 100,
        ...(after ? { after } : {})
      };
      const response = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(result.results)) {
        throw new Error(`HubSpot Closed Won search failed (HTTP ${response.status}).`);
      }
      for (const deal of result.results) {
        if (!deal.id || deal.properties?.pipeline !== integration.hubspot_onboarding_pipeline_id
          || deal.properties?.dealstage !== integration.hubspot_onboarding_stage_id) continue;
        const alreadyImported = await database.prepare(`
          SELECT implementation_id, invitation_sent_at
          FROM product_hubspot_imports WHERE workspace_id = $1 AND deal_id = $2
        `).get(workspaceId, String(deal.id));
        if (alreadyImported) continue;
        let contact = null;
        const associationResponse = await fetch(
          `https://api.hubapi.com/crm/v4/objects/deals/${encodeURIComponent(deal.id)}/associations/contacts?limit=1`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) }
        );
        if (associationResponse.ok) {
          const associations = await associationResponse.json().catch(() => ({}));
          const contactId = associations.results?.[0]?.toObjectId;
          if (contactId) {
            const contactResponse = await fetch(
              `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=email,firstname,lastname,company`,
              { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) }
            );
            const contactResult = await contactResponse.json().catch(() => ({}));
            if (!contactResponse.ok) {
              throw new Error(`HubSpot customer details could not be loaded (HTTP ${contactResponse.status}).`);
            }
            contact = contactResult.properties || null;
          }
        } else if (associationResponse.status !== 404) {
          throw new Error(`HubSpot customer contact lookup failed (HTTP ${associationResponse.status}).`);
        }
        const customerName = requiredText(contact?.company, 120)
          || requiredText(deal.properties?.dealname, 120)
          || `HubSpot deal ${deal.id}`;
        const contactName = [contact?.firstname, contact?.lastname].filter(Boolean).join(" ").slice(0, 120);
        const contactEmail = typeof contact?.email === "string" ? contact.email.trim().toLowerCase() : "";
        if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
          throw new Error(`HubSpot contact for deal ${deal.id} has an invalid email address.`);
        }
        const template = await database.prepare(`
          SELECT id, name, steps_json FROM product_templates
          WHERE id = $1 AND workspace_id = $2
        `).get(integration.hubspot_onboarding_template_id, workspaceId);
        if (!template) throw new Error("The configured HubSpot onboarding template is no longer available.");
        const creation = await createImplementationFromTemplate({
          workspaceId,
          template,
          customerName,
          customerOwnerName: contactName,
          customerOwnerEmail: contactEmail,
          sourceDealId: String(deal.id),
          sourcePipelineId: String(deal.properties.pipeline)
        });
        if (!creation.implementation) throw new Error(creation.error || "The implementation could not be created.");
        const implementation = creation.implementation;
        if (creation.duplicate) continue;
        created += 1;
        if (!contactEmail || !process.env.RESEND_API_KEY || !process.env.AUTH_EMAIL_FROM) continue;
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
        await database.prepare(`
          INSERT INTO product_customer_contacts
            (implementation_id, email, display_name, token_hash, expires_at, revoked_at)
          VALUES ($1, $2, $3, $4, $5, NULL)
          ON CONFLICT (implementation_id, email) DO UPDATE SET
            display_name = excluded.display_name, token_hash = excluded.token_hash,
            expires_at = excluded.expires_at, invitation_sent_at = NULL,
            revoked_at = NULL, last_activity_at = CURRENT_TIMESTAMP
        `).run(implementation.id, contactEmail, contactName, hashToken(token), expiresAt);
        const invitation = await sendCustomerContactInvitation({
          req, implementation, contactEmail, contactName, token
        });
        if (invitation.sent) {
          await database.prepare(`
            UPDATE product_customer_contacts SET invitation_sent_at = CURRENT_TIMESTAMP
            WHERE implementation_id = $1 AND email = $2
          `).run(implementation.id, contactEmail);
          await database.prepare(`
            UPDATE product_hubspot_imports SET invitation_sent_at = CURRENT_TIMESTAMP
            WHERE workspace_id = $1 AND deal_id = $2
          `).run(workspaceId, String(deal.id));
        } else {
          throw new Error(invitation.error || "A customer invitation could not be sent.");
        }
      }
      after = result.paging?.next?.after;
    } while (after);
    await database.prepare(`
      UPDATE product_workspace_integrations
      SET hubspot_onboarding_last_synced_at = CURRENT_TIMESTAMP,
        hubspot_onboarding_last_error = '', hubspot_onboarding_last_error_at = NULL
      WHERE workspace_id = $1 AND provider = 'hubspot'
    `).run(workspaceId);
    return created;
  }

  function requirePlanFeature(req, res, feature, featureName) {
    if (req.product.planDetails.features[feature]) return true;
    sendError(res, 403, `${featureName} is included with Growth and Custom plans. Upgrade this workspace to use it.`);
    return false;
  }

  async function lockWorkspace(workspaceId) {
    await database.prepare("SELECT id FROM product_workspaces WHERE id = $1 FOR UPDATE").get(workspaceId);
    const subscription = await database.prepare(`
      SELECT plan, member_limit, active_implementation_limit, template_limit
      FROM product_workspace_subscriptions WHERE workspace_id = $1 FOR UPDATE
    `).get(workspaceId);
    return getPlanDetails(subscription.plan, {
      memberLimit: subscription.member_limit,
      activeImplementationLimit: subscription.active_implementation_limit,
      templateLimit: subscription.template_limit
    });
  }

  async function countActiveImplementations(workspaceId) {
    return (await database.prepare(`
      SELECT COUNT(*) AS count
      FROM product_implementations i
      WHERE i.workspace_id = $1 AND (
        EXISTS (
          SELECT 1 FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done'
        ) OR EXISTS (
          SELECT 1 FROM product_requirements r
          WHERE r.workspace_id = i.workspace_id AND r.required = TRUE
            AND (r.template_id IS NULL OR r.template_id = i.template_id)
            AND NOT EXISTS (
              SELECT 1 FROM product_customer_inputs c
              WHERE c.implementation_id = i.id AND c.requirement_id = r.id AND BTRIM(c.value) != ''
            )
        )
      )
    `).get(workspaceId)).count;
  }

  async function createImplementationFromTemplate({
    workspaceId,
    template,
    customerName,
    customerOwnerName = "",
    customerOwnerEmail = "",
    targetLaunchDate = "",
    sourceDealId = "",
    sourcePipelineId = ""
  }) {
    const steps = JSON.parse(template.steps_json);
    if (!Array.isArray(steps) || steps.length === 0) {
      return { implementation: null, error: "This template has no saved steps." };
    }
    const result = await database.transaction(async () => {
      if (sourceDealId) {
        const existing = await database.prepare(`
          SELECT implementation_id FROM product_hubspot_imports
          WHERE workspace_id = $1 AND deal_id = $2
        `).get(workspaceId, sourceDealId);
        if (existing) {
          return {
            implementation: await database.prepare(`
              SELECT id, customer_name, created_at, target_launch_date,
                customer_owner_name, customer_owner_email
              FROM product_implementations WHERE id = $1
            `).get(existing.implementation_id),
            duplicate: true
          };
        }
      }
      const plan = await lockWorkspace(workspaceId);
      if (steps.some((step) => Array.isArray(step.dependsOnPositions) && step.dependsOnPositions.length)
        && !plan.features.dependencies) {
        return { implementation: null, error: "Task prerequisites are not included in this workspace plan." };
      }
      const activeCount = await countActiveImplementations(workspaceId);
      if (plan.activeImplementationLimit !== null && activeCount >= plan.activeImplementationLimit) {
        return { implementation: null, error: "This workspace has reached its active implementation limit." };
      }
      const implementation = await database.prepare(`
        INSERT INTO product_implementations
          (workspace_id, template_id, customer_name, target_launch_date,
            customer_owner_name, customer_owner_email, hubspot_source_deal_id, hubspot_source_pipeline_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, customer_name, created_at, target_launch_date,
          customer_owner_name, customer_owner_email
      `).get(workspaceId, template.id, customerName, targetLaunchDate,
        customerOwnerName, customerOwnerEmail, sourceDealId, sourcePipelineId);
      const insertStep = database.prepare(`
        INSERT INTO product_implementation_steps
          (implementation_id, title, description, owner, position, due_at, stage, assignee_user_id, customer_visible)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
      `);
      const stepIdsByPosition = new Map();
      for (const step of steps) {
        const dueDate = new Date();
        dueDate.setUTCHours(0, 0, 0, 0);
        dueDate.setUTCDate(dueDate.getUTCDate() + (Number.isInteger(step.dueOffsetDays) ? step.dueOffsetDays : 0));
        const inserted = await insertStep.run(
          implementation.id,
          step.title,
          step.description || "",
          step.owner || "",
          step.position,
          Number.isInteger(step.dueOffsetDays) ? dueDate.toISOString().slice(0, 10) : "",
          step.stage || "Implementation",
          step.assigneeUserId || null,
          step.customerVisible === true
        );
        stepIdsByPosition.set(step.position, inserted.lastInsertRowid);
      }
      const addDependency = database.prepare(`
        INSERT INTO product_implementation_step_dependencies (implementation_step_id, depends_on_step_id)
        VALUES ($1, $2)
      `);
      for (const step of steps) {
        for (const dependencyPosition of step.dependsOnPositions || []) {
          const dependencyId = stepIdsByPosition.get(dependencyPosition);
          const currentStepId = stepIdsByPosition.get(step.position);
          if (!dependencyId || !currentStepId) throw new Error("Template contains an invalid prerequisite reference.");
          await addDependency.run(currentStepId, dependencyId);
        }
      }
      await database.prepare(`
        INSERT INTO product_customer_inputs (implementation_id, requirement_id)
        SELECT $1, id FROM product_requirements
        WHERE workspace_id = $2 AND (template_id IS NULL OR template_id = $3)
      `).run(implementation.id, workspaceId, template.id);
      if (sourceDealId) {
        await database.prepare(`
          INSERT INTO product_hubspot_imports (workspace_id, deal_id, pipeline_id, implementation_id)
          VALUES ($1, $2, $3, $4)
        `).run(workspaceId, sourceDealId, sourcePipelineId, implementation.id);
      }
      await enqueueWorkspaceEvent(workspaceId, implementation.id, "implementation.created");
      return { implementation, duplicate: false };
    });
    if (!result.implementation) return result;
    return {
      ...result,
      implementation: { ...result.implementation, template_name: template.name }
    };
  }

  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const register = app[method].bind(app);
    app[method] = (route, ...handlers) => register(
      route,
      ...handlers.map((handler) => typeof handler === "function" ? asyncRoute(handler) : handler)
    );
  }

  async function processSteps(processId) {
    const steps = await (database.prepare(
      `SELECT s.id, s.title, s.description, s.owner, s.position, s.stage, s.due_offset_days,
        s.assignee_user_id, s.customer_visible, u.email AS assignee_email
       FROM product_process_steps s
       JOIN product_processes p ON p.id = s.process_id
       LEFT JOIN product_users u ON u.id = s.assignee_user_id
       WHERE s.process_id = $1 ORDER BY s.position, s.id`
    ).all(processId));
    const dependencies = await (database.prepare(`
      SELECT d.process_step_id AS "stepId", d.depends_on_step_id AS "dependsOn"
      FROM product_process_step_dependencies d
      JOIN product_process_steps s ON s.id = d.process_step_id
      WHERE s.process_id = $1
    `).all(processId));
    const byStep = new Map(steps.map((step) => [step.id, step]));
    for (const step of steps) step.dependsOn = [];
    for (const dependency of dependencies) byStep.get(dependency.stepId)?.dependsOn.push(dependency.dependsOn);
    return steps;
  }

  async function workspaceAssignee(workspaceId, value) {
    if (value === null || value === undefined || value === "") return { id: null, valid: true };
    const id = validId(value);
    if (!id) return { id: null, valid: false };
    const member = await (database.prepare(
      "SELECT user_id FROM product_memberships WHERE workspace_id = $1 AND user_id = $2"
    ).get(workspaceId, id));
    return { id, valid: Boolean(member) };
  }

  async function implementationRequirements(implementationId, workspaceId, templateId) {
    return await (database.prepare(`
      SELECT r.id, r.name, r.description, r.required, r.input_type,
        COALESCE(c.value, '') AS value
      FROM product_requirements r
      LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = $1
      WHERE r.workspace_id = $2 AND (r.template_id IS NULL OR r.template_id = $3)
      ORDER BY r.id
    `).all(implementationId, workspaceId, templateId));
  }

  app.use("/api/product", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.post("/api/product/auth/signup", sameOrigin,
    limitRequests("signup", 20, 60 * 60 * 1000, "Too many account creation attempts. Try again later."),
    async (req, res) => {
    const email = requiredText(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const inviteToken = typeof req.body.inviteToken === "string" ? req.body.inviteToken : "";
    if (!inviteToken) {
      return sendError(res, 403, "Workspace signup is closed. Contact Relay to request access.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128
      || !/^[A-Za-z0-9_-]{40,60}$/.test(inviteToken)) {
      return sendError(res, 400, "Enter valid account details and a password of at least 12 characters.");
    }
    const invite = await (database.prepare(`
      SELECT i.id, i.workspace_id, i.invited_email
      FROM product_workspace_invites i
      JOIN product_workspace_subscriptions s ON s.workspace_id = i.workspace_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > $2
        AND s.expires_at > CURRENT_TIMESTAMP
    `).get(hashToken(inviteToken), new Date().toISOString()));
    if (!invite || invite.invited_email.toLowerCase() !== email) {
      return sendError(res, 400, "This invitation is invalid, expired, or addressed to a different email.");
    }

    try {
      const passwordHash = await makePasswordHash(password);
      const createdAccount = await database.transaction(async () => {
        const plan = await lockWorkspace(invite.workspace_id);
        const memberCount = (await database.prepare(
          "SELECT COUNT(*) AS count FROM product_memberships WHERE workspace_id = $1"
        ).get(invite.workspace_id)).count;
        if (plan.memberLimit !== null && memberCount >= plan.memberLimit) {
          const error = new Error("This workspace has reached its team-member limit. Ask its owner to upgrade the plan.");
          error.code = "PLAN_SEAT_LIMIT";
          throw error;
        }
        const user = await (database.prepare(
          "INSERT INTO product_users (email, password_hash) VALUES ($1, $2) RETURNING id, email"
        ).get(email, passwordHash));
        const accepted = await (database.prepare(`
          UPDATE product_workspace_invites SET accepted_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND accepted_at IS NULL AND expires_at > $2
            AND EXISTS (
              SELECT 1 FROM product_workspace_subscriptions
              WHERE workspace_id = $3 AND expires_at > CURRENT_TIMESTAMP
            )
        `).run(invite.id, new Date().toISOString(), invite.workspace_id));
        if (!accepted.changes) {
          const error = new Error("This invitation is invalid or has expired.");
          error.code = "INVITE_INVALID";
          throw error;
        }
        await (database.prepare(
          "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')"
        ).run(invite.workspace_id, user.id));
        const workspace = await (database.prepare(`
          SELECT w.id, w.name, s.expires_at AS subscription_expires_at, s.plan,
            s.member_limit, s.active_implementation_limit, s.template_limit
          FROM product_workspaces w
          JOIN product_workspace_subscriptions s ON s.workspace_id = w.id
          WHERE w.id = $1
        `).get(invite.workspace_id));
        return { user, workspace };
      });
      const { user, workspace } = createdAccount;
      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
      await (database.prepare(
        "INSERT INTO product_sessions (token_hash, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, $4)"
      ).run(hashToken(rawToken), user.id, workspace.id, expiresAt));
      setSessionCookie(res, rawToken, isProduction);
      return res.status(201).json({
        user,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          role: "member",
          subscriptionExpiresAt: workspace.subscription_expires_at,
          plan: workspace.plan,
          memberLimit: workspace.member_limit,
          activeImplementationLimit: workspace.active_implementation_limit,
          templateLimit: workspace.template_limit,
          planDetails: getPlanDetails(workspace.plan, {
            memberLimit: workspace.member_limit,
            activeImplementationLimit: workspace.active_implementation_limit,
            templateLimit: workspace.template_limit
          })
        }
      });
    } catch (error) {
      if (error.code === "INVITE_INVALID") {
        return sendError(res, 409, error.message);
      }
      if (error.code === "PLAN_SEAT_LIMIT") return sendError(res, 409, error.message);
      if (error.code === "23505") {
        return sendError(res, 409, "An account with this email already exists. Sign in instead.");
      }
      console.error("Product account creation failed:", error.message);
      return sendError(res, 500, "The account could not be created. Please try again.");
    }
  });

  app.post("/api/product/auth/password-reset/request", sameOrigin,
    limitRequests("password-reset", 5, 60 * 60 * 1000, "Too many requests. Try again later."),
    async (req, res) => {
      const email = requiredText(req.body.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendError(res, 400, "Enter a valid email address.");
      }

      const apiKey = process.env.RESEND_API_KEY?.trim();
      const from = process.env.AUTH_EMAIL_FROM?.trim();
      const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
      const apiUrl = !isProduction && process.env.NODE_ENV === "test"
        ? process.env.AUTH_EMAIL_API_URL?.trim() || "https://api.resend.com/emails"
        : "https://api.resend.com/emails";
      if (!apiKey || !from || !baseUrl) {
        console.error("Password reset email is not configured; set RESEND_API_KEY, AUTH_EMAIL_FROM, and PUBLIC_BASE_URL.");
        return sendError(res, 503, "Password recovery is not available right now. Contact support for help.");
      }
      let parsedBaseUrl;
      try {
        parsedBaseUrl = new URL(baseUrl);
      } catch {
        console.error("Password reset email is not configured: PUBLIC_BASE_URL must be a valid URL.");
        return sendError(res, 503, "Password recovery is not available right now. Contact support for help.");
      }
      if (parsedBaseUrl.protocol !== "https:" && isProduction) {
        console.error("Password reset email is not configured: PUBLIC_BASE_URL must use HTTPS in production.");
        return sendError(res, 503, "Password recovery is not available right now. Contact support for help.");
      }

      try {
        await (database.prepare("DELETE FROM product_password_resets WHERE expires_at <= $1")
          .run(new Date().toISOString()));
        const user = await (database.prepare("SELECT id, email FROM product_users WHERE email = $1").get(email));
        if (user) {
          const rawToken = randomBytes(32).toString("base64url");
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await (database.prepare("DELETE FROM product_password_resets WHERE user_id = $1").run(user.id));
          const tokenHash = hashToken(rawToken);
          await (database.prepare(
            "INSERT INTO product_password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)"
          ).run(tokenHash, user.id, expiresAt));
          const resetUrl = new URL(`/product.html?reset=${encodeURIComponent(rawToken)}`, parsedBaseUrl).toString();
          let response;
          try {
            response = await fetch(apiUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                from,
                to: [user.email],
                subject: "Reset your Relay password",
                text: `Use this one-time link to reset your Relay password. It expires in 30 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`
              }),
              signal: AbortSignal.timeout(10000)
            });
          } catch (error) {
            await (database.prepare("DELETE FROM product_password_resets WHERE token_hash = $1").run(tokenHash));
            throw error;
          }
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            await (database.prepare("DELETE FROM product_password_resets WHERE token_hash = $1").run(tokenHash));
            console.error(JSON.stringify({
              event: "password_reset_email_failed",
              provider_status: response.status
            }));
            return sendError(res, 502, "The recovery email could not be sent. Please try again later.");
          }
          if (result.error) {
            await (database.prepare("DELETE FROM product_password_resets WHERE token_hash = $1").run(tokenHash));
            console.error(JSON.stringify({ event: "password_reset_email_failed", provider_error: String(result.error).slice(0, 200) }));
            return sendError(res, 502, "The recovery email could not be sent. Please try again later.");
          }
        }
        return res.status(202).json({
          message: "If an account matches that email, a password recovery link will be sent."
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: "password_reset_request_failed",
          message: error.message
        }));
        return sendError(res, 500, "Password recovery could not be started. Please try again.");
      }
    });

  app.post("/api/product/auth/password-reset/complete", sameOrigin,
    limitRequests("password-reset-complete", 10, 60 * 60 * 1000, "Too many attempts. Try again later."),
    async (req, res) => {
      const token = typeof req.body.token === "string" ? req.body.token : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || password.length < 12 || password.length > 128) {
        return sendError(res, 400, "Use a valid recovery link and a password between 12 and 128 characters.");
      }
      try {
        const tokenHash = hashToken(token);
        const reset = await (database.prepare(`
          SELECT user_id FROM product_password_resets
          WHERE token_hash = $1 AND expires_at > $2
        `).get(tokenHash, new Date().toISOString()));
        if (!reset) return sendError(res, 400, "This recovery link is invalid or expired. Request a new one.");
        const passwordHash = await makePasswordHash(password);
        const completeReset = await database.transaction(async () => {
          const used = await (database.prepare(`
            DELETE FROM product_password_resets
            WHERE token_hash = $1 AND expires_at > $2
          `).run(tokenHash, new Date().toISOString()));
          if (!used.changes) return false;
          await (database.prepare("UPDATE product_users SET password_hash = $1 WHERE id = $2")
            .run(passwordHash, reset.user_id));
          await (database.prepare("DELETE FROM product_sessions WHERE user_id = $1").run(reset.user_id));
          await (database.prepare("DELETE FROM product_password_resets WHERE user_id = $1").run(reset.user_id));
          return true;
        });
        if (!completeReset) return sendError(res, 400, "This recovery link is invalid or expired. Request a new one.");
        return res.json({ message: "Password updated. Sign in with your new password." });
      } catch (error) {
        console.error("Password reset could not be completed:", error.message);
        return sendError(res, 500, "The password could not be updated. Please try again.");
      }
    });

  app.post("/api/product/auth/login", sameOrigin, async (req, res) => {
    const email = requiredText(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || password.length > 128) return sendError(res, 401, "Email or password is incorrect.");
    const loginFailureKey = `login:${hashToken(`${req.ip || "unknown"}:${email}`)}`;
    const loginFailureWindowMs = 15 * 60 * 1000;
    const loginFailures = rateLimitBuckets.get(loginFailureKey);
    if (loginFailures && Date.now() - loginFailures.windowStart >= loginFailureWindowMs) {
      rateLimitBuckets.delete(loginFailureKey);
    } else if (loginFailures?.count >= 10) {
      return sendError(res, 429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
    }
    const inviteToken = typeof req.body.inviteToken === "string" ? req.body.inviteToken : "";
    if (inviteToken && !/^[A-Za-z0-9_-]{40,60}$/.test(inviteToken)) {
      return sendError(res, 400, "This invitation is invalid or expired.");
    }

    try {
      const user = await (database.prepare(
        "SELECT id, email, password_hash FROM product_users WHERE email = $1"
      ).get(email));
      if (!user || !(await checkPassword(password, user.password_hash))) {
        rateLimit(loginFailureKey, 10, loginFailureWindowMs,
          "Too many sign-in attempts. Please wait 15 minutes and try again.");
        return sendError(res, 401, "Email or password is incorrect.");
      }
      rateLimitBuckets.delete(loginFailureKey);

      let workspace;
      if (inviteToken) {
        const invite = await (database.prepare(`
          SELECT i.id, i.workspace_id, i.invited_email
          FROM product_workspace_invites i
          JOIN product_workspace_subscriptions s ON s.workspace_id = i.workspace_id
          WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > $2
            AND s.expires_at > CURRENT_TIMESTAMP
        `).get(hashToken(inviteToken), new Date().toISOString()));
        if (!invite || invite.invited_email.toLowerCase() !== email) {
          return sendError(res, 400, "This invitation is invalid, expired, or addressed to a different email.");
        }
        const acceptedWorkspace = await database.transaction(async () => {
          const plan = await lockWorkspace(invite.workspace_id);
          const memberCount = (await database.prepare(
            "SELECT COUNT(*) AS count FROM product_memberships WHERE workspace_id = $1"
          ).get(invite.workspace_id)).count;
          if (plan.memberLimit !== null && memberCount >= plan.memberLimit) {
            const error = new Error("This workspace has reached its team-member limit. Ask its owner to upgrade the plan.");
            error.code = "PLAN_SEAT_LIMIT";
            throw error;
          }
          const accepted = await (database.prepare(`
            UPDATE product_workspace_invites SET accepted_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND accepted_at IS NULL AND expires_at > $2
              AND EXISTS (
                SELECT 1 FROM product_workspace_subscriptions
                WHERE workspace_id = $3 AND expires_at > CURRENT_TIMESTAMP
              )
          `).run(invite.id, new Date().toISOString(), invite.workspace_id));
          if (!accepted.changes) {
            const error = new Error("This invitation has already been used or has expired.");
            error.code = "INVITE_INVALID";
            throw error;
          }
          await (database.prepare(
            "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')"
          ).run(invite.workspace_id, user.id));
          return await (database.prepare(`
            SELECT w.id, w.name, s.expires_at AS subscription_expires_at, s.plan,
              s.member_limit, s.active_implementation_limit, s.template_limit
            FROM product_workspaces w
            JOIN product_workspace_subscriptions s ON s.workspace_id = w.id
            WHERE w.id = $1
          `).get(invite.workspace_id));
          });
        try {
          const joinedWorkspace = acceptedWorkspace;
          workspace = { ...joinedWorkspace, role: "member" };
        } catch (error) {
          if (error.code === "INVITE_INVALID") return sendError(res, 409, error.message);
          if (error.code === "PLAN_SEAT_LIMIT") return sendError(res, 409, error.message);
          if (error.code === "23505") {
            return sendError(res, 409, "This account is already a member of the invited workspace.");
          }
          throw error;
        }
      } else {
        const membership = await (database.prepare(`
          SELECT w.id, w.name, m.role, s.expires_at AS subscription_expires_at, s.plan,
            s.member_limit, s.active_implementation_limit, s.template_limit
          FROM product_memberships m
          JOIN product_workspaces w ON w.id = m.workspace_id
          JOIN product_workspace_subscriptions s ON s.workspace_id = w.id
          WHERE m.user_id = $1 AND s.expires_at > CURRENT_TIMESTAMP
          ORDER BY m.role = 'owner' DESC, w.id
          LIMIT 1
        `).get(user.id));
        if (!membership) {
          return res.status(403).json({
            error: "Workspace access has expired. Contact Relay to renew your subscription.",
            code: "subscription_expired"
          });
        }
        workspace = {
          id: membership.id,
          name: membership.name,
          role: membership.role,
          subscriptionExpiresAt: membership.subscription_expires_at,
          plan: membership.plan,
          memberLimit: membership.member_limit,
          activeImplementationLimit: membership.active_implementation_limit,
          templateLimit: membership.template_limit
        };
      }
      if (workspace.subscription_expires_at) {
        workspace.subscriptionExpiresAt = workspace.subscription_expires_at;
        delete workspace.subscription_expires_at;
      }
      workspace.planDetails = getPlanDetails(workspace.plan, {
        memberLimit: workspace.memberLimit,
        activeImplementationLimit: workspace.activeImplementationLimit,
        templateLimit: workspace.templateLimit
      });

      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
      await (database.prepare(
        "INSERT INTO product_sessions (token_hash, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, $4)"
      ).run(hashToken(rawToken), user.id, workspace.id, expiresAt));
      setSessionCookie(res, rawToken, isProduction);
      return res.json({
        user: { id: user.id, email: user.email },
        workspace
      });
    } catch (error) {
      if (error.code === "23505") {
        return sendError(res, 409, "This account is already a member of the invited workspace.");
      }
      console.error("Product sign-in failed:", error.message);
      return sendError(res, 500, "Sign-in could not be completed. Please try again.");
    }
  });

  app.post("/api/product/auth/logout", sameOrigin, async (req, res) => {
    const token = cookieToken(req);
    if (token) await (database.prepare("DELETE FROM product_sessions WHERE token_hash = $1").run(hashToken(token)));
    clearSessionCookie(res, isProduction);
    return res.json({ success: true });
  });

  async function requireSession(req, res, next) {
    const token = cookieToken(req);
    if (!token) return sendError(res, 401, "Sign in to continue.");
    const session = await (database.prepare(`
      SELECT s.user_id, s.workspace_id, s.expires_at, u.email, w.name AS workspace_name, m.role,
        subscription.expires_at AS subscription_expires_at, subscription.plan,
        subscription.member_limit, subscription.active_implementation_limit, subscription.template_limit
      FROM product_sessions s
      JOIN product_users u ON u.id = s.user_id
      JOIN product_workspaces w ON w.id = s.workspace_id
      JOIN product_memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
      LEFT JOIN product_workspace_subscriptions subscription ON subscription.workspace_id = s.workspace_id
      WHERE s.token_hash = $1
    `).get(hashToken(token)));
    if (!session || Date.parse(session.expires_at) <= Date.now()) {
      if (session) await (database.prepare("DELETE FROM product_sessions WHERE token_hash = $1").run(hashToken(token)));
      clearSessionCookie(res, isProduction);
      return sendError(res, 401, "Your session expired. Sign in again.");
    }
    if (!session.subscription_expires_at || Date.parse(session.subscription_expires_at) <= Date.now()) {
      await (database.prepare("DELETE FROM product_sessions WHERE token_hash = $1").run(hashToken(token)));
      clearSessionCookie(res, isProduction);
      return res.status(403).json({
        error: "Workspace access has expired. Contact Relay to renew your subscription.",
        code: "subscription_expired"
      });
    }
    req.product = {
      userId: session.user_id,
      workspaceId: session.workspace_id,
      email: session.email,
      workspaceName: session.workspace_name,
      role: session.role,
      subscriptionExpiresAt: session.subscription_expires_at,
      plan: session.plan,
      planDetails: getPlanDetails(session.plan, {
        memberLimit: session.member_limit,
        activeImplementationLimit: session.active_implementation_limit,
        templateLimit: session.template_limit
      })
    };
    return next();
  }

  app.get("/api/product/me", requireSession, (req, res) => {
    const justonecx = createJustOneCXIdentity(req.product.userId, req.product.workspaceId);
    res.json({
      user: { id: req.product.userId, email: req.product.email },
      workspace: {
        id: req.product.workspaceId,
        name: req.product.workspaceName,
        role: req.product.role,
        subscriptionExpiresAt: req.product.subscriptionExpiresAt,
        plan: req.product.planDetails
      },
      ...(justonecx ? { justonecx } : {})
    });
  });

  app.get("/api/product/account-deletion/workspaces", requireSession, async (req, res) => {
    const workspaces = await (database.prepare(`
      SELECT w.id, w.name, m.role,
        (SELECT COUNT(*) FROM product_memberships all_members WHERE all_members.workspace_id = w.id) AS member_count
      FROM product_memberships m
      JOIN product_workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1
      ORDER BY lower(w.name), w.id
    `).all(req.product.userId));
    const members = await (database.prepare(`
      SELECT workspace_id, user_id, email
      FROM product_memberships m
      JOIN product_users u ON u.id = m.user_id
      WHERE m.workspace_id IN (
        SELECT workspace_id FROM product_memberships WHERE user_id = $1
      ) AND m.user_id != $2
      ORDER BY lower(email)
    `).all(req.product.userId, req.product.userId));
    const membersByWorkspace = new Map();
    for (const member of members) {
      const workspaceMembers = membersByWorkspace.get(member.workspace_id) || [];
      workspaceMembers.push({ userId: member.user_id, email: member.email });
      membersByWorkspace.set(member.workspace_id, workspaceMembers);
    }
    return res.json({
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        members: membersByWorkspace.get(workspace.id) || []
      }))
    });
  });

  app.delete("/api/product/account", sameOrigin, limitRequests(
    "account-deletion", 5, 15 * 60 * 1000, "Too many deletion attempts. Please wait and try again."
  ), requireSession, async (req, res) => {
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (password.length < 1 || password.length > 128 || req.body.confirmation !== "DELETE") {
      return sendError(res, 400, "Enter your password and type DELETE to confirm account deletion.");
    }

    const user = await (database.prepare("SELECT password_hash FROM product_users WHERE id = $1")
      .get(req.product.userId));
    if (!user || !(await checkPassword(password, user.password_hash))) {
      return sendError(res, 401, "Your password is incorrect. Your account has not been deleted.");
    }

    const requestedTransfers = req.body.transfers;
    if (!Array.isArray(requestedTransfers) || requestedTransfers.length > 100) {
      return sendError(res, 400, "Review your workspace ownership choices and try again.");
    }
    const transferByWorkspace = new Map();
    for (const transfer of requestedTransfers) {
      const workspaceId = validId(transfer?.workspaceId);
      const newOwnerUserId = validId(transfer?.newOwnerUserId);
      if (!workspaceId || !newOwnerUserId || transferByWorkspace.has(workspaceId)) {
        return sendError(res, 400, "Review your workspace ownership choices and try again.");
      }
      transferByWorkspace.set(workspaceId, newOwnerUserId);
    }

    try {
      await database.transaction(async () => {
        const memberships = await (database.prepare(`
          SELECT m.workspace_id, m.role,
            (SELECT COUNT(*) FROM product_memberships all_members
              WHERE all_members.workspace_id = m.workspace_id) AS member_count
          FROM product_memberships m
          WHERE m.user_id = $1
          ORDER BY m.workspace_id
        `).all(req.product.userId));
        const requiredTransfers = new Set();
        for (const membership of memberships) {
          if (membership.member_count <= 1) continue;
          if (membership.role !== "owner") continue;
          requiredTransfers.add(membership.workspace_id);
          const newOwnerUserId = transferByWorkspace.get(membership.workspace_id);
          const newOwner = newOwnerUserId && await (database.prepare(`
            SELECT user_id FROM product_memberships
            WHERE workspace_id = $1 AND user_id = $2 AND user_id != $3
          `).get(membership.workspace_id, newOwnerUserId, req.product.userId));
          if (!newOwner) {
            const error = new Error("Choose a remaining workspace member to become the owner before deleting your account.");
            error.code = "INVALID_WORKSPACE_TRANSFER";
            throw error;
          }
        }
        if ([...transferByWorkspace.keys()].some((workspaceId) => !requiredTransfers.has(workspaceId))) {
          const error = new Error("A workspace ownership choice is no longer valid. Refresh and try again.");
          error.code = "INVALID_WORKSPACE_TRANSFER";
          throw error;
        }

        for (const membership of memberships) {
          if (membership.member_count <= 1) {
            await (database.prepare("DELETE FROM product_workspaces WHERE id = $1").run(membership.workspace_id));
            continue;
          }
          if (membership.role === "owner") {
            await (database.prepare(`
              UPDATE product_memberships SET role = 'owner'
              WHERE workspace_id = $1 AND user_id = $2
            `).run(membership.workspace_id, transferByWorkspace.get(membership.workspace_id)));
          }
          await (database.prepare("DELETE FROM product_memberships WHERE workspace_id = $1 AND user_id = $2")
            .run(membership.workspace_id, req.product.userId));
        }

        await (database.prepare("UPDATE product_process_steps SET assignee_user_id = NULL WHERE assignee_user_id = $1")
          .run(req.product.userId));
        await (database.prepare("UPDATE product_implementation_steps SET assignee_user_id = NULL WHERE assignee_user_id = $1")
          .run(req.product.userId));
        await (database.prepare("DELETE FROM product_users WHERE id = $1").run(req.product.userId));
      });
    } catch (error) {
      if (error.code === "INVALID_WORKSPACE_TRANSFER") {
        return sendError(res, 409, error.message);
      }
      throw error;
    }
    clearSessionCookie(res, isProduction);
    return res.json({ success: true });
  });

  app.get("/api/product/onboarding", requireSession, async (req, res) => {
    const onboarding = await (database.prepare(
      "SELECT dismissed FROM product_user_onboarding WHERE user_id = $1"
    ).get(req.product.userId));
    return res.json({ dismissed: Boolean(onboarding?.dismissed) });
  });

  app.patch("/api/product/onboarding", sameOrigin, requireSession, async (req, res) => {
    if (typeof req.body.dismissed !== "boolean") {
      return sendError(res, 400, "Choose whether to show or dismiss the getting-started guide.");
    }
    await (database.prepare(`
      INSERT INTO product_user_onboarding (user_id, dismissed, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        dismissed = excluded.dismissed,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.product.userId, req.body.dismissed));
    return res.json({ dismissed: req.body.dismissed });
  });

  app.get("/api/product/preferences", requireSession, async (req, res) => {
    const preferences = await (database.prepare(`
      SELECT theme, accent FROM product_user_preferences WHERE user_id = $1
    `).get(req.product.userId));
    return res.json(preferences || { theme: "light", accent: "blue" });
  });

  app.patch("/api/product/preferences", sameOrigin, requireSession, async (req, res) => {
    const { theme, accent } = req.body;
    if (theme === undefined && accent === undefined) {
      return sendError(res, 400, "Choose a theme mode or accent color to update.");
    }
    if (theme !== undefined && !["light", "dark"].includes(theme)) {
      return sendError(res, 400, "Choose light or dark mode.");
    }
    if (accent !== undefined && !["blue", "teal", "violet", "rose"].includes(accent)) {
      return sendError(res, 400, "Choose one of the available accent colors.");
    }
    const current = await (database.prepare(`
      SELECT theme, accent FROM product_user_preferences WHERE user_id = $1
    `).get(req.product.userId)) || { theme: "light", accent: "blue" };
    const next = {
      theme: theme ?? current.theme,
      accent: accent ?? current.accent
    };
    await (database.prepare(`
      INSERT INTO product_user_preferences (user_id, theme, accent, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        theme = excluded.theme,
        accent = excluded.accent,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.product.userId, next.theme, next.accent));
    return res.json(next);
  });

  app.get("/api/product/help-chat", requireSession, async (req, res) => {
    const messages = await (database.prepare(`
      SELECT id, role, content, created_at
      FROM product_help_messages
      WHERE user_id = $1
      ORDER BY id
    `).all(req.product.userId));
    return res.json({ messages });
  });

  app.delete("/api/product/help-chat", sameOrigin, requireSession, async (req, res) => {
    await database.transaction(async () => {
      await (database.prepare("DELETE FROM product_help_messages WHERE user_id = $1").run(req.product.userId));
    });
    return res.json({ success: true });
  });

  app.post("/api/product/help-chat", sameOrigin, requireSession, async (req, res) => {
    const userId = req.product.userId;
    const message = requiredText(req.body.message, 1200);
    if (!message) return sendError(res, 400, "Enter a Relay question up to 1,200 characters.");

    const answer = relayHelpReply(message);
    if (!answer || answer.length > 4000) return sendError(res, 500, "Ray could not prepare a reply. Please contact Relay support.");

    const savedMessage = await database.transaction(async () => {
      const insert = database.prepare(
        "INSERT INTO product_help_messages (user_id, role, content) VALUES ($1, $2, $3) RETURNING id"
      );
      await (insert.run(userId, "user", message));
      const assistantMessage = await (insert.run(userId, "assistant", answer.trim()));
      return await (database.prepare(
        "SELECT id, role, content, created_at FROM product_help_messages WHERE id = $1 AND user_id = $2"
      ).get(assistantMessage.lastInsertRowid, userId));
    });

    return res.json({ message: savedMessage });
  });

  app.get("/api/product/workspace", requireSession, async (req, res) => {
    const workspaceId = req.product.workspaceId;
    const processes = await (database.prepare(`
      SELECT p.id, p.name, p.description, p.updated_at,
        (SELECT COUNT(*) FROM product_process_steps s WHERE s.process_id = p.id) AS steps_count,
        EXISTS (
          SELECT 1 FROM product_setup_checks c
          WHERE c.process_id = p.id AND c.process_revision = p.revision AND c.result = 'ready'
        ) AS checked
      FROM product_processes p
      WHERE p.workspace_id = $1
      ORDER BY p.updated_at DESC, p.id DESC
    `).all(workspaceId));
    const templates = await (database.prepare(
      "SELECT id, name, created_at, updated_at, revision, jsonb_array_length(steps_json::jsonb) AS step_count FROM product_templates WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC"
    ).all(workspaceId));
    const implementations = await (database.prepare(`
      SELECT i.id, i.template_id, i.customer_name, i.created_at, t.name AS template_name,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id) AS total_steps,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status != 'done') AS open_steps,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status = 'done') AS completed_steps,
        (SELECT MAX(s.updated_at) FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status = 'done') AS last_completed_at,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status = 'in_progress') AS in_progress_steps,
        (SELECT string_agg(DISTINCT s.assignee_user_id::text, ',') FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.assignee_user_id IS NOT NULL) AS assigned_member_ids,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status != 'done' AND s.assignee_user_id IS NULL) AS unowned_steps,
        (SELECT string_agg(s.title, ', ') FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done' AND s.assignee_user_id IS NULL) AS unowned_step_names,
        (SELECT COUNT(*) FROM product_requirements r
          LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = i.id
          WHERE r.workspace_id = i.workspace_id AND (r.template_id IS NULL OR r.template_id = i.template_id)
            AND r.required = TRUE AND TRIM(COALESCE(c.value, '')) = '') AS missing_inputs,
        (SELECT string_agg(r.name, ', ') FROM product_requirements r
          LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = i.id
          WHERE r.workspace_id = i.workspace_id AND (r.template_id IS NULL OR r.template_id = i.template_id)
            AND r.required = TRUE AND TRIM(COALESCE(c.value, '')) = '') AS missing_input_names,
        (SELECT COUNT(*) FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done' AND s.is_blocked = TRUE) AS blocked_steps,
        (SELECT string_agg(s.title, ', ') FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done' AND s.is_blocked = TRUE) AS blocked_step_names,
        (SELECT COUNT(*) FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done'
            AND s.due_at != '' AND s.due_at < CURRENT_DATE::text) AS overdue_steps,
        (SELECT string_agg(s.title, ', ') FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done'
            AND s.due_at != '' AND s.due_at < CURRENT_DATE::text) AS overdue_step_names,
        (SELECT COUNT(DISTINCT s.id) FROM product_implementation_steps s
          JOIN product_implementation_step_dependencies d ON d.implementation_step_id = s.id
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE s.implementation_id = i.id AND s.status != 'done' AND parent.status != 'done') AS waiting_steps,
        (SELECT string_agg(DISTINCT s.title, ', ') FROM product_implementation_steps s
          JOIN product_implementation_step_dependencies d ON d.implementation_step_id = s.id
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE s.implementation_id = i.id AND s.status != 'done' AND parent.status != 'done') AS waiting_step_names,
        GREATEST(
          COALESCE((SELECT MAX(c.updated_at) FROM product_customer_inputs c
            WHERE c.implementation_id = i.id AND BTRIM(c.value) != ''), i.created_at),
          COALESCE((SELECT MAX(e.created_at) FROM product_workspace_events e
            WHERE e.implementation_id = i.id
              AND e.event_type IN ('customer.information_submitted', 'customer.tasks_completed')), i.created_at)
        ) AS last_customer_activity_at
      FROM product_implementations i
      JOIN product_templates t ON t.id = i.template_id
      WHERE i.workspace_id = $1
      ORDER BY i.created_at DESC, i.id DESC
    `).all(workspaceId));
    for (const implementation of implementations) {
      const scopedRequirements = await (implementationRequirements(implementation.id, workspaceId, implementation.template_id));
      const invalid = scopedRequirements.filter((requirement) => {
        const value = requirement.value.trim();
        return value && inputValueError(requirement.input_type, value);
      });
      implementation.invalid_inputs = invalid.length;
      implementation.invalid_input_names = invalid.map((requirement) => requirement.name).join(", ");
      implementation.missing_inputs += invalid.length;
      if (invalid.length) {
        implementation.missing_input_names = [implementation.missing_input_names, implementation.invalid_input_names]
          .filter(Boolean).join(", ");
      }
      implementation.quiet_customer_days = Math.floor(
        (Date.now() - Date.parse(implementation.last_customer_activity_at)) / 86400000
      );
      implementation.quiet_customer = implementation.missing_inputs > 0
        && implementation.quiet_customer_days >= 3;
      if (implementation.completed_steps > 0 && implementation.open_steps > 0 && implementation.last_completed_at) {
        const elapsedDays = Math.max(1,
          (Date.parse(implementation.last_completed_at) - Date.parse(implementation.created_at)) / 86400000);
        const daysRemaining = Math.ceil((elapsedDays / implementation.completed_steps) * implementation.open_steps);
        implementation.projected_completion = new Date(Date.now() + daysRemaining * 86400000).toISOString().slice(0, 10);
      } else {
        implementation.projected_completion = implementation.open_steps === 0 ? new Date().toISOString().slice(0, 10) : "";
      }
    }
    const requirements = await (database.prepare(
      "SELECT id, name, description, required, input_type, template_id FROM product_requirements WHERE workspace_id = $1 ORDER BY id"
    ).all(workspaceId));
    const members = await (database.prepare(`
      SELECT u.id, u.email, m.role
      FROM product_memberships m JOIN product_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY m.role = 'owner' DESC, u.email
    `).all(workspaceId));
    const invites = await (database.prepare(`
      SELECT id, invited_email, expires_at, created_at
      FROM product_workspace_invites
      WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > $2
      ORDER BY created_at DESC
    `).all(workspaceId, new Date().toISOString()));
    const teamWorkload = await (database.prepare(`
      SELECT u.id, u.email,
        COUNT(s.id) FILTER (WHERE s.status != 'done') AS open_tasks,
        COUNT(s.id) FILTER (WHERE s.status != 'done' AND s.due_at != '' AND s.due_at < CURRENT_DATE::text) AS overdue_tasks
      FROM product_memberships m
      JOIN product_users u ON u.id = m.user_id
      LEFT JOIN product_implementation_steps s ON s.assignee_user_id = u.id
      LEFT JOIN product_implementations i ON i.id = s.implementation_id AND i.workspace_id = m.workspace_id
      WHERE m.workspace_id = $1 AND (s.id IS NULL OR i.id IS NOT NULL)
      GROUP BY u.id, u.email
      ORDER BY open_tasks DESC, lower(u.email)
    `).all(workspaceId));
    const notificationSettings = await (database.prepare(`
      SELECT email_enabled, reminder_days_before
      FROM product_workspace_notification_settings WHERE workspace_id = $1
    `).get(workspaceId)) || { email_enabled: false, reminder_days_before: 2 };
    const integrations = await (database.prepare(`
      SELECT provider, external_account_id, updated_at, hubspot_onboarding_pipeline_id,
        hubspot_onboarding_stage_id, hubspot_onboarding_template_id,
        hubspot_onboarding_last_error, hubspot_onboarding_last_error_at
      FROM product_workspace_integrations WHERE workspace_id = $1
      ORDER BY provider
    `).all(workspaceId));
    const capacityPlans = await database.prepare(`
      SELECT c.user_id, u.email AS user_email, c.week_start, c.available_minutes, c.capacity_note
      FROM product_capacity_plans c JOIN product_users u ON u.id = c.user_id
      WHERE c.workspace_id = $1 ORDER BY c.week_start DESC, u.email
    `).all(workspaceId);
    const activeImplementationCount = await countActiveImplementations(workspaceId);
    return res.json({
      processes,
      templates,
      implementations,
      requirements,
      members,
      invites,
      teamWorkload,
      notificationSettings,
      integrations,
      capacityPlans,
      role: req.product.role,
      plan: req.product.planDetails,
      usage: {
        members: members.length,
        pendingInvites: invites.length,
        templates: templates.length,
        activeImplementations: activeImplementationCount
      }
    });
  });

  app.patch("/api/product/notifications", sameOrigin, requireSession, async (req, res) => {
      if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can change notification settings.");
      const emailEnabled = req.body.emailEnabled;
      const reminderDaysBefore = req.body.reminderDaysBefore;
      if (typeof emailEnabled !== "boolean" || !Number.isInteger(reminderDaysBefore)
        || reminderDaysBefore < 0 || reminderDaysBefore > 30) {
        return sendError(res, 400, "Choose whether email notifications are enabled and a reminder window from 0 to 30 days.");
      }
      await database.prepare(`
        INSERT INTO product_workspace_notification_settings (workspace_id, email_enabled, reminder_days_before, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (workspace_id) DO UPDATE SET
          email_enabled = excluded.email_enabled,
          reminder_days_before = excluded.reminder_days_before,
          updated_at = CURRENT_TIMESTAMP
      `).run(req.product.workspaceId, emailEnabled, reminderDaysBefore);
      return res.json({ emailEnabled, reminderDaysBefore });
    });

  app.post("/api/product/integrations/:provider/connect", sameOrigin, requireSession, async (req, res) => {
      const { provider } = req.params;
      if (provider !== "hubspot") return sendError(res, 404, "Integration not found.");
      if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can connect integrations.");
      const providerKey = provider.toUpperCase();
      const clientId = process.env[`${providerKey}_CLIENT_ID`]?.trim();
      const clientSecret = process.env[`${providerKey}_CLIENT_SECRET`]?.trim();
      const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
      const missingConfiguration = [
        !clientId && `${providerKey}_CLIENT_ID`,
        !clientSecret && `${providerKey}_CLIENT_SECRET`,
        !baseUrl && "PUBLIC_BASE_URL"
      ].filter(Boolean);
      if (missingConfiguration.length) {
        return sendError(res, 503,
          `HubSpot OAuth setup is incomplete. Configure ${missingConfiguration.join(", ")} in the Relay deployment.`);
      }
      try {
        integrationKey();
      } catch (error) {
        console.error(JSON.stringify({ event: "integration_encryption_not_configured", provider, message: error.message }));
        return sendError(res, 503, "Integration token storage is not configured. Set INTEGRATION_ENCRYPTION_KEY in the Relay deployment.");
      }
      let callbackUrl;
      try {
        const parsedBaseUrl = new URL(baseUrl);
        if (isProduction && parsedBaseUrl.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS.");
        callbackUrl = new URL(`/api/product/integrations/callback/${provider}`, parsedBaseUrl).toString();
      } catch {
        return sendError(res, 503, "Integration callback URL is not configured correctly.");
      }
      const rawState = randomBytes(32).toString("base64url");
      await database.prepare(`
        DELETE FROM product_integration_states WHERE expires_at <= CURRENT_TIMESTAMP
      `).run();
      await database.prepare(`
        INSERT INTO product_integration_states (state_hash, workspace_id, provider, created_by, expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `).run(hashToken(rawState), req.product.workspaceId, provider, req.product.userId,
        new Date(Date.now() + 10 * 60 * 1000).toISOString());
      const authorizationUrl = new URL("https://app.hubspot.com/oauth/authorize");
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizationUrl.searchParams.set("state", rawState);
      authorizationUrl.searchParams.set("scope", "crm.objects.deals.read crm.objects.deals.write crm.objects.contacts.read crm.schemas.deals.read");
      return res.json({ authorizationUrl: authorizationUrl.toString() });
    });

  app.get("/api/product/integrations/hubspot/pipelines", requireSession, async (req, res) => {
    try {
      const { integration, pipelines } = await loadHubSpotPipelines(req.product.workspaceId);
      return res.json({
        pipelines,
        configuration: {
          pipelineId: integration.hubspot_onboarding_pipeline_id,
          stageId: integration.hubspot_onboarding_stage_id,
          templateId: integration.hubspot_onboarding_template_id
        }
      });
    } catch (error) {
      return sendError(res, 502, error.message);
    }
  });

  app.put("/api/product/integrations/hubspot/onboarding", sameOrigin, requireSession, async (req, res) => {
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can configure HubSpot handoff.");
    const pipelineId = requiredText(req.body.pipelineId, 120);
    const stageId = requiredText(req.body.stageId, 120);
    const templateId = validId(req.body.templateId);
    if (!pipelineId || !stageId || !templateId) {
      return sendError(res, 400, "Choose a HubSpot pipeline, its Closed Won stage, and a Relay template.");
    }
    const template = await database.prepare(`
      SELECT id, steps_json FROM product_templates
      WHERE id = $1 AND workspace_id = $2
    `).get(templateId, req.product.workspaceId);
    if (!template || !Array.isArray(JSON.parse(template.steps_json)) || !JSON.parse(template.steps_json).length) {
      return sendError(res, 400, "Choose a template with at least one saved step.");
    }
    try {
      const { pipelines } = await loadHubSpotPipelines(req.product.workspaceId);
      const pipeline = pipelines.find((item) => item.id === pipelineId);
      const stage = pipeline?.stages.find((item) => item.id === stageId);
      if (!stage?.isClosedWon) {
        return sendError(res, 400, "Choose a Closed Won stage from the selected HubSpot pipeline.");
      }
      await database.prepare(`
        UPDATE product_workspace_integrations
        SET hubspot_onboarding_pipeline_id = $1, hubspot_onboarding_stage_id = $2,
          hubspot_onboarding_template_id = $3, hubspot_onboarding_last_synced_at = CURRENT_TIMESTAMP,
          hubspot_onboarding_last_error = '', hubspot_onboarding_last_error_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = $4 AND provider = 'hubspot'
      `).run(pipelineId, stageId, templateId, req.product.workspaceId);
      return res.json({ success: true, message: "Closed Won handoff is configured. New matching deals will start once." });
    } catch (error) {
      return sendError(res, 502, error.message);
    }
  });

  app.get("/api/product/integrations/callback/:provider", async (req, res) => {
      const { provider } = req.params;
      const stateToken = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const redirectToSettings = (result) => res.redirect(303, `/product.html?integration=${encodeURIComponent(result)}`);
      if (provider !== "hubspot" || !/^[A-Za-z0-9_-]{40,60}$/.test(stateToken) || !code) {
        return redirectToSettings("connect_failed");
      }
      const pending = await database.prepare(`
        SELECT state_hash, workspace_id, created_by
        FROM product_integration_states
        WHERE state_hash = $1 AND provider = $2 AND expires_at > CURRENT_TIMESTAMP
      `).get(hashToken(stateToken), provider);
      if (!pending) return redirectToSettings("connect_failed");
      const consumed = await database.prepare(
        "DELETE FROM product_integration_states WHERE state_hash = $1 AND expires_at > CURRENT_TIMESTAMP"
      ).run(pending.state_hash);
      if (!consumed.changes) return redirectToSettings("connect_failed");

      const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`]?.trim();
      const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`]?.trim();
      const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
      try {
        if (!clientId || !clientSecret || !baseUrl) throw new Error("OAuth client is not configured.");
        const callbackUrl = new URL(`/api/product/integrations/callback/${provider}`, baseUrl).toString();
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
          code
        });
        const tokenEndpoint = "https://api.hubapi.com/oauth/v3/token";
        const response = await fetch(tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(10000)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.access_token) {
          console.error(JSON.stringify({ event: "integration_oauth_exchange_failed", provider, provider_status: response.status }));
          return redirectToSettings("connect_failed");
        }
        await database.prepare(`
          INSERT INTO product_workspace_integrations
            (workspace_id, provider, access_token_cipher, refresh_token_cipher, webhook_url_cipher,
             token_expires_at, external_account_id, connected_by, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
          ON CONFLICT (workspace_id, provider) DO UPDATE SET
            access_token_cipher = excluded.access_token_cipher,
            refresh_token_cipher = excluded.refresh_token_cipher,
            webhook_url_cipher = excluded.webhook_url_cipher,
            token_expires_at = excluded.token_expires_at,
            external_account_id = excluded.external_account_id,
            connected_by = excluded.connected_by,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          pending.workspace_id,
          provider,
          encryptIntegrationValue(result.access_token),
          result.refresh_token ? encryptIntegrationValue(result.refresh_token) : "",
          "",
          Number.isFinite(result.expires_in) ? new Date(Date.now() + result.expires_in * 1000).toISOString() : null,
          String(result.hub_id || ""),
          pending.created_by
        );
        return redirectToSettings(`${provider}_connected`);
      } catch (error) {
        console.error(JSON.stringify({ event: "integration_oauth_callback_failed", provider, message: error.message }));
        return redirectToSettings("connect_failed");
      }
    });

  app.delete("/api/product/integrations/:provider", sameOrigin, requireSession, async (req, res) => {
      const { provider } = req.params;
      if (provider !== "hubspot") return sendError(res, 404, "Integration not found.");
      if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can disconnect integrations.");
      await database.prepare(
        "DELETE FROM product_workspace_integrations WHERE workspace_id = $1 AND provider = $2"
      ).run(req.product.workspaceId, provider);
      return res.json({ success: true });
    });

  app.post("/api/product/internal/process-events", async (req, res) => {
      const expectedToken = process.env.NOTIFICATIONS_CRON_SECRET?.trim() || "";
      const authorization = req.get("Authorization") || "";
      const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const expectedBuffer = Buffer.from(expectedToken);
      const suppliedBuffer = Buffer.from(suppliedToken);
      if (!expectedToken) return sendError(res, 503, "Event processing is not configured.");
      if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        return sendError(res, 401, "Not authorized.");
      }

      const configuredHubspots = await database.prepare(`
        SELECT h.workspace_id, h.access_token_cipher, h.refresh_token_cipher, h.token_expires_at,
          h.hubspot_onboarding_pipeline_id, h.hubspot_onboarding_stage_id,
          h.hubspot_onboarding_template_id, h.hubspot_onboarding_last_synced_at
        FROM product_workspace_integrations h
        JOIN product_workspace_subscriptions s ON s.workspace_id = h.workspace_id
        WHERE h.provider = 'hubspot' AND h.hubspot_onboarding_pipeline_id != ''
          AND h.hubspot_onboarding_stage_id != '' AND h.hubspot_onboarding_template_id IS NOT NULL
          AND s.expires_at > CURRENT_TIMESTAMP
      `).all();
      let hubspotImportsCreated = 0;
      let hubspotImportFailures = 0;
      for (const integration of configuredHubspots) {
        try {
          hubspotImportsCreated += await pollHubSpotOnboarding(integration, req);
        } catch (error) {
          hubspotImportFailures += 1;
          await database.prepare(`
            UPDATE product_workspace_integrations
            SET hubspot_onboarding_last_error = $1, hubspot_onboarding_last_error_at = CURRENT_TIMESTAMP
            WHERE workspace_id = $2 AND provider = 'hubspot'
          `).run(error.message.slice(0, 500), integration.workspace_id);
          console.error(JSON.stringify({
            event: "hubspot_closed_won_poll_failed",
            workspace_id: integration.workspace_id,
            message: error.message
          }));
        }
      }

      const reminders = await database.prepare(`
        SELECT i.workspace_id, i.id AS implementation_id, s.id AS task_id, s.title,
          s.due_at, s.due_at < CURRENT_DATE::text AS is_overdue,
          s.assignee_user_id, i.customer_name,
          CASE WHEN s.due_at < CURRENT_DATE::text THEN CURRENT_DATE::text ELSE s.due_at END AS reminder_day
        FROM product_workspace_notification_settings n
        JOIN product_implementations i ON i.workspace_id = n.workspace_id
        JOIN product_workspace_subscriptions subscription ON subscription.workspace_id = i.workspace_id
        JOIN product_implementation_steps s ON s.implementation_id = i.id
        WHERE n.email_enabled = TRUE AND subscription.expires_at > CURRENT_TIMESTAMP
          AND s.status != 'done' AND s.due_at != ''
          AND s.due_at <= (CURRENT_DATE + n.reminder_days_before)::text
      `).all();
      for (const reminder of reminders) {
        const eventKey = `reminder:${reminder.task_id}:${reminder.due_at}:${reminder.reminder_day}`;
        await database.prepare(`
          INSERT INTO product_workspace_events
            (event_key, workspace_id, implementation_id, event_type, payload)
          VALUES ($1, $2, $3, 'task.reminder', $4::jsonb)
          ON CONFLICT (event_key) DO NOTHING
        `).run(eventKey, reminder.workspace_id, reminder.implementation_id, JSON.stringify({
          taskId: reminder.task_id,
          taskTitle: reminder.title,
          dueAt: reminder.due_at,
          isOverdue: reminder.is_overdue,
          assignedUserId: reminder.assignee_user_id,
          customerName: reminder.customer_name
        }));
      }
      const customerTaskReminders = await database.prepare(`
        SELECT i.workspace_id, i.id AS implementation_id, i.customer_name,
          c.id AS contact_id, c.email AS recipient_email, s.id AS task_id, s.title,
          s.due_at
        FROM product_workspace_notification_settings n
        JOIN product_implementations i ON i.workspace_id = n.workspace_id
        JOIN product_workspace_subscriptions subscription ON subscription.workspace_id = i.workspace_id
        JOIN product_customer_contacts c ON c.implementation_id = i.id
        JOIN product_implementation_steps s ON s.implementation_id = i.id
        WHERE n.email_enabled = TRUE AND subscription.expires_at > CURRENT_TIMESTAMP
          AND c.revoked_at IS NULL AND c.expires_at > CURRENT_TIMESTAMP
          AND s.customer_visible = TRUE AND s.status != 'done' AND s.due_at != ''
          AND s.due_at <= (CURRENT_DATE + n.reminder_days_before)::text
      `).all();
      for (const reminder of customerTaskReminders) {
        const eventKey = `customer-task-reminder:${reminder.contact_id}:${reminder.task_id}:${reminder.due_at}`;
        await database.prepare(`
          INSERT INTO product_workspace_events
            (event_key, workspace_id, implementation_id, event_type, payload)
          VALUES ($1, $2, $3, 'customer.task_reminder', $4::jsonb)
          ON CONFLICT (event_key) DO NOTHING
        `).run(eventKey, reminder.workspace_id, reminder.implementation_id, JSON.stringify({
          contactId: reminder.contact_id,
          recipientEmail: reminder.recipient_email,
          customerName: reminder.customer_name,
          taskTitle: reminder.title,
          dueAt: reminder.due_at
        }));
      }

      const customerEscalations = await database.prepare(`
        SELECT i.id AS implementation_id, i.workspace_id, i.customer_name, i.escalation_email,
          i.escalation_delay_days,
          GREATEST(
            COALESCE((SELECT MAX(c.updated_at) FROM product_customer_inputs c
              WHERE c.implementation_id = i.id AND BTRIM(c.value) != ''), i.created_at),
            COALESCE((SELECT MAX(contact.last_activity_at) FROM product_customer_contacts contact
              WHERE contact.implementation_id = i.id AND contact.revoked_at IS NULL), i.created_at),
            COALESCE((SELECT MAX(e.created_at) FROM product_workspace_events e
              WHERE e.implementation_id = i.id
                AND e.event_type IN ('customer.information_submitted', 'customer.tasks_completed')), i.created_at)
          ) AS last_customer_activity_at,
          (SELECT string_agg(r.name, ', ') FROM product_requirements r
            LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = i.id
            WHERE r.workspace_id = i.workspace_id AND (r.template_id IS NULL OR r.template_id = i.template_id)
              AND r.required = TRUE AND BTRIM(COALESCE(c.value, '')) = '') AS missing_information
        FROM product_implementations i
        JOIN product_workspace_notification_settings n ON n.workspace_id = i.workspace_id
        JOIN product_workspace_subscriptions subscription ON subscription.workspace_id = i.workspace_id
        WHERE n.email_enabled = TRUE AND subscription.expires_at > CURRENT_TIMESTAMP
          AND BTRIM(i.escalation_email) != ''
          AND EXISTS (
            SELECT 1 FROM product_requirements r
            LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = i.id
            WHERE r.workspace_id = i.workspace_id AND (r.template_id IS NULL OR r.template_id = i.template_id)
              AND r.required = TRUE AND BTRIM(COALESCE(c.value, '')) = ''
          )
      `).all();
      for (const escalation of customerEscalations) {
        if (Date.now() - Date.parse(escalation.last_customer_activity_at)
          < escalation.escalation_delay_days * 86400000) continue;
        const activityKey = Date.parse(escalation.last_customer_activity_at);
        const recipientKey = hashToken(escalation.escalation_email).slice(0, 12);
        const eventKey = `customer-escalation:${escalation.implementation_id}:${activityKey}:${escalation.escalation_delay_days}:${recipientKey}`;
        await database.prepare(`
          INSERT INTO product_workspace_events
            (event_key, workspace_id, implementation_id, event_type, payload)
          VALUES ($1, $2, $3, 'customer.escalation', $4::jsonb)
          ON CONFLICT (event_key) DO NOTHING
        `).run(eventKey, escalation.workspace_id, escalation.implementation_id, JSON.stringify({
          recipientEmail: escalation.escalation_email,
          escalationDelayDays: escalation.escalation_delay_days,
          customerName: escalation.customer_name,
          missingInformation: escalation.missing_information || "",
          lastCustomerActivityAt: new Date(activityKey).toISOString()
        }));
      }

      const events = await database.prepare(`
        UPDATE product_workspace_events
        SET status = 'processing', available_at = CURRENT_TIMESTAMP + INTERVAL '10 minutes'
        WHERE id IN (
          SELECT id FROM product_workspace_events
          WHERE status IN ('pending', 'processing') AND available_at <= CURRENT_TIMESTAMP
          ORDER BY id
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, workspace_id, implementation_id, event_type, payload, attempts,
          email_sent_at, hubspot_synced_at
      `).all();
      let processed = 0;
      let failures = 0;
      for (const event of events) {
        try {
          const implementation = event.implementation_id ? await database.prepare(`
            SELECT i.customer_name, i.created_at,
              COUNT(s.id) AS total_tasks,
              COUNT(s.id) FILTER (WHERE s.status = 'done') AS completed_tasks,
              COUNT(s.id) FILTER (WHERE s.status != 'done' AND s.due_at != '' AND s.due_at < CURRENT_DATE::text) AS overdue_tasks,
              COUNT(s.id) FILTER (WHERE s.status != 'done' AND s.is_blocked) AS blocked_tasks
            FROM product_implementations i
            LEFT JOIN product_implementation_steps s ON s.implementation_id = i.id
            WHERE i.id = $1 AND i.workspace_id = $2
            GROUP BY i.id
          `).get(event.implementation_id, event.workspace_id) : null;
          if (event.event_type === "customer.escalation") {
            const currentActivity = await database.prepare(`
              SELECT GREATEST(
                COALESCE((SELECT MAX(c.updated_at) FROM product_customer_inputs c
                  WHERE c.implementation_id = i.id AND BTRIM(c.value) != ''), i.created_at),
                COALESCE((SELECT MAX(e.created_at) FROM product_workspace_events e
                  WHERE e.implementation_id = i.id
                    AND e.event_type IN ('customer.information_submitted', 'customer.tasks_completed')), i.created_at)
              ) AS last_customer_activity_at,
              EXISTS (
                SELECT 1 FROM product_requirements r
                LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = i.id
                WHERE r.workspace_id = i.workspace_id AND (r.template_id IS NULL OR r.template_id = i.template_id)
                  AND r.required = TRUE AND BTRIM(COALESCE(c.value, '')) = ''
              ) AS missing_information,
              i.escalation_email, i.escalation_delay_days
              FROM product_implementations i
              WHERE i.id = $1 AND i.workspace_id = $2
            `).get(event.implementation_id, event.workspace_id);
            if (!currentActivity?.missing_information
              || currentActivity.escalation_email !== event.payload.recipientEmail
              || Date.parse(currentActivity.last_customer_activity_at) > Date.parse(event.payload.lastCustomerActivityAt)
              || Date.now() - Date.parse(currentActivity.last_customer_activity_at)
                < currentActivity.escalation_delay_days * 86400000
              || currentActivity.escalation_delay_days !== event.payload.escalationDelayDays) {
              await database.prepare(`
                UPDATE product_workspace_events
                SET status = 'sent', email_sent_at = CURRENT_TIMESTAMP, processed_at = CURRENT_TIMESTAMP
                WHERE id = $1
              `).run(event.id);
              processed += 1;
              continue;
            }
          }
          const message = event.event_type === "task.reminder"
            ? `Reminder: ${event.payload.taskTitle} for ${event.payload.customerName} ${event.payload.isOverdue ? "is overdue (was due)" : "is due"} ${event.payload.dueAt}.`
            : event.event_type === "customer.task_reminder"
              ? `A friendly reminder that “${event.payload.taskTitle}” for ${event.payload.customerName} is due ${event.payload.dueAt}. Please use the personal portal link from your onboarding invitation to review the task or message your implementation team.`
            : event.event_type === "customer.escalation"
              ? `Relay is following up because required setup information for ${event.payload.customerName} has not been received. The original customer contact has been quiet for at least ${event.payload.escalationDelayDays} days. Still needed: ${event.payload.missingInformation || "required setup information"}.`
            : event.event_type === "implementation.created"
              ? `Implementation started for ${implementation?.customer_name || "a customer"}.`
              : event.event_type === "customer.message"
                ? `A new message from ${event.payload.senderName || "the customer"} is waiting in the ${implementation?.customer_name || "customer"} portal.`
                : event.event_type === "customer.file_uploaded"
                  ? `${event.payload.uploadedBy || "The customer"} uploaded “${event.payload.filename}” for ${implementation?.customer_name || "a customer"}.`
                  : event.event_type === "team.message"
                    ? `Your implementation team replied to your message about ${implementation?.customer_name || "your onboarding"}. Open the personal portal link from your invitation to read the reply.`
                    : event.event_type === "customer.invited"
                      ? `${event.payload.contactName || event.payload.recipientEmail} was invited to the ${implementation?.customer_name || "customer"} portal.`
              : event.event_type === "customer.information_submitted"
                ? `Customer information was submitted for ${implementation?.customer_name || "a customer"}.`
                : event.event_type === "customer.tasks_completed"
                  ? `Customer completed ${event.payload.count} task(s) for ${implementation?.customer_name || "a customer"}.`
                  : `Task “${event.payload.taskTitle || "Implementation task"}” for ${implementation?.customer_name || "a customer"} is now ${event.payload.status || "updated"}${event.payload.isBlocked ? " and blocked" : ""}.`;
          const settings = await database.prepare(`
            SELECT email_enabled FROM product_workspace_notification_settings WHERE workspace_id = $1
          `).get(event.workspace_id);
          if (!event.email_sent_at) {
            if (settings?.email_enabled) {
              const apiKey = process.env.RESEND_API_KEY?.trim();
              const from = process.env.AUTH_EMAIL_FROM?.trim();
              if (!apiKey || !from) throw new Error("Email notifications are enabled but Resend is not configured.");
              const recipientRows = ["customer.escalation", "customer.task_reminder", "team.message"].includes(event.event_type)
                ? [{ email: event.payload.recipientEmail }]
                : event.event_type === "task.reminder" && event.payload.assignedUserId
                ? await database.prepare(`
                  SELECT email FROM product_users WHERE id = $1
                `).all(event.payload.assignedUserId)
                : await database.prepare(`
                  SELECT u.email FROM product_memberships m
                  JOIN product_users u ON u.id = m.user_id WHERE m.workspace_id = $1
                `).all(event.workspace_id);
              if (recipientRows.length) {
                const emailUrl = process.env.NODE_ENV === "test" && process.env.AUTH_EMAIL_API_URL
                  ? process.env.AUTH_EMAIL_API_URL
                  : "https://api.resend.com/emails";
                const response = await fetch(emailUrl, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    from,
                    to: recipientRows.map((row) => row.email),
                    subject: event.event_type === "customer.escalation"
                      ? `Relay follow-up needed: ${event.payload.customerName}`
                      : event.event_type === "customer.task_reminder"
                        ? `Onboarding task due: ${event.payload.customerName}`
                        : event.event_type === "team.message"
                          ? `Your implementation team replied`
                      : `Relay update: ${event.payload.taskTitle || implementation?.customer_name || "customer implementation"}`,
                    text: event.event_type === "customer.escalation"
                      ? `${message}\n\nPlease contact the implementation team if you can help move this forward.`
                      : ["customer.task_reminder", "team.message"].includes(event.event_type)
                        ? `${message}\n\nIf you cannot access your portal link, reply to your implementation team and they can send a new one.`
                      : `${message}\n\nOpen your Relay workspace to review the next steps.`
                  }),
                  signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
              }
            }
            await database.prepare(
              "UPDATE product_workspace_events SET email_sent_at = CURRENT_TIMESTAMP WHERE id = $1"
            ).run(event.id);
          }

          const integrations = await database.prepare(`
            SELECT provider, access_token_cipher, refresh_token_cipher, webhook_url_cipher,
              token_expires_at
            FROM product_workspace_integrations WHERE workspace_id = $1
          `).all(event.workspace_id);
          const hubspot = integrations.find((item) => item.provider === "hubspot");
          if (!event.hubspot_synced_at) {
            if (hubspot && implementation) {
              let accessToken = decryptIntegrationValue(hubspot.access_token_cipher);
              if (hubspot.token_expires_at && Date.parse(hubspot.token_expires_at) <= Date.now()) {
                if (!hubspot.refresh_token_cipher) throw new Error("HubSpot authorization expired. Reconnect HubSpot.");
                const refreshResponse = await fetch("https://api.hubapi.com/oauth/v3/token", {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                    grant_type: "refresh_token",
                    client_id: process.env.HUBSPOT_CLIENT_ID || "",
                    client_secret: process.env.HUBSPOT_CLIENT_SECRET || "",
                    refresh_token: decryptIntegrationValue(hubspot.refresh_token_cipher)
                  }),
                  signal: AbortSignal.timeout(10000)
                });
                const refreshed = await refreshResponse.json().catch(() => ({}));
                if (!refreshResponse.ok || !refreshed.access_token) throw new Error("HubSpot authorization could not be refreshed.");
                accessToken = refreshed.access_token;
                await database.prepare(`
                  UPDATE product_workspace_integrations SET access_token_cipher = $1,
                    token_expires_at = $2, updated_at = CURRENT_TIMESTAMP
                  WHERE workspace_id = $3 AND provider = 'hubspot'
                `).run(encryptIntegrationValue(accessToken),
                  new Date(Date.now() + refreshed.expires_in * 1000).toISOString(), event.workspace_id);
              }
              const deal = await database.prepare(`
                SELECT deal_id FROM product_hubspot_implementation_links
                WHERE implementation_id = $1 AND workspace_id = $2
              `).get(event.implementation_id, event.workspace_id);
              const properties = {
                dealname: `${implementation.customer_name} onboarding`,
                description: `Relay implementation: ${implementation.completed_tasks}/${implementation.total_tasks} tasks complete; ${implementation.overdue_tasks} overdue; ${implementation.blocked_tasks} blocked.`
              };
              const dealResponse = await fetch(deal
                ? `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(deal.deal_id)}`
                : "https://api.hubapi.com/crm/v3/objects/deals", {
                method: deal ? "PATCH" : "POST",
                headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ properties }),
                signal: AbortSignal.timeout(10000)
              });
              const dealResult = dealResponse.status === 204 ? {} : await dealResponse.json().catch(() => ({}));
              if (!dealResponse.ok || (!deal && !dealResult.id)) throw new Error(`HubSpot CRM returned HTTP ${dealResponse.status}.`);
              if (!deal) {
                await database.prepare(`
                  INSERT INTO product_hubspot_implementation_links (implementation_id, workspace_id, deal_id)
                  VALUES ($1, $2, $3)
                  ON CONFLICT (implementation_id) DO UPDATE SET deal_id = excluded.deal_id,
                    workspace_id = excluded.workspace_id, updated_at = CURRENT_TIMESTAMP
                `).run(event.implementation_id, event.workspace_id, String(dealResult.id));
              }
            }
            await database.prepare(
              "UPDATE product_workspace_events SET hubspot_synced_at = CURRENT_TIMESTAMP WHERE id = $1"
            ).run(event.id);
          }
          await database.prepare(`
            UPDATE product_workspace_events
            SET status = 'sent', processed_at = CURRENT_TIMESTAMP, attempts = attempts + 1
            WHERE id = $1
          `).run(event.id);
          processed += 1;
        } catch (error) {
          failures += 1;
          const nextAttempt = event.attempts + 1;
          const retrySeconds = Math.min(3600, 60 * (2 ** Math.min(nextAttempt, 6)));
          await database.prepare(`
            UPDATE product_workspace_events SET
              status = CASE WHEN $2 >= 5 THEN 'failed' ELSE 'pending' END,
              attempts = $2, available_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
              processed_at = CASE WHEN $2 >= 5 THEN CURRENT_TIMESTAMP ELSE NULL END
            WHERE id = $1
          `).run(event.id, nextAttempt, retrySeconds);
          console.error(JSON.stringify({
            event: "workspace_event_delivery_failed",
            event_id: event.id,
            event_type: event.event_type,
            attempt: nextAttempt,
            message: error.message
          }));
        }
      }
      return res.json({
        processed,
        failures,
        remindersQueued: reminders.length + customerTaskReminders.length,
        hubspotImportsCreated,
        hubspotImportFailures
      });
    });

  app.get("/api/product/portfolio.csv", requireSession, async (req, res) => {
      const rows = await database.prepare(`
        SELECT i.customer_name, t.name AS template_name, i.created_at,
          COUNT(s.id) AS total_tasks,
          COUNT(s.id) FILTER (WHERE s.status = 'done') AS completed_tasks,
          COUNT(s.id) FILTER (WHERE s.status != 'done' AND s.due_at != '' AND s.due_at < CURRENT_DATE::text) AS overdue_tasks,
          COUNT(s.id) FILTER (WHERE s.status != 'done' AND s.is_blocked) AS blocked_tasks
        FROM product_implementations i
        JOIN product_templates t ON t.id = i.template_id
        LEFT JOIN product_implementation_steps s ON s.implementation_id = i.id
        WHERE i.workspace_id = $1
        GROUP BY i.id, t.name
        ORDER BY i.created_at DESC, i.id DESC
      `).all(req.product.workspaceId);
      const quote = (value) => {
        let text = String(value ?? "");
        if (/^[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replaceAll('"', '""')}"`;
      };
      const csv = [
        ["Customer", "Template", "Started", "Total tasks", "Completed tasks", "Overdue tasks", "Blocked tasks"],
        ...rows.map((row) => [row.customer_name, row.template_name, row.created_at, row.total_tasks,
          row.completed_tasks, row.overdue_tasks, row.blocked_tasks])
      ].map((row) => row.map(quote).join(",")).join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="relay-implementation-portfolio.csv"');
      res.setHeader("Cache-Control", "no-store");
      return res.send(csv);
    });

  app.post("/api/product/invites", sameOrigin, requireSession, async (req, res) => {
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can invite teammates.");
    const email = requiredText(req.body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "Enter a valid teammate email address.");
    const existingUser = await (database.prepare("SELECT id FROM product_users WHERE email = $1").get(email));
    if (existingUser && await (database.prepare(
      "SELECT 1 FROM product_memberships WHERE workspace_id = $1 AND user_id = $2"
    ).get(req.product.workspaceId, existingUser.id))) {
      return sendError(res, 409, "This account is already a member of your workspace.");
    }
    const activeInvite = await (database.prepare(`
      SELECT id FROM product_workspace_invites
      WHERE workspace_id = $1 AND invited_email = $2 AND accepted_at IS NULL AND expires_at > $3
    `).get(req.product.workspaceId, email, new Date().toISOString()));
    if (activeInvite) return sendError(res, 409, "An active invitation already exists for this email.");
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const invite = await database.transaction(async () => {
      const plan = await lockWorkspace(req.product.workspaceId);
      const seatCount = (await database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM product_memberships WHERE workspace_id = $1) +
          (SELECT COUNT(*) FROM product_workspace_invites
            WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP) AS count
      `).get(req.product.workspaceId)).count;
      if (plan.memberLimit !== null && seatCount >= plan.memberLimit) {
        return { error: "No team seats are available. Cancel a pending invitation or upgrade this workspace." };
      }
      const duplicate = await database.prepare(`
        SELECT id FROM product_workspace_invites
        WHERE workspace_id = $1 AND invited_email = $2 AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      `).get(req.product.workspaceId, email);
      if (duplicate) return { error: "An active invitation already exists for this email." };
      return database.prepare(`
        INSERT INTO product_workspace_invites (workspace_id, invited_email, token_hash, expires_at, created_by)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `).get(req.product.workspaceId, email, hashToken(rawToken), expiresAt, req.product.userId);
    });
    if (invite.error) return sendError(res, 409, invite.error);
    const inviteUrl = new URL(`/product.html?invite=${encodeURIComponent(rawToken)}`, req.get("Origin")).toString();
    return res.status(201).json({ invite: { id: invite.id, email, expiresAt, inviteUrl } });
  });

  app.delete("/api/product/invites/:inviteId", sameOrigin, requireSession, async (req, res) => {
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can revoke invitations.");
    const inviteId = validId(req.params.inviteId);
    if (!inviteId) return sendError(res, 400, "Invalid invitation.");
    const result = await (database.prepare(
      "DELETE FROM product_workspace_invites WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL"
    ).run(inviteId, req.product.workspaceId));
    if (!result.changes) return sendError(res, 404, "Invitation not found or already accepted.");
    return res.json({ success: true });
  });

  app.post("/api/product/processes", sameOrigin, requireSession, async (req, res) => {
    const name = requiredText(req.body.name, 100);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    if (!name) return sendError(res, 400, "Give this onboarding process a name.");
    const process = await (database.prepare(
      "INSERT INTO product_processes (workspace_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description, updated_at"
    ).get(req.product.workspaceId, name, description));
    return res.status(201).json({ process });
  });

  app.patch("/api/product/processes/:processId", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    const name = requiredText(req.body.name, 100);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    if (!processId || !name) return sendError(res, 400, "Give this onboarding process a valid name.");
    const result = await (database.prepare(`
      UPDATE product_processes SET name = $1, description = $2, revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND workspace_id = $4
    `).run(name, description, processId, req.product.workspaceId));
    if (!result.changes) return sendError(res, 404, "Process not found.");
    return res.json({ success: true });
  });

  app.delete("/api/product/processes/:processId", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    if (!processId) return sendError(res, 400, "Invalid process.");
    const process = await (database.prepare(
      "SELECT id FROM product_processes WHERE id = $1 AND workspace_id = $2"
    ).get(processId, req.product.workspaceId));
    if (!process) return sendError(res, 404, "Process not found.");
    const templateCount = (await database.prepare(
      "SELECT COUNT(*) AS count FROM product_templates WHERE process_id = $1"
    ).get(processId)).count;
    if (templateCount) return sendError(res, 409, "This process is used by saved templates. Delete unused templates before deleting the process.");
    await (database.prepare("DELETE FROM product_processes WHERE id = $1").run(processId));
    return res.json({ success: true });
  });

  app.get("/api/product/processes/:processId", requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    if (!processId) return sendError(res, 400, "Invalid process.");
    const process = await (database.prepare(`
      SELECT p.id, p.name, p.description, p.revision, p.updated_at,
        EXISTS (
          SELECT 1 FROM product_setup_checks c
          WHERE c.process_id = p.id AND c.process_revision = p.revision AND c.result = 'ready'
        ) AS checked
      FROM product_processes p
      WHERE p.id = $1 AND p.workspace_id = $2
    `).get(processId, req.product.workspaceId));
    if (!process) return sendError(res, 404, "Process not found.");
    process.steps = await (processSteps(processId));
    return res.json({ process });
  });

  app.post("/api/product/processes/:processId/steps", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    const title = requiredText(req.body.title, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const owner = typeof req.body.owner === "string" ? req.body.owner.trim().slice(0, 120) : "";
    const stage = requiredText(req.body.stage || "Implementation", 100);
    const dueOffsetDays = req.body.dueOffsetDays === undefined ? 0 : req.body.dueOffsetDays;
    const assignee = await (workspaceAssignee(req.product.workspaceId, req.body.assigneeUserId));
    const dependsOn = Array.isArray(req.body.dependsOn) ? req.body.dependsOn.map(validId) : [];
    if (dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length) {
      return sendError(res, 400, "Choose valid, unique prerequisite steps.");
    }
    if (!processId || !title || !stage || !assignee.valid || !Number.isInteger(dueOffsetDays) || dueOffsetDays < 0 || dueOffsetDays > 3650
      || (req.body.customerVisible !== undefined && typeof req.body.customerVisible !== "boolean")) {
      return sendError(res, 400, "Enter a step name, stage, and valid due-date offset.");
    }
    if (dependsOn.length && !requirePlanFeature(req, res, "dependencies", "Task prerequisites")) return;
    const process = await (database.prepare(
      "SELECT id FROM product_processes WHERE id = $1 AND workspace_id = $2"
    ).get(processId, req.product.workspaceId));
    if (!process) return sendError(res, 404, "Process not found.");
    const existingSteps = await (processSteps(processId));
    if (dependsOn.some((id) => !existingSteps.some((step) => step.id === id))) {
      return sendError(res, 400, "A prerequisite must be another step in this process.");
    }
    const step = await database.transaction(async () => {
      const position = (await database.prepare(
        "SELECT COALESCE(MAX(position), 0) + 1 AS position FROM product_process_steps WHERE process_id = $1"
      ).get(processId)).position;
      const step = await (database.prepare(`
        INSERT INTO product_process_steps
            (process_id, title, description, owner, position, stage, due_offset_days, assignee_user_id, customer_visible)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, title, description, owner, position, stage, due_offset_days, assignee_user_id, customer_visible
        `).get(processId, title, description, owner, position, stage, dueOffsetDays, assignee.id, req.body.customerVisible === true));
      const addDependency = database.prepare(
        "INSERT INTO product_process_step_dependencies (process_step_id, depends_on_step_id) VALUES ($1, $2)"
      );
      for (const dependencyId of dependsOn) await (addDependency.run(step.id, dependencyId));
      await (database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1").run(processId));
      return step;
    });
    return res.status(201).json({ step });
  });

  app.patch("/api/product/processes/:processId/steps/:stepId", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    const stepId = validId(req.params.stepId);
    const title = requiredText(req.body.title, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const owner = typeof req.body.owner === "string" ? req.body.owner.trim().slice(0, 120) : "";
    const stage = requiredText(req.body.stage, 100);
    const dueOffsetDays = req.body.dueOffsetDays;
    const assignee = await (workspaceAssignee(req.product.workspaceId, req.body.assigneeUserId));
    const dependsOn = Array.isArray(req.body.dependsOn) ? req.body.dependsOn.map(validId) : null;
    if (!processId || !stepId || !title || !stage || !Number.isInteger(dueOffsetDays)
      || dueOffsetDays < 0 || dueOffsetDays > 3650 || !dependsOn
      || dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length || !assignee.valid
      || (req.body.customerVisible !== undefined && typeof req.body.customerVisible !== "boolean")
      || dependsOn.includes(stepId)) {
      return sendError(res, 400, "Enter valid step details and prerequisites.");
    }
    const steps = await (processSteps(processId));
    const step = steps.find((item) => item.id === stepId);
    if (!step || !await (database.prepare("SELECT id FROM product_processes WHERE id = $1 AND workspace_id = $2").get(processId, req.product.workspaceId))) {
      return sendError(res, 404, "Process step not found.");
    }
    const unchangedDependencies = step.dependsOn.length === dependsOn.length
      && step.dependsOn.every((id) => dependsOn.includes(id));
    if (!unchangedDependencies && dependsOn.length
      && !requirePlanFeature(req, res, "dependencies", "Task prerequisites")) return;
    if (dependsOn.some((id) => !steps.some((item) => item.id === id))) {
      return sendError(res, 400, "A prerequisite must be another step in this process.");
    }
    const proposed = steps.map((item) => ({
      ...item,
      dependsOn: item.id === stepId ? dependsOn : item.dependsOn
    }));
    if (hasCycle(proposed)) return sendError(res, 400, "Prerequisites cannot form a cycle.");
    const customerVisible = req.body.customerVisible === undefined ? Boolean(step.customer_visible) : req.body.customerVisible;
    await database.transaction(async () => {
      await (database.prepare(`
        UPDATE product_process_steps SET title = $1, description = $2, owner = $3, stage = $4,
          due_offset_days = $5, assignee_user_id = $6, customer_visible = $7
        WHERE id = $8 AND process_id = $9
      `).run(title, description, owner, stage, dueOffsetDays, assignee.id, customerVisible, stepId, processId));
      await (database.prepare("DELETE FROM product_process_step_dependencies WHERE process_step_id = $1").run(stepId));
      const addDependency = database.prepare(
        "INSERT INTO product_process_step_dependencies (process_step_id, depends_on_step_id) VALUES ($1, $2)"
      );
      for (const dependencyId of dependsOn) await (addDependency.run(stepId, dependencyId));
      await (database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1").run(processId));
    });
    return res.json({ success: true });
  });

  app.delete("/api/product/processes/:processId/steps/:stepId", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    const stepId = validId(req.params.stepId);
    if (!processId || !stepId) return sendError(res, 400, "Invalid process step.");
    const process = await (database.prepare(
      "SELECT id FROM product_processes WHERE id = $1 AND workspace_id = $2"
    ).get(processId, req.product.workspaceId));
    if (!process) return sendError(res, 404, "Process not found.");
    const removed = await database.transaction(async () => {
      const removed = await (database.prepare("DELETE FROM product_process_steps WHERE id = $1 AND process_id = $2").run(stepId, processId));
      if (!removed.changes) return false;
      const remaining = await (database.prepare("SELECT id FROM product_process_steps WHERE process_id = $1 ORDER BY position, id").all(processId));
      const setPosition = database.prepare("UPDATE product_process_steps SET position = $1 WHERE id = $2");
      for (const [index, item] of remaining.entries()) {
        await setPosition.run(index + 1, item.id);
      }
      await (database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1").run(processId));
      return true;
    });
    if (!removed) return sendError(res, 404, "Process step not found.");
    return res.json({ success: true });
  });

  app.put("/api/product/processes/:processId/steps/order", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    const orderedIds = Array.isArray(req.body.stepIds) ? req.body.stepIds.map(validId) : null;
    if (!processId || !orderedIds || orderedIds.some((id) => !id) || new Set(orderedIds).size !== orderedIds.length) {
      return sendError(res, 400, "Provide the complete ordered list of process steps.");
    }
    if (!await (database.prepare("SELECT id FROM product_processes WHERE id = $1 AND workspace_id = $2").get(processId, req.product.workspaceId))) {
      return sendError(res, 404, "Process not found.");
    }
    const steps = await (processSteps(processId));
    if (steps.length !== orderedIds.length || steps.some((step) => !orderedIds.includes(step.id))) {
      return sendError(res, 400, "The ordered list must contain every process step exactly once.");
    }
    const positions = new Map(orderedIds.map((id, index) => [id, index + 1]));
    for (const step of steps) {
      if (step.dependsOn.some((dependencyId) => positions.get(dependencyId) >= positions.get(step.id))) {
        return sendError(res, 400, "A prerequisite must appear before the step that depends on it.");
      }
    }
    await database.transaction(async () => {
      const updatePosition = database.prepare("UPDATE product_process_steps SET position = $1 WHERE id = $2 AND process_id = $3");
      for (const [id, position] of positions) await (updatePosition.run(position, id, processId));
      await (database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1").run(processId));
    });
    return res.json({ success: true });
  });

  app.post("/api/product/processes/:processId/test", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.params.processId);
    if (!processId) return sendError(res, 400, "Invalid process.");
    const process = await (database.prepare(
      "SELECT id, revision FROM product_processes WHERE id = $1 AND workspace_id = $2"
    ).get(processId, req.product.workspaceId));
    if (!process) return sendError(res, 404, "Process not found.");
    const steps = await (processSteps(processId));
    const findings = [];
    if (steps.length === 0) findings.push("Add at least one step before testing this process or saving it as a template. One step is enough to start.");
    steps.forEach((step, index) => {
      if (!step.description) findings.push(`Step ${index + 1} (“${step.title}”) needs a short instruction.`);
      if (!step.owner) findings.push(`Step ${index + 1} (“${step.title}”) needs an owner.`);
      if (!step.assignee_user_id) findings.push(`Step ${index + 1} (“${step.title}”) needs an assigned workspace member.`);
      if (step.dependsOn.some((dependencyId) => steps.findIndex((candidate) => candidate.id === dependencyId) >= index)) {
        findings.push(`Step “${step.title}” must appear after its prerequisite steps.`);
      }
    });
    if (hasCycle(steps)) findings.push("Resolve the circular prerequisites before handing over this process.");
    const result = steps.length > 0 && findings.length === 0 ? "ready" : "needs_attention";
    const check = await (database.prepare(
      "INSERT INTO product_setup_checks (workspace_id, process_id, process_revision, result, findings_json) VALUES ($1, $2, $3, $4, $5) RETURNING id, result, created_at"
    ).get(req.product.workspaceId, processId, process.revision, result, JSON.stringify(findings)));
    return res.json({
      check,
      findings,
      stepsChecked: steps.length,
      handover: result === "ready" ? steps.map((step, index) => ({
        number: index + 1,
        title: step.title,
        description: step.description,
        owner: step.owner,
        assigneeUserId: step.assignee_user_id,
        assigneeEmail: step.assignee_email,
        stage: step.stage,
        dueOffsetDays: step.due_offset_days,
        customerVisible: step.customer_visible,
        dependsOn: step.dependsOn.map((id) => steps.find((candidate) => candidate.id === id)?.title).filter(Boolean)
      })) : []
    });
  });

  app.post("/api/product/templates", sameOrigin, requireSession, async (req, res) => {
    const processId = validId(req.body.processId);
    const name = requiredText(req.body.name, 100);
    if (!processId || !name) return sendError(res, 400, "Choose a process and name the reusable template.");
    const process = await (database.prepare(
      "SELECT id, revision FROM product_processes WHERE id = $1 AND workspace_id = $2"
    ).get(processId, req.product.workspaceId));
    if (!process) return sendError(res, 404, "Process not found.");
    const latestCheck = await (database.prepare(`
      SELECT result FROM product_setup_checks
      WHERE process_id = $1 AND process_revision = $2
      ORDER BY id DESC LIMIT 1
    `).get(processId, process.revision));
    if (!latestCheck || latestCheck.result !== "ready") {
      return sendError(res, 409, "Run a successful setup check for the current process before saving a reusable template.");
    }
    const steps = await (processSteps(processId));
    if (steps.length === 0) return sendError(res, 400, "Add at least one process step before saving a template.");
    const stepPositions = new Map(steps.map((step) => [step.id, step.position]));
    const snapshot = steps.map((step) => ({
      title: step.title,
      description: step.description,
      owner: step.owner,
      assigneeUserId: step.assignee_user_id,
      assigneeEmail: step.assignee_email,
      stage: step.stage,
      dueOffsetDays: step.due_offset_days,
      customerVisible: step.customer_visible,
      position: step.position,
      dependsOnPositions: step.dependsOn.map((id) => stepPositions.get(id)).filter(Number.isInteger)
    }));
    if (snapshot.some((step) => step.dependsOnPositions.length)
      && !requirePlanFeature(req, res, "dependencies", "Task prerequisites")) return;
    const template = await database.transaction(async () => {
      const plan = await lockWorkspace(req.product.workspaceId);
      const count = (await database.prepare(
        "SELECT COUNT(*) AS count FROM product_templates WHERE workspace_id = $1"
      ).get(req.product.workspaceId)).count;
      if (plan.templateLimit !== null && count >= plan.templateLimit) {
        return null;
      }
      const template = await (database.prepare(
        "INSERT INTO product_templates (workspace_id, process_id, name, steps_json, updated_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING id, name, created_at, revision"
      ).get(req.product.workspaceId, processId, name, JSON.stringify(snapshot)));
      if (plan.features.templateHistory) {
        await (database.prepare(
          "INSERT INTO product_template_versions (template_id, revision, name, steps_json) VALUES ($1, $2, $3, $4)"
        ).run(template.id, template.revision, template.name, JSON.stringify(snapshot)));
      }
      return template;
    });
    if (!template) return sendError(res, 409, "This workspace has reached its template limit. Upgrade the plan or remove an unused template.");
    return res.status(201).json({ template });
  });

  app.get("/api/product/templates/:templateId/versions", requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "templateHistory", "Template revision history")) return;
    const templateId = validId(req.params.templateId);
    if (!templateId) return sendError(res, 400, "Invalid template.");
    const template = await (database.prepare(
      "SELECT id FROM product_templates WHERE id = $1 AND workspace_id = $2"
    ).get(templateId, req.product.workspaceId));
    if (!template) return sendError(res, 404, "Template not found.");
    const versions = (await database.prepare(`
      SELECT revision, name, steps_json, created_at
      FROM product_template_versions
      WHERE template_id = $1
      ORDER BY revision DESC
    `).all(templateId)).map((version) => ({
      revision: version.revision,
      name: version.name,
      created_at: version.created_at,
      steps: JSON.parse(version.steps_json).map((step) => step.title)
    }));
    return res.json({ versions });
  });

  app.post("/api/product/templates/:templateId/versions/:revision/restore", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "templateHistory", "Template revision restore")) return;
    const templateId = validId(req.params.templateId);
    const revision = validId(req.params.revision);
    if (!templateId || !revision) return sendError(res, 400, "Choose a valid template version.");
    const template = await (database.prepare(
      "SELECT id, revision FROM product_templates WHERE id = $1 AND workspace_id = $2"
    ).get(templateId, req.product.workspaceId));
    if (!template) return sendError(res, 404, "Template not found.");
    const version = await (database.prepare(`
      SELECT name, steps_json FROM product_template_versions
      WHERE template_id = $1 AND revision = $2
    `).get(templateId, revision));
    if (!version) return sendError(res, 404, "Template version not found.");
    await database.transaction(async () => {
      const nextRevision = template.revision + 1;
      await (database.prepare(`
        UPDATE product_templates SET name = $1, steps_json = $2, revision = $3,
          updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND workspace_id = $5
      `).run(version.name, version.steps_json, nextRevision, templateId, req.product.workspaceId));
      await (database.prepare(
        "INSERT INTO product_template_versions (template_id, revision, name, steps_json) VALUES ($1, $2, $3, $4)"
      ).run(templateId, nextRevision, version.name, version.steps_json));
    });
    return res.json({ success: true });
  });

  app.patch("/api/product/templates/:templateId", sameOrigin, requireSession, async (req, res) => {
    const templateId = validId(req.params.templateId);
    const name = requiredText(req.body.name, 100);
    const refreshFromProcess = req.body.refreshFromProcess === true;
    if (!templateId || !name) return sendError(res, 400, "Give this reusable template a valid name.");
    const template = await (database.prepare(
      "SELECT id, process_id, revision, steps_json FROM product_templates WHERE id = $1 AND workspace_id = $2"
    ).get(templateId, req.product.workspaceId));
    if (!template) return sendError(res, 404, "Template not found.");
    let stepsJson;
    if (refreshFromProcess) {
      const process = await (database.prepare(
        "SELECT id, revision FROM product_processes WHERE id = $1 AND workspace_id = $2"
      ).get(template.process_id, req.product.workspaceId));
      const latestCheck = await (database.prepare(`
        SELECT result FROM product_setup_checks
        WHERE process_id = $1 AND process_revision = $2
        ORDER BY id DESC LIMIT 1
      `).get(template.process_id, process.revision));
      if (!latestCheck || latestCheck.result !== "ready") {
        return sendError(res, 409, "Run a successful setup check for the current process before refreshing this template.");
      }
      const steps = await (processSteps(template.process_id));
      if (steps.some((step) => step.dependsOn.length)
        && !requirePlanFeature(req, res, "dependencies", "Task prerequisites")) return;
      const positions = new Map(steps.map((step) => [step.id, step.position]));
      stepsJson = JSON.stringify(steps.map((step) => ({
        title: step.title,
        description: step.description,
        owner: step.owner,
        assigneeUserId: step.assignee_user_id,
        assigneeEmail: step.assignee_email,
        stage: step.stage,
        dueOffsetDays: step.due_offset_days,
        position: step.position,
        dependsOnPositions: step.dependsOn.map((id) => positions.get(id)).filter(Number.isInteger)
      })));
    }
    const nextStepsJson = stepsJson === undefined ? template.steps_json : stepsJson;
    const nextRevision = template.revision + 1;
    await database.transaction(async () => {
      await (database.prepare(`
        UPDATE product_templates SET name = $1, steps_json = $2, revision = $3,
          updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND workspace_id = $5
      `).run(name, nextStepsJson, nextRevision, templateId, req.product.workspaceId));
      if (req.product.planDetails.features.templateHistory) {
        await (database.prepare(
          "INSERT INTO product_template_versions (template_id, revision, name, steps_json) VALUES ($1, $2, $3, $4)"
        ).run(templateId, nextRevision, name, nextStepsJson));
      }
    });
    return res.json({ success: true });
  });

  app.delete("/api/product/templates/:templateId", sameOrigin, requireSession, async (req, res) => {
    const templateId = validId(req.params.templateId);
    if (!templateId) return sendError(res, 400, "Invalid template.");
    const hubspotHandoff = await database.prepare(`
      SELECT 1 AS configured FROM product_workspace_integrations
      WHERE workspace_id = $1 AND provider = 'hubspot' AND hubspot_onboarding_template_id = $2
    `).get(req.product.workspaceId, templateId);
    if (hubspotHandoff) {
      return sendError(res, 409, "This template is selected for HubSpot onboarding. Choose a different handoff template before deleting it.");
    }
    const implementationCount = (await database.prepare(
      "SELECT COUNT(*) AS count FROM product_implementations WHERE template_id = $1 AND workspace_id = $2"
    ).get(templateId, req.product.workspaceId)).count;
    if (implementationCount) return sendError(res, 409, "This template is used by existing implementations and cannot be deleted.");
    const result = await (database.prepare(
      "DELETE FROM product_templates WHERE id = $1 AND workspace_id = $2"
    ).run(templateId, req.product.workspaceId));
    if (!result.changes) return sendError(res, 404, "Template not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/implementations", sameOrigin, requireSession, async (req, res) => {
    const templateId = validId(req.body.templateId);
    const customerName = requiredText(req.body.customerName, 120);
    const customerOwnerName = typeof req.body.customerOwnerName === "string"
      ? req.body.customerOwnerName.trim().slice(0, 120)
      : "";
    const customerOwnerEmail = typeof req.body.customerOwnerEmail === "string"
      ? req.body.customerOwnerEmail.trim().toLowerCase().slice(0, 254)
      : "";
    const targetLaunchDate = req.body.targetLaunchDate ?? "";
    if (!templateId || !customerName) return sendError(res, 400, "Choose a template and enter the customer’s company name.");
    if ((customerOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerOwnerEmail))
      || (targetLaunchDate !== "" && !validDate(targetLaunchDate))) {
      return sendError(res, 400, "Enter a valid customer contact email and target launch date.");
    }
    const template = await (database.prepare(
      "SELECT id, name, steps_json FROM product_templates WHERE id = $1 AND workspace_id = $2"
    ).get(templateId, req.product.workspaceId));
    if (!template) return sendError(res, 404, "Template not found.");
    const steps = JSON.parse(template.steps_json);
    if (!Array.isArray(steps) || steps.length === 0) return sendError(res, 409, "This template has no steps. Create a new template from a process with steps.");
    if (steps.some((step) => Array.isArray(step.dependsOnPositions) && step.dependsOnPositions.length)
      && !requirePlanFeature(req, res, "dependencies", "Task prerequisites")) return;

    const creation = await createImplementationFromTemplate({
      workspaceId: req.product.workspaceId,
      template,
      customerName,
      customerOwnerName,
      customerOwnerEmail,
      targetLaunchDate
    });
    if (!creation.implementation) return sendError(res, 409, `${creation.error} Complete an implementation or upgrade the plan.`);
    const implementation = creation.implementation;
    let customerInvitation = null;
    if (customerOwnerEmail) {
      const customerToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
      await database.prepare(`
        INSERT INTO product_customer_contacts
          (implementation_id, email, display_name, token_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (implementation_id, email) DO UPDATE SET
          display_name = excluded.display_name, token_hash = excluded.token_hash,
          expires_at = excluded.expires_at, invitation_sent_at = NULL,
          revoked_at = NULL, last_activity_at = CURRENT_TIMESTAMP
      `).run(implementation.id, customerOwnerEmail, customerOwnerName, hashToken(customerToken), expiresAt);
      customerInvitation = await sendCustomerContactInvitation({
        req,
        implementation,
        contactEmail: customerOwnerEmail,
        contactName: customerOwnerName,
        token: customerToken
      });
      if (customerInvitation.sent) {
        await database.prepare(`
          UPDATE product_customer_contacts SET invitation_sent_at = CURRENT_TIMESTAMP
          WHERE implementation_id = $1 AND email = $2
        `).run(implementation.id, customerOwnerEmail);
      }
    }
    return res.status(201).json({
      implementation,
      customerInvitation: customerInvitation && {
        sent: customerInvitation.sent,
        ...(customerInvitation.link ? { link: customerInvitation.link } : {}),
        ...(customerInvitation.error ? { message: customerInvitation.error } : {})
      }
    });
  });

  app.post("/api/product/implementations/:implementationId/customer-link", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const implementation = await (database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2"
    ).get(implementationId, req.product.workspaceId));
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const rawToken = randomBytes(32).toString("base64url");
    await (database.prepare("UPDATE product_implementations SET portal_token_hash = $1 WHERE id = $2")
      .run(hashToken(rawToken), implementationId));
    return res.json({ customerPortalToken: rawToken });
  });

  app.get("/api/product/implementations/:implementationId", requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const implementation = await (database.prepare(`
      SELECT i.id, i.customer_name, i.created_at, i.template_id, i.escalation_email,
        i.escalation_delay_days, i.target_launch_date, i.customer_owner_name, i.customer_owner_email,
        i.success_criteria, i.acceptance_status, i.test_plan, i.training_status,
        i.support_owner_name, i.support_owner_email, i.rollback_plan, i.go_live_status,
        i.communication_channel, i.communication_cadence, i.communication_owner_name,
        i.communication_owner_email, i.procurement_status, i.security_status, i.security_notes,
        i.integration_inventory, i.integration_status, i.technical_setup_status,
        i.technical_setup_notes, i.change_management_status, i.adoption_notes,
        i.early_validation_status, i.early_validation_notes, i.post_launch_support_plan,
        i.duplicate_request_control,
        i.sow_scope, i.sow_milestones, i.sow_exclusions, i.stage_gate_status,
        t.name AS template_name,
        i.portal_token_hash IS NOT NULL AS has_customer_link
      FROM product_implementations i
      JOIN product_templates t ON t.id = i.template_id
      WHERE i.id = $1 AND i.workspace_id = $2
    `).get(implementationId, req.product.workspaceId));
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    implementation.steps = await (database.prepare(`
      SELECT s.id, s.title, s.description, s.owner, s.position, s.status, s.updated_at, s.stage,
        s.assignee_user_id, s.customer_visible, u.email AS assignee_email,
        s.due_at, s.is_blocked, s.blocker_reason, s.blocker_next_action,
        COALESCE((SELECT string_agg(parent.title, ', ')
          FROM product_implementation_step_dependencies d
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE d.implementation_step_id = s.id AND parent.status != 'done'), '') AS waiting_on
      FROM product_implementation_steps s
      LEFT JOIN product_users u ON u.id = s.assignee_user_id
      WHERE s.implementation_id = $1
      ORDER BY s.position, s.id
    `).all(implementationId));
    implementation.requirements = await (implementationRequirements(implementationId, req.product.workspaceId, implementation.template_id));
    implementation.customerContacts = await database.prepare(`
      SELECT id, email, display_name, expires_at, invitation_sent_at, revoked_at, last_activity_at, created_at
      FROM product_customer_contacts
      WHERE implementation_id = $1
      ORDER BY created_at DESC, id DESC
    `).all(implementationId);
    implementation.customerMessages = await database.prepare(`
      SELECT id, sender_role, sender_name, sender_email, body, created_at
      FROM product_customer_messages WHERE implementation_id = $1
      ORDER BY created_at, id
    `).all(implementationId);
    implementation.customerFiles = await database.prepare(`
      SELECT id, uploaded_by_role, uploaded_by_name, filename, content_type, size_bytes, created_at
      FROM product_customer_files WHERE implementation_id = $1
      ORDER BY created_at DESC, id DESC
    `).all(implementationId);
    implementation.launchStakeholders = await database.prepare(`
      SELECT id, display_name, email, role, approval_status, next_action, created_at
      FROM product_launch_stakeholders WHERE implementation_id = $1
      ORDER BY created_at, id
    `).all(implementationId);
    implementation.launchRisks = await database.prepare(`
      SELECT id, category, title, owner_name, owner_email, severity, status, next_action, due_at, created_at
      FROM product_launch_risks WHERE implementation_id = $1
      ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at DESC, id DESC
    `).all(implementationId);
    implementation.approvals = await database.prepare(`
      SELECT id, title, approval_type, approver_name, approver_email, status, due_at, created_at
      FROM product_approval_requests WHERE implementation_id = $1
      ORDER BY created_at DESC, id DESC
    `).all(implementationId);
    implementation.timeEntries = await database.prepare(`
      SELECT t.id, t.user_id, u.email AS user_email, t.work_date, t.minutes, t.billable, t.note, t.hourly_rate, t.created_at
      FROM product_time_entries t LEFT JOIN product_users u ON u.id = t.user_id
      WHERE t.implementation_id = $1 ORDER BY t.work_date DESC, t.id DESC
    `).all(implementationId);
    implementation.financialPlan = await database.prepare(`
      SELECT budget_amount, forecast_amount, actual_cost, invoice_status, invoice_reference, margin_note, updated_at
      FROM product_financial_plans WHERE implementation_id = $1
    `).get(implementationId) || {
      budget_amount: 0, forecast_amount: 0, actual_cost: 0, invoice_status: "not_started",
      invoice_reference: "", margin_note: ""
    };
    implementation.calendarEvents = await database.prepare(`
      SELECT id, title, start_at, end_at, event_type, external_url, created_at
      FROM product_calendar_events WHERE implementation_id = $1
      ORDER BY start_at, id
    `).all(implementationId);
    return res.json({ implementation });
  });

  app.patch("/api/product/implementations/:implementationId/launch-plan", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const customerOwnerName = typeof req.body.customerOwnerName === "string"
      ? req.body.customerOwnerName.trim().slice(0, 120)
      : null;
    const customerOwnerEmail = typeof req.body.customerOwnerEmail === "string"
      ? req.body.customerOwnerEmail.trim().toLowerCase().slice(0, 254)
      : null;
    const targetLaunchDate = req.body.targetLaunchDate ?? "";
    if (!implementationId || customerOwnerName === null || customerOwnerEmail === null
      || (customerOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerOwnerEmail))
      || (targetLaunchDate !== "" && !validDate(targetLaunchDate))) {
      return sendError(res, 400, "Enter a valid customer owner, email address, and target launch date.");
    }
    const result = await database.prepare(`
      UPDATE product_implementations
      SET customer_owner_name = $1, customer_owner_email = $2, target_launch_date = $3
      WHERE id = $4 AND workspace_id = $5
    `).run(customerOwnerName, customerOwnerEmail, targetLaunchDate, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Implementation not found.");
    return res.json({ customerOwnerName, customerOwnerEmail, targetLaunchDate });
  });

  app.patch("/api/product/implementations/:implementationId/launch-readiness", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const acceptedStatuses = new Set(["not_started", "in_progress", "accepted", "not_accepted"]);
    const trainingStatuses = new Set(["not_started", "scheduled", "in_progress", "complete"]);
    const goLiveStatuses = new Set(["not_ready", "at_risk", "ready", "launched"]);
    const successCriteria = typeof req.body.successCriteria === "string" ? req.body.successCriteria.trim().slice(0, 4000) : null;
    const testPlan = typeof req.body.testPlan === "string" ? req.body.testPlan.trim().slice(0, 4000) : null;
    const rollbackPlan = typeof req.body.rollbackPlan === "string" ? req.body.rollbackPlan.trim().slice(0, 4000) : null;
    const supportOwnerName = typeof req.body.supportOwnerName === "string" ? req.body.supportOwnerName.trim().slice(0, 120) : null;
    const supportOwnerEmail = typeof req.body.supportOwnerEmail === "string" ? req.body.supportOwnerEmail.trim().toLowerCase().slice(0, 254) : null;
    const acceptanceStatus = req.body.acceptanceStatus;
    const trainingStatus = req.body.trainingStatus;
    const goLiveStatus = req.body.goLiveStatus;
    if (!implementationId || successCriteria === null || testPlan === null || rollbackPlan === null
      || supportOwnerName === null || supportOwnerEmail === null
      || !acceptedStatuses.has(acceptanceStatus) || !trainingStatuses.has(trainingStatus)
      || !goLiveStatuses.has(goLiveStatus)
      || (supportOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportOwnerEmail))) {
      return sendError(res, 400, "Enter valid launch-readiness, acceptance, training, support, and go-live details.");
    }
    const result = await database.prepare(`
      UPDATE product_implementations
      SET success_criteria = $1, acceptance_status = $2, test_plan = $3, training_status = $4,
        support_owner_name = $5, support_owner_email = $6, rollback_plan = $7, go_live_status = $8
      WHERE id = $9 AND workspace_id = $10
    `).run(successCriteria, acceptanceStatus, testPlan, trainingStatus, supportOwnerName,
      supportOwnerEmail, rollbackPlan, goLiveStatus, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Implementation not found.");
    return res.json({
      successCriteria, acceptanceStatus, testPlan, trainingStatus,
      supportOwnerName, supportOwnerEmail, rollbackPlan, goLiveStatus
    });
  });

  app.patch("/api/product/implementations/:implementationId/sow", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can update SOW and stage-gate details.");
    const sowScope = typeof req.body.sowScope === "string" ? req.body.sowScope.trim().slice(0, 4000) : "";
    const sowMilestones = typeof req.body.sowMilestones === "string" ? req.body.sowMilestones.trim().slice(0, 4000) : "";
    const sowExclusions = typeof req.body.sowExclusions === "string" ? req.body.sowExclusions.trim().slice(0, 4000) : "";
    const stageGateStatus = ["kickoff", "configuration", "testing", "launch", "hypercare", "complete"].includes(req.body.stageGateStatus)
      ? req.body.stageGateStatus : "kickoff";
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const result = await database.prepare(`
      UPDATE product_implementations
      SET sow_scope = $1, sow_milestones = $2, sow_exclusions = $3, stage_gate_status = $4
      WHERE id = $5 AND workspace_id = $6
    `).run(sowScope, sowMilestones, sowExclusions, stageGateStatus, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Implementation not found.");
    return res.json({ sowScope, sowMilestones, sowExclusions, stageGateStatus });
  });

  app.patch("/api/product/implementations/:implementationId/financial-plan", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can update financial plans.");
    const number = (value) => {
      if (typeof value !== "number" && typeof value !== "string") return null;
      if (typeof value === "string" && value.trim() === "") return 0;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000000000000) return null;
      return parsed;
    };
    const budgetAmount = number(req.body.budgetAmount);
    const forecastAmount = number(req.body.forecastAmount);
    const actualCost = number(req.body.actualCost);
    const invoiceStatus = ["not_started", "draft", "sent", "paid", "overdue"].includes(req.body.invoiceStatus)
      ? req.body.invoiceStatus : "not_started";
    const invoiceReference = typeof req.body.invoiceReference === "string" ? req.body.invoiceReference.trim().slice(0, 120) : "";
    const marginNote = typeof req.body.marginNote === "string" ? req.body.marginNote.trim().slice(0, 4000) : "";
    if (!implementationId || budgetAmount === null || forecastAmount === null || actualCost === null) {
      return sendError(res, 400, "Enter valid non-negative financial amounts.");
    }
    const implementation = await database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2"
    ).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    await database.prepare(`
      INSERT INTO product_financial_plans
        (implementation_id, budget_amount, forecast_amount, actual_cost, invoice_status, invoice_reference, margin_note)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (implementation_id) DO UPDATE SET
        budget_amount = excluded.budget_amount, forecast_amount = excluded.forecast_amount,
        actual_cost = excluded.actual_cost, invoice_status = excluded.invoice_status,
        invoice_reference = excluded.invoice_reference, margin_note = excluded.margin_note,
        updated_at = CURRENT_TIMESTAMP
    `).run(implementationId, budgetAmount, forecastAmount, actualCost, invoiceStatus, invoiceReference, marginNote);
    return res.json({ budgetAmount, forecastAmount, actualCost, invoiceStatus, invoiceReference, marginNote });
  });

  app.post("/api/product/implementations/:implementationId/time-entries", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const minutes = Number(req.body.minutes);
    const workDate = req.body.workDate ?? "";
    const billable = typeof req.body.billable === "boolean" ? req.body.billable : true;
    const note = typeof req.body.note === "string" ? req.body.note.trim().slice(0, 500) : "";
    const hourlyRate = Number.isFinite(Number(req.body.hourlyRate))
      ? Math.min(1000000, Math.max(0, Number(req.body.hourlyRate))) : 0;
    if (!implementationId || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440
      || !validDate(workDate)) return sendError(res, 400, "Enter a valid work date and time entry.");
    const implementation = await database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2"
    ).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const entry = await database.prepare(`
      INSERT INTO product_time_entries
        (implementation_id, user_id, work_date, minutes, billable, note, hourly_rate)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, implementation_id, user_id, work_date, minutes, billable, note, hourly_rate, created_at
    `).get(implementationId, req.product.userId, workDate, minutes, billable, note, hourlyRate);
    return res.status(201).json({ entry });
  });

  app.delete("/api/product/implementations/:implementationId/time-entries/:entryId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const entryId = validId(req.params.entryId);
    if (!implementationId || !entryId) return sendError(res, 400, "Invalid time entry.");
    const result = await database.prepare(`
      DELETE FROM product_time_entries t
      USING product_implementations i
      WHERE t.id = $1 AND t.implementation_id = $2
        AND i.id = t.implementation_id AND i.workspace_id = $3
    `).run(entryId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Time entry not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/implementations/:implementationId/approvals", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const title = requiredText(req.body.title, 240);
    const approvalType = typeof req.body.approvalType === "string" ? req.body.approvalType.trim().slice(0, 80) : "other";
    const approverName = typeof req.body.approverName === "string" ? req.body.approverName.trim().slice(0, 120) : "";
    const approverEmail = typeof req.body.approverEmail === "string" ? req.body.approverEmail.trim().toLowerCase().slice(0, 254) : "";
    const dueAt = req.body.dueAt ?? "";
    if (!implementationId || !title || (approverEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(approverEmail))
      || (dueAt !== "" && !validDate(dueAt))) return sendError(res, 400, "Enter a valid approval and approver.");
    const implementation = await database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2"
    ).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const approval = await database.prepare(`
      INSERT INTO product_approval_requests
        (implementation_id, title, approval_type, approver_name, approver_email, status, due_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', $6)
      RETURNING id, title, approval_type, approver_name, approver_email, status, due_at, created_at
    `).get(implementationId, title, approvalType, approverName, approverEmail, dueAt);
    return res.status(201).json({ approval });
  });

  app.patch("/api/product/implementations/:implementationId/approvals/:approvalId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const approvalId = validId(req.params.approvalId);
    const status = ["pending", "approved", "rejected"].includes(req.body.status) ? req.body.status : "";
    if (!implementationId || !approvalId || !status) return sendError(res, 400, "Choose a valid approval status.");
    const result = await database.prepare(`
      UPDATE product_approval_requests a
      SET status = $1
      FROM product_implementations i
      WHERE a.id = $2 AND a.implementation_id = $3
        AND i.id = a.implementation_id AND i.workspace_id = $4
    `).run(status, approvalId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Approval not found.");
    return res.json({ success: true, status });
  });

  app.delete("/api/product/implementations/:implementationId/approvals/:approvalId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const approvalId = validId(req.params.approvalId);
    if (!implementationId || !approvalId) return sendError(res, 400, "Invalid approval.");
    const result = await database.prepare(`
      DELETE FROM product_approval_requests a
      USING product_implementations i
      WHERE a.id = $1 AND a.implementation_id = $2
        AND i.id = a.implementation_id AND i.workspace_id = $3
    `).run(approvalId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Approval not found.");
    return res.json({ success: true });
  });

  app.patch("/api/product/implementations/:implementationId/onboarding-gap-plan", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const textFields = [
      "communicationChannel", "communicationCadence", "communicationOwnerName", "communicationOwnerEmail",
      "securityNotes", "integrationInventory", "integrationStatus", "technicalSetupNotes",
      "adoptionNotes", "earlyValidationNotes", "postLaunchSupportPlan", "duplicateRequestControl"
    ];
    const normalized = {};
    for (const field of textFields) {
      normalized[field] = typeof req.body[field] === "string" ? req.body[field].trim().slice(0, 4000) : null;
    }
    const procurementStatus = req.body.procurementStatus;
    const securityStatus = req.body.securityStatus;
    const technicalSetupStatus = req.body.technicalSetupStatus;
    const changeManagementStatus = req.body.changeManagementStatus;
    const earlyValidationStatus = req.body.earlyValidationStatus;
    const integrationStatus = req.body.integrationStatus;
    if (!implementationId || Object.values(normalized).includes(null)
      || !["not_started", "in_progress", "approved", "blocked"].includes(procurementStatus)
      || !["not_started", "in_progress", "approved", "blocked"].includes(securityStatus)
      || !["not_started", "discovering", "in_progress", "tested", "blocked"].includes(integrationStatus)
      || !["not_started", "in_progress", "tested", "ready", "blocked"].includes(technicalSetupStatus)
      || !["not_started", "planned", "in_progress", "adopted"].includes(changeManagementStatus)
      || !["not_started", "planned", "in_progress", "passed", "failed"].includes(earlyValidationStatus)
      || (normalized.communicationOwnerEmail
        && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.communicationOwnerEmail))) {
      return sendError(res, 400, "Enter valid communication, approval, security, integration, setup, adoption, and validation details.");
    }
    const result = await database.prepare(`
      UPDATE product_implementations SET
        communication_channel = $1, communication_cadence = $2,
        communication_owner_name = $3, communication_owner_email = $4,
        procurement_status = $5, security_status = $6, security_notes = $7,
        integration_inventory = $8, integration_status = $9,
        technical_setup_status = $10, technical_setup_notes = $11,
        change_management_status = $12, adoption_notes = $13,
        early_validation_status = $14, early_validation_notes = $15,
        post_launch_support_plan = $16, duplicate_request_control = $17
      WHERE id = $18 AND workspace_id = $19
    `).run(
      normalized.communicationChannel, normalized.communicationCadence,
      normalized.communicationOwnerName, normalized.communicationOwnerEmail,
      procurementStatus, securityStatus, normalized.securityNotes,
      normalized.integrationInventory, integrationStatus,
      technicalSetupStatus, normalized.technicalSetupNotes,
      changeManagementStatus, normalized.adoptionNotes,
      earlyValidationStatus, normalized.earlyValidationNotes,
      normalized.postLaunchSupportPlan, normalized.duplicateRequestControl,
      implementationId, req.product.workspaceId
    );
    if (!result.changes) return sendError(res, 404, "Implementation not found.");
    return res.json(normalized);
  });

  app.post("/api/product/implementations/:implementationId/calendar-events", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const title = requiredText(req.body.title, 240);
    const startAt = typeof req.body.startAt === "string" ? req.body.startAt.trim().slice(0, 40) : "";
    const endAt = typeof req.body.endAt === "string" ? req.body.endAt.trim().slice(0, 40) : "";
    const eventType = typeof req.body.eventType === "string" ? req.body.eventType.trim().slice(0, 80) : "meeting";
    const externalUrl = typeof req.body.externalUrl === "string" ? req.body.externalUrl.trim().slice(0, 1000) : "";
    if (!implementationId || !title || !startAt
      || Number.isNaN(Date.parse(startAt))
      || (endAt && (Number.isNaN(Date.parse(endAt)) || Date.parse(endAt) < Date.parse(startAt)))
      || (externalUrl && !/^https?:\/\//i.test(externalUrl))) {
      return sendError(res, 400, "Enter a valid event title, start/end time, and optional HTTPS URL.");
    }
    const implementation = await database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2"
    ).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const event = await database.prepare(`
      INSERT INTO product_calendar_events (implementation_id, title, start_at, end_at, event_type, external_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, title, start_at, end_at, event_type, external_url, created_at
    `).get(implementationId, title, startAt, endAt, eventType, externalUrl);
    return res.status(201).json({ event });
  });

  app.delete("/api/product/implementations/:implementationId/calendar-events/:eventId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const eventId = validId(req.params.eventId);
    if (!implementationId || !eventId) return sendError(res, 400, "Invalid calendar event.");
    const result = await database.prepare(`
      DELETE FROM product_calendar_events c
      USING product_implementations i
      WHERE c.id = $1 AND c.implementation_id = $2
        AND i.id = c.implementation_id AND i.workspace_id = $3
    `).run(eventId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Calendar event not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/capacity-plans", sameOrigin, requireSession, async (req, res) => {
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can update capacity plans.");
    const userId = validId(req.body.userId);
    const weekStart = typeof req.body.weekStart === "string" ? req.body.weekStart : "";
    const availableMinutes = Number(req.body.availableMinutes);
    const capacityNote = typeof req.body.capacityNote === "string" ? req.body.capacityNote.trim().slice(0, 500) : "";
    if (!userId || !validDate(weekStart) || !Number.isInteger(availableMinutes)
      || availableMinutes < 0 || availableMinutes > 10080) {
      return sendError(res, 400, "Enter a valid team member, week, and available capacity.");
    }
    const member = await database.prepare(`
      SELECT u.id FROM product_users u JOIN product_memberships m ON m.user_id = u.id
      WHERE u.id = $1 AND m.workspace_id = $2
    `).get(userId, req.product.workspaceId);
    if (!member) return sendError(res, 404, "Team member not found.");
    const plan = await database.prepare(`
      INSERT INTO product_capacity_plans
        (workspace_id, user_id, week_start, available_minutes, capacity_note)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (workspace_id, user_id, week_start) DO UPDATE SET
        available_minutes = excluded.available_minutes, capacity_note = excluded.capacity_note,
        updated_at = CURRENT_TIMESTAMP
      RETURNING workspace_id, user_id, week_start, available_minutes, capacity_note, updated_at
    `).get(req.product.workspaceId, userId, weekStart, availableMinutes, capacityNote);
    return res.status(201).json({ plan });
  });

  app.post("/api/product/implementations/:implementationId/launch-stakeholders", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim().slice(0, 120) : "";
    const email = requiredText(req.body.email, 254).toLowerCase();
    const role = typeof req.body.role === "string" ? req.body.role.trim().slice(0, 120) : "";
    const approvalStatus = ["pending", "approved", "blocked"].includes(req.body.approvalStatus) ? req.body.approvalStatus : "pending";
    const nextAction = typeof req.body.nextAction === "string" ? req.body.nextAction.trim().slice(0, 500) : "";
    if (!implementationId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendError(res, 400, "Enter a valid stakeholder name, role, and email address.");
    }
    const implementation = await database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2"
    ).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const stakeholder = await database.prepare(`
      INSERT INTO product_launch_stakeholders
        (implementation_id, display_name, email, role, approval_status, next_action)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (implementation_id, email) DO UPDATE SET
        display_name = excluded.display_name, role = excluded.role,
        approval_status = excluded.approval_status, next_action = excluded.next_action
      RETURNING id, display_name, email, role, approval_status, next_action, created_at
    `).get(implementationId, displayName, email, role, approvalStatus, nextAction);
    return res.status(201).json({ stakeholder });
  });

  app.delete("/api/product/implementations/:implementationId/launch-stakeholders/:stakeholderId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const stakeholderId = validId(req.params.stakeholderId);
    const result = await database.prepare(`
      DELETE FROM product_launch_stakeholders s
      USING product_implementations i
      WHERE s.id = $1 AND s.implementation_id = $2
        AND i.id = s.implementation_id AND i.workspace_id = $3
    `).run(stakeholderId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Stakeholder not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/implementations/:implementationId/launch-risks", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 240) : "";
    const category = typeof req.body.category === "string" ? req.body.category.trim().slice(0, 80) : "Other";
    const ownerName = typeof req.body.ownerName === "string" ? req.body.ownerName.trim().slice(0, 120) : "";
    const ownerEmail = typeof req.body.ownerEmail === "string" ? req.body.ownerEmail.trim().toLowerCase().slice(0, 254) : "";
    const severity = ["low", "medium", "high", "critical"].includes(req.body.severity) ? req.body.severity : "medium";
    const status = ["open", "mitigating", "resolved"].includes(req.body.status) ? req.body.status : "open";
    const nextAction = typeof req.body.nextAction === "string" ? req.body.nextAction.trim().slice(0, 500) : "";
    const dueAt = req.body.dueAt ?? "";
    if (!implementationId || !title || (dueAt !== "" && !validDate(dueAt))
      || (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))) {
      return sendError(res, 400, "Enter a valid risk, owner, severity, and due date.");
    }
    const implementation = await database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2"
    ).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const risk = await database.prepare(`
      INSERT INTO product_launch_risks
        (implementation_id, category, title, owner_name, owner_email, severity, status, next_action, due_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, category, title, owner_name, owner_email, severity, status, next_action, due_at, created_at
    `).get(implementationId, category, title, ownerName, ownerEmail, severity, status, nextAction, dueAt);
    return res.status(201).json({ risk });
  });

  app.delete("/api/product/implementations/:implementationId/launch-risks/:riskId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const riskId = validId(req.params.riskId);
    const result = await database.prepare(`
      DELETE FROM product_launch_risks r
      USING product_implementations i
      WHERE r.id = $1 AND r.implementation_id = $2
        AND i.id = r.implementation_id AND i.workspace_id = $3
    `).run(riskId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Risk not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/implementations/:implementationId/customer-contacts", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const email = requiredText(req.body.email, 254).toLowerCase();
    const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim().slice(0, 120) : "";
    if (!implementationId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || (typeof req.body.displayName !== "undefined" && typeof req.body.displayName !== "string")) {
      return sendError(res, 400, "Enter a valid customer contact name and email address.");
    }
    const implementation = await database.prepare(`
      SELECT id, customer_name, target_launch_date FROM product_implementations
      WHERE id = $1 AND workspace_id = $2
    `).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
    await database.prepare("UPDATE product_implementations SET portal_token_hash = NULL WHERE id = $1")
      .run(implementationId);
    const contact = await database.prepare(`
      INSERT INTO product_customer_contacts
        (implementation_id, email, display_name, token_hash, expires_at, revoked_at, last_activity_at)
      VALUES ($1, $2, $3, $4, $5, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT (implementation_id, email) DO UPDATE SET
        display_name = excluded.display_name, token_hash = excluded.token_hash,
        expires_at = excluded.expires_at, invitation_sent_at = NULL,
        revoked_at = NULL, last_activity_at = CURRENT_TIMESTAMP
      RETURNING id, email, display_name, expires_at, invitation_sent_at, revoked_at, last_activity_at, created_at
    `).get(implementationId, email, displayName, hashToken(token), expiresAt);
    const invitation = await sendCustomerContactInvitation({
      req, implementation, contactEmail: email, contactName: displayName, token
    });
    if (invitation.sent) {
      await database.prepare(`
        UPDATE product_customer_contacts SET invitation_sent_at = CURRENT_TIMESTAMP WHERE id = $1
      `).run(contact.id);
      contact.invitation_sent_at = new Date().toISOString();
      await enqueueWorkspaceEvent(req.product.workspaceId, implementationId, "customer.invited", {
        recipientEmail: email,
        contactName: displayName
      });
    }
    return res.status(201).json({
      contact,
      invitationSent: invitation.sent,
      ...(invitation.link ? { customerPortalUrl: invitation.link } : {}),
      ...(invitation.error ? { message: invitation.error } : {})
    });
  });

  app.delete("/api/product/implementations/:implementationId/customer-contacts/:contactId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const contactId = validId(req.params.contactId);
    if (!implementationId || !contactId) return sendError(res, 400, "Invalid customer contact.");
    const result = await database.prepare(`
      UPDATE product_customer_contacts SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND implementation_id = $2
        AND implementation_id IN (SELECT id FROM product_implementations WHERE workspace_id = $3)
        AND revoked_at IS NULL
    `).run(contactId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Active customer contact not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/implementations/:implementationId/messages", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const body = requiredText(req.body.body, 4000);
    if (!implementationId || !body) return sendError(res, 400, "Enter a message up to 4,000 characters.");
    const implementation = await database.prepare(`
      SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2
    `).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const message = await database.prepare(`
      INSERT INTO product_customer_messages
        (implementation_id, sender_role, sender_name, sender_email, body)
      VALUES ($1, 'team', $2, $3, $4)
      RETURNING id, sender_role, sender_name, sender_email, body, created_at
    `).get(implementationId, req.product.email, req.product.email, body);
    const contacts = await database.prepare(`
      SELECT email FROM product_customer_contacts
      WHERE implementation_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).all(implementationId);
    for (const contact of contacts) {
      await enqueueWorkspaceEvent(req.product.workspaceId, implementationId, "team.message", {
        messageId: message.id,
        recipientEmail: contact.email
      });
    }
    return res.status(201).json({ message });
  });

  app.patch("/api/product/implementations/:implementationId/customer-escalation", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const escalationEmail = typeof req.body.escalationEmail === "string"
      ? req.body.escalationEmail.trim().toLowerCase()
      : null;
    const escalationDelayDays = req.body.escalationDelayDays;
    if (escalationEmail === null || escalationEmail.length > 254
      || (escalationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(escalationEmail))
      || !Number.isInteger(escalationDelayDays) || escalationDelayDays < 3 || escalationDelayDays > 30) {
      return sendError(res, 400, "Enter a valid backup contact email and an escalation delay from 3 to 30 days.");
    }
    const result = await database.prepare(`
      UPDATE product_implementations SET escalation_email = $1, escalation_delay_days = $2
      WHERE id = $3 AND workspace_id = $4
    `).run(escalationEmail, escalationDelayDays, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Implementation not found.");
    return res.json({ escalationEmail, escalationDelayDays });
  });

  app.patch("/api/product/implementations/:implementationId/steps/:stepId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const stepId = validId(req.params.stepId);
    if (!implementationId || !stepId) return sendError(res, 400, "Invalid implementation task.");
    const step = await (database.prepare(`
      SELECT s.* FROM product_implementation_steps s
      JOIN product_implementations i ON i.id = s.implementation_id
      WHERE s.id = $1 AND s.implementation_id = $2 AND i.workspace_id = $3
    `).get(stepId, implementationId, req.product.workspaceId));
    if (!step) return sendError(res, 404, "Implementation task not found.");
    const status = req.body.status === undefined ? step.status : req.body.status;
    const owner = req.body.owner === undefined ? step.owner : typeof req.body.owner === "string" ? req.body.owner.trim().slice(0, 120) : null;
    const assignee = await (workspaceAssignee(
      req.product.workspaceId,
      req.body.assigneeUserId === undefined ? step.assignee_user_id : req.body.assigneeUserId
    ));
    const dueAt = req.body.dueAt === undefined ? step.due_at : req.body.dueAt;
    const isBlocked = req.body.isBlocked === undefined ? Boolean(step.is_blocked) : req.body.isBlocked;
    const blockerReason = req.body.blockerReason === undefined ? step.blocker_reason
      : typeof req.body.blockerReason === "string" ? req.body.blockerReason.trim().slice(0, 500) : null;
    const blockerNextAction = req.body.blockerNextAction === undefined ? step.blocker_next_action
      : typeof req.body.blockerNextAction === "string" ? req.body.blockerNextAction.trim().slice(0, 500) : null;
    const customerVisible = req.body.customerVisible === undefined ? Boolean(step.customer_visible) : req.body.customerVisible;
    if (!["not_started", "in_progress", "done"].includes(status) || owner === null || !assignee.valid
      || (dueAt !== "" && !validDate(dueAt))
      || typeof isBlocked !== "boolean" || blockerReason === null || blockerNextAction === null
      || typeof customerVisible !== "boolean"
      || (isBlocked && (!blockerReason || !blockerNextAction))
      || (status === "done" && isBlocked && req.product.planDetails.features.blockers)) {
      return sendError(res, 400, "Enter a valid task status, owner, due date, and blocker details.");
    }
    if ((req.body.isBlocked === true
      || (typeof req.body.blockerReason === "string" && req.body.blockerReason.trim())
      || (typeof req.body.blockerNextAction === "string" && req.body.blockerNextAction.trim()))
      && !requirePlanFeature(req, res, "blockers", "Blocker tracking")) return;
    if (status === "done" && req.product.planDetails.features.dependencies) {
      const waiting = await (database.prepare(`
        SELECT parent.title FROM product_implementation_step_dependencies d
        JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
        WHERE d.implementation_step_id = $1 AND parent.status != 'done'
        LIMIT 1
      `).get(stepId));
      if (waiting) return sendError(res, 409, `Complete prerequisite “${waiting.title}” before marking this task done.`);
    }
    await database.transaction(async () => {
      await database.prepare(`
        UPDATE product_implementation_steps
        SET status = $1, owner = $2, assignee_user_id = $3, due_at = $4, is_blocked = $5, blocker_reason = $6,
          blocker_next_action = $7, customer_visible = $8, updated_at = CURRENT_TIMESTAMP
        WHERE id = $9 AND implementation_id = $10
      `).run(status, owner, assignee.id, dueAt, isBlocked, isBlocked ? blockerReason : "", isBlocked ? blockerNextAction : "", customerVisible, stepId, implementationId);
      await enqueueWorkspaceEvent(req.product.workspaceId, implementationId, "task.updated", {
        taskTitle: step.title,
        status,
        isBlocked
      });
    });
    return res.json({ success: true });
  });

  app.post("/api/product/requirements", sameOrigin, requireSession, async (req, res) => {
    const name = requiredText(req.body.name, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const templateValue = req.body.templateId;
    const templateId = templateValue === null || templateValue === undefined || templateValue === ""
      ? null : validId(templateValue);
    const inputType = req.body.inputType === undefined ? "text" : req.body.inputType;
    const invalidTemplate = templateValue !== null && templateValue !== undefined && templateValue !== "" && !templateId;
    if (!name || invalidTemplate || !INPUT_TYPES.has(inputType)) {
      return sendError(res, 400, "Enter a request name, valid template scope, and supported response type.");
    }
    if (templateId && !await (database.prepare(
      "SELECT id FROM product_templates WHERE id = $1 AND workspace_id = $2"
    ).get(templateId, req.product.workspaceId))) return sendError(res, 404, "Template not found.");
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const existingRequest = await database.prepare(`
      SELECT id, name FROM product_requirements
      WHERE workspace_id = $1
        AND (($2::integer IS NULL AND template_id IS NULL) OR template_id = $2)
        AND lower(regexp_replace(name, '[^a-z0-9]+', ' ', 'g')) = $3
    `).get(req.product.workspaceId, templateId, normalizedName);
    if (existingRequest) {
      return sendError(res, 409, `This information has already been requested as “${existingRequest.name}”. Reuse that request instead of asking the customer again.`);
    }
    const requirementCount = (await database.prepare(
      "SELECT COUNT(*) AS count FROM product_requirements WHERE workspace_id = $1"
    ).get(req.product.workspaceId)).count;
    if (requirementCount >= 50) return sendError(res, 409, "A workspace can have up to 50 customer information requests.");
    if (req.body.required !== undefined && typeof req.body.required !== "boolean") {
      return sendError(res, 400, "Choose whether this information request is required.");
    }
    const required = req.body.required !== false;
    const requirement = await database.transaction(async () => {
      const requirement = await (database.prepare(
        `INSERT INTO product_requirements (workspace_id, template_id, name, description, required, input_type)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, template_id, name, description, required, input_type`
      ).get(req.product.workspaceId, templateId, name, description, required, inputType));
      await (database.prepare(`
        INSERT INTO product_customer_inputs (implementation_id, requirement_id)
        SELECT id, $1 FROM product_implementations
        WHERE workspace_id = $2 AND ($3::integer IS NULL OR template_id = $3)
      `).run(requirement.id, req.product.workspaceId, templateId));
      return requirement;
    });
    return res.status(201).json({ requirement });
  });

  app.patch("/api/product/requirements/:requirementId", sameOrigin, requireSession, async (req, res) => {
    const requirementId = validId(req.params.requirementId);
    const name = requiredText(req.body.name, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const inputType = req.body.inputType;
    const required = req.body.required;
    if (!requirementId || !name || !INPUT_TYPES.has(inputType) || typeof required !== "boolean") {
      return sendError(res, 400, "Enter a request name, supported response type, and required/optional setting.");
    }
    const saved = await (database.prepare(`
      UPDATE product_requirements
      SET name = $1, description = $2, input_type = $3, required = $4
      WHERE id = $5 AND workspace_id = $6
    `).run(name, description, inputType, required, requirementId, req.product.workspaceId));
    if (!saved.changes) return sendError(res, 404, "Customer information request not found.");
    return res.json({ success: true });
  });

  app.delete("/api/product/requirements/:requirementId", sameOrigin, requireSession, async (req, res) => {
    const requirementId = validId(req.params.requirementId);
    if (!requirementId) return sendError(res, 400, "Invalid customer information request.");
    const result = await (database.prepare(
      "DELETE FROM product_requirements WHERE id = $1 AND workspace_id = $2"
    ).run(requirementId, req.product.workspaceId));
    if (!result.changes) return sendError(res, 404, "Customer information request not found.");
    return res.json({ success: true });
  });

  app.get("/api/product/customer/:token", async (req, res) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return sendError(res, 404, "Customer link not found.");
    const access = await resolveCustomerAccess(token);
    if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
    const { implementation, contact } = access;
    const implementationId = implementation.implementation_id || implementation.id;
    const requirements = await (implementationRequirements(implementationId, implementation.workspace_id, implementation.template_id));
    const tasks = await database.prepare(`
      SELECT s.id, s.title, s.description, s.stage, s.status, s.due_at,
        s.is_blocked, s.blocker_reason, s.blocker_next_action,
        EXISTS (
          SELECT 1
          FROM product_implementation_step_dependencies d
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE d.implementation_step_id = s.id AND parent.status != 'done'
        ) AS waiting
      FROM product_implementation_steps s
      WHERE s.implementation_id = $1 AND s.customer_visible = TRUE
      ORDER BY s.position, s.id
    `).all(implementationId);
    const milestones = [...new Set(tasks.map((task) => task.stage))].map((stage) => {
      const stageTasks = tasks.filter((task) => task.stage === stage);
      return {
        name: stage,
        total: stageTasks.length,
        completed: stageTasks.filter((task) => task.status === "done").length
      };
    });
    const messages = await database.prepare(`
      SELECT id, sender_role, sender_name, body, created_at
      FROM product_customer_messages WHERE implementation_id = $1
      ORDER BY created_at, id
    `).all(implementationId);
    const files = await database.prepare(`
      SELECT id, uploaded_by_role, uploaded_by_name, filename, content_type, size_bytes, created_at
      FROM product_customer_files WHERE implementation_id = $1
      ORDER BY created_at DESC, id DESC
    `).all(implementationId);
    if (contact) {
      await database.prepare(`
        UPDATE product_customer_contacts SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1
      `).run(contact.contact_id);
    }
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      customerName: implementation.customer_name,
      customerOwnerName: implementation.customer_owner_name,
      customerOwnerEmail: implementation.customer_owner_email,
      targetLaunchDate: implementation.target_launch_date,
      successCriteria: implementation.success_criteria,
      acceptanceStatus: implementation.acceptance_status,
      testPlan: implementation.test_plan,
      trainingStatus: implementation.training_status,
      supportOwnerName: implementation.support_owner_name,
      supportOwnerEmail: implementation.support_owner_email,
      rollbackPlan: implementation.rollback_plan,
      goLiveStatus: implementation.go_live_status,
      communicationChannel: implementation.communication_channel,
      communicationCadence: implementation.communication_cadence,
      communicationOwnerName: implementation.communication_owner_name,
      communicationOwnerEmail: implementation.communication_owner_email,
      procurementStatus: implementation.procurement_status,
      securityStatus: implementation.security_status,
      integrationStatus: implementation.integration_status,
      technicalSetupStatus: implementation.technical_setup_status,
      changeManagementStatus: implementation.change_management_status,
      earlyValidationStatus: implementation.early_validation_status,
      postLaunchSupportPlan: implementation.post_launch_support_plan,
      contact: contact ? {
        id: contact.contact_id,
        name: contact.contact_name,
        email: contact.contact_email,
        expiresAt: contact.expires_at
      } : null,
      requirements,
      tasks,
      milestones,
      messages,
      files,
      progress: tasks.length
        ? Math.round((tasks.filter((task) => task.status === "done").length / tasks.length) * 100)
        : null
    });
  });

  app.post("/api/product/customer/:token", sameOrigin, async (req, res) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return sendError(res, 404, "Customer link not found.");
    const inputs = req.body.inputs === undefined ? [] : req.body.inputs;
    const completedStepIds = req.body.completedStepIds === undefined ? [] : req.body.completedStepIds;
    if (!Array.isArray(inputs) || inputs.length > 50) return sendError(res, 400, "Submit a valid list of information.");
    if (!Array.isArray(completedStepIds) || completedStepIds.length > 200) {
      return sendError(res, 400, "Submit a valid list of customer tasks.");
    }
    const access = await resolveCustomerAccess(token);
    if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
    const authorizedImplementation = access.implementation;
    const implementationId = authorizedImplementation.implementation_id;
    const validRequirements = (await implementationRequirements(
      implementationId,
      authorizedImplementation.workspace_id,
      authorizedImplementation.template_id
    )).map((requirement) => ({ ...requirement, current_value: requirement.value }));
    const entries = [];
    const entryIds = new Set();
    for (const input of inputs) {
      const requirementId = validId(input?.requirementId);
      if (!requirementId || !validRequirements.some((requirement) => requirement.id === requirementId)
        || entryIds.has(requirementId) || typeof input.value !== "string" || input.value.length > 2000) {
        return sendError(res, 400, "One or more submitted fields are invalid.");
      }
      entryIds.add(requirementId);
      const value = input.value.trim();
      const requirement = validRequirements.find((item) => item.id === requirementId);
      const validationError = inputValueError(requirement.input_type, value);
      if (validationError) return sendError(res, 400, `${requirement.name}: ${validationError}`);
      entries.push({ requirementId, value });
    }
    const submittedValues = new Map(entries.map((entry) => [entry.requirementId, entry.value]));
    const missingRequired = (entries.length || completedStepIds.length === 0) ? validRequirements.find((requirement) => requirement.required
      && !(submittedValues.has(requirement.id)
        ? submittedValues.get(requirement.id)
        : requirement.current_value).trim()) : null;
    if (missingRequired) {
      return sendError(res, 400, `Required information is missing: ${missingRequired.name}.`);
    }
    const invalidSavedValue = entries.length ? validRequirements.find((requirement) => {
      const value = submittedValues.has(requirement.id) ? submittedValues.get(requirement.id) : requirement.current_value.trim();
      return value && inputValueError(requirement.input_type, value);
    }) : null;
    if (invalidSavedValue) return sendError(res, 400, `${invalidSavedValue.name} must be corrected before submission.`);
    const stepIds = completedStepIds.map(validId);
    if (stepIds.some((id) => !id) || new Set(stepIds).size !== stepIds.length) {
      return sendError(res, 400, "One or more customer tasks are invalid.");
    }
    if (stepIds.length) {
      const customerSteps = await database.prepare(`
        SELECT s.id, s.is_blocked, EXISTS (
          SELECT 1 FROM product_implementation_step_dependencies d
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE d.implementation_step_id = s.id AND parent.status != 'done'
        ) AS waiting
        FROM product_implementation_steps s
        WHERE s.implementation_id = $1 AND s.customer_visible = TRUE
          AND s.id = ANY($2::integer[])
      `).all(implementationId, stepIds);
      if (customerSteps.length !== stepIds.length) return sendError(res, 400, "One or more customer tasks are unavailable.");
      if (customerSteps.some((step) => step.is_blocked)) {
        return sendError(res, 409, "This task is blocked. Send your implementation team a message for the next update.");
      }
      if (customerSteps.some((step) => step.waiting)) return sendError(res, 409, "Complete the prerequisite steps before marking this task done.");
    }
    await database.transaction(async () => {
      const save = database.prepare(`
        INSERT INTO product_customer_inputs (implementation_id, requirement_id, value, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (implementation_id, requirement_id)
        DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `);
      for (const entry of entries) await (save.run(implementationId, entry.requirementId, entry.value));
      if (stepIds.length) {
        const completed = await database.prepare(`
          UPDATE product_implementation_steps SET status = 'done', updated_at = CURRENT_TIMESTAMP
          WHERE implementation_id = $1 AND customer_visible = TRUE AND status != 'done'
            AND id = ANY($2::integer[])
        `).run(implementationId, stepIds);
        if (completed.changes) {
          await enqueueWorkspaceEvent(authorizedImplementation.workspace_id, implementationId, "customer.tasks_completed", {
            count: completed.changes
          });
        }
      }
      if (entries.length) {
        await enqueueWorkspaceEvent(authorizedImplementation.workspace_id, implementationId, "customer.information_submitted");
      }
      if (access.contact) {
        await database.prepare(`
          UPDATE product_customer_contacts SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1
        `).run(access.contact.contact_id);
      }
    });
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.json({ success: true });
  });

  app.post("/api/product/customer/:token/messages", sameOrigin,
    limitRequests("customer-message", 10, 15 * 60 * 1000, "Too many messages. Please wait before sending another."),
    async (req, res) => {
      const token = req.params.token;
      const body = requiredText(req.body.body, 4000);
      const senderName = typeof req.body.senderName === "string" ? req.body.senderName.trim().slice(0, 120) : "";
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !body) {
        return sendError(res, 400, "Enter a message up to 4,000 characters.");
      }
      const access = await resolveCustomerAccess(token);
      if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
      const { implementation, contact } = access;
      const message = await database.prepare(`
        INSERT INTO product_customer_messages
          (implementation_id, contact_id, sender_role, sender_name, sender_email, body)
        VALUES ($1, $2, 'customer', $3, $4, $5)
        RETURNING id, sender_role, sender_name, body, created_at
      `).get(
        implementation.implementation_id,
        contact?.contact_id || null,
        contact?.contact_name || senderName || "Customer",
        contact?.contact_email || "",
        body
      );
      if (contact) {
        await database.prepare(`
          UPDATE product_customer_contacts SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1
        `).run(contact.contact_id);
      }
      await enqueueWorkspaceEvent(implementation.workspace_id, implementation.implementation_id, "customer.message", {
        messageId: message.id,
        senderName: message.sender_name
      });
      return res.status(201).json({ message });
    });

  app.post("/api/product/customer/:token/files", sameOrigin, async (req, res) => {
      const token = req.params.token;
      let filename = "";
      try {
        filename = safeCustomerFilename(decodeURIComponent(req.get("X-File-Name") || ""));
      } catch {
        return sendError(res, 400, "The file name is invalid.");
      }
      const contentType = (req.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      const content = req.body;
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !filename
        || !customerFileType(contentType, filename, content)) {
        return sendError(res, 400, "Upload a PDF, PNG, or JPG file no larger than 5 MB.");
      }
      const access = await resolveCustomerAccess(token);
      if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
      const { implementation, contact } = access;
      const saved = await database.transaction(async () => {
        const lockedImplementation = await database.prepare(`
          SELECT id FROM product_implementations WHERE id = $1 FOR UPDATE
        `).get(implementation.implementation_id);
        if (!lockedImplementation) {
          return { error: "This implementation is no longer available.", status: 404 };
        }
        const usage = await database.prepare(`
          SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total_bytes
          FROM product_customer_files WHERE implementation_id = $1
        `).get(implementation.implementation_id);
        if (Number(usage.count) >= CUSTOMER_FILE_COUNT_LIMIT
          || Number(usage.total_bytes) + content.length > CUSTOMER_FILE_TOTAL_LIMIT) {
          return {
            error: "This implementation can store up to 20 files and 25 MB total.",
            status: 409
          };
        }
        const file = await database.prepare(`
          INSERT INTO product_customer_files
            (implementation_id, contact_id, uploaded_by_role, uploaded_by_name, filename, content_type, size_bytes, content)
          VALUES ($1, $2, 'customer', $3, $4, $5, $6, $7)
          RETURNING id, uploaded_by_role, uploaded_by_name, filename, content_type, size_bytes, created_at
        `).get(
          implementation.implementation_id,
          contact?.contact_id || null,
          contact?.contact_name || "Customer",
          filename,
          contentType,
          content.length,
          content
        );
        return { file };
      });
      if (saved.error) return sendError(res, saved.status, saved.error);
      const { file } = saved;
      if (contact) {
        await database.prepare(`
          UPDATE product_customer_contacts SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1
        `).run(contact.contact_id);
      }
      await enqueueWorkspaceEvent(implementation.workspace_id, implementation.implementation_id, "customer.file_uploaded", {
        filename,
        uploadedBy: file.uploaded_by_name
      });
      return res.status(201).json({ file });
    });

  app.get("/api/product/customer/:token/files/:fileId", async (req, res) => {
    const token = req.params.token;
    const fileId = validId(req.params.fileId);
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !fileId) {
      return sendError(res, 404, "Customer file not found.");
    }
    const access = await resolveCustomerAccess(token);
    if (!access) return sendError(res, 404, "Customer file not found.");
    const file = await database.prepare(`
      SELECT filename, content_type, content, size_bytes FROM product_customer_files
      WHERE id = $1 AND implementation_id = $2
    `).get(fileId, access.implementation.implementation_id);
    if (!file) return sendError(res, 404, "Customer file not found.");
    const asciiFilename = file.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.setHeader("Content-Type", file.content_type);
    res.setHeader("Content-Disposition", `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader("Content-Length", file.size_bytes);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(file.content);
  });

  app.get("/api/product/implementations/:implementationId/files/:fileId", requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const fileId = validId(req.params.fileId);
    if (!implementationId || !fileId) return sendError(res, 404, "Customer file not found.");
    const file = await database.prepare(`
      SELECT f.filename, f.content_type, f.content, f.size_bytes
      FROM product_customer_files f
      JOIN product_implementations i ON i.id = f.implementation_id
      WHERE f.id = $1 AND f.implementation_id = $2 AND i.workspace_id = $3
    `).get(fileId, implementationId, req.product.workspaceId);
    if (!file) return sendError(res, 404, "Customer file not found.");
    const asciiFilename = file.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.setHeader("Content-Type", file.content_type);
    res.setHeader("Content-Disposition", `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader("Content-Length", file.size_bytes);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(file.content);
  });

  app.delete("/api/product/implementations/:implementationId/files/:fileId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const fileId = validId(req.params.fileId);
    if (!implementationId || !fileId) return sendError(res, 400, "Invalid customer file.");
    const result = await database.prepare(`
      DELETE FROM product_customer_files f USING product_implementations i
      WHERE f.id = $1 AND f.implementation_id = $2
        AND i.id = f.implementation_id AND i.workspace_id = $3
    `).run(fileId, implementationId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Customer file not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/customer/:token/renew", sameOrigin,
    limitRequests("customer-link-renewal", 5, 15 * 60 * 1000, "Too many link requests. Please wait before trying again."),
    async (req, res) => {
      const token = req.params.token;
      const email = requiredText(req.body.email, 254).toLowerCase();
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendError(res, 400, "Enter the email address that received your invitation.");
      }
      const contact = await database.prepare(`
        SELECT c.id, c.implementation_id, c.email, c.display_name,
          i.customer_name, i.target_launch_date
        FROM product_customer_contacts c
        JOIN product_implementations i ON i.id = c.implementation_id
        JOIN product_workspace_subscriptions s ON s.workspace_id = i.workspace_id
        WHERE c.token_hash = $1 AND lower(c.email) = $2
          AND c.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
      `).get(hashToken(token), email);
      if (!contact) {
        return res.json({ message: "If this link is eligible, a fresh personal invitation will be sent to that email." });
      }
      const newToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
      const invitation = await sendCustomerContactInvitation({
        req,
        implementation: contact,
        contactEmail: contact.email,
        contactName: contact.display_name,
        token: newToken
      });
      if (!invitation.sent) {
        return sendError(res, 503, "A fresh link could not be emailed right now. Please reply to your original invitation for help.");
      }
      await database.prepare(`
        UPDATE product_customer_contacts
        SET token_hash = $1, expires_at = $2, invitation_sent_at = CURRENT_TIMESTAMP,
          last_activity_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND revoked_at IS NULL
      `).run(hashToken(newToken), expiresAt, contact.id);
      return res.json({ message: "A fresh personal link has been emailed. Check your inbox." });
    });

  app.use("/api/product", (_req, res) => sendError(res, 404, "Product endpoint not found."));
}

module.exports = installProductRoutes;
