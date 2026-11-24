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
const {
  canAccessWorkspaceRequest,
  getRoleCapabilities,
  isWorkspaceAdmin
} = require("./product-authorization");
const { getPlanDetails } = require("./product-plans");
const { relayHelpReply } = require("./public/relay-help");
const { createJustOneCXIdentity } = require("./justonecx-identity");
const { overdueCriticalClientTaskIds } = require("./implementation-scheduling");
const {
  APPROVAL_STAGE_GATES,
  STAGE_GATE_ORDER,
  stagesRequiringApprovalBeforeMove
} = require("./stage-gates");
const { MalwareScannerError, scanCustomerUpload } = require("./malware-scanning");
const {
  SALESFORCE_API_VERSION,
  composeSalesforceTemplate,
  createJiraIssue,
  createLinearIssue,
  getJiraIssueStatus,
  getLinearIssueStatus,
  normalizeJiraBaseUrl,
  normalizeSalesforceInstanceUrl,
  normalizeSalesforceLoginUrl,
  testJiraConnection,
  testLinearConnection
} = require("./enterprise-integrations");
const {
  calculateBurn,
  calculateProjectFinancials,
  summarizePortfolio,
  thresholdsCrossed
} = require("./financial-protection");
const {
  MAX_CSV_BYTES,
  normalizeSlackWebhookUrl,
  parseCsv,
  parseXlsx,
  sendSlackWebhook,
  suggestCsvHeaderMapping,
  testCredentialConnection,
  validateCredentialProvider,
  validateCsvRows,
  validateCsvSchema
} = require("./phase-three-capabilities");

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

function csvSchemaHash(schema) {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
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
    jpeg: "image/jpeg",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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

function integrationConfiguration(integration) {
  if (integration.configuration_json && typeof integration.configuration_json === "object") {
    return integration.configuration_json;
  }
  try {
    return JSON.parse(integration.configuration_json || "{}");
  } catch {
    throw new Error("Saved integration configuration is invalid.");
  }
}

async function salesforceAccessToken(integration, workspaceId, database) {
  let accessToken;
  try {
    accessToken = decryptIntegrationValue(integration.access_token_cipher);
  } catch {
    throw new Error("The saved Salesforce token cannot be decrypted. Disconnect and reconnect Salesforce.");
  }
  if (!integration.token_expires_at || Date.parse(integration.token_expires_at) > Date.now() + 60_000) {
    return accessToken;
  }
  if (!integration.refresh_token_cipher) throw new Error("Salesforce authorization expired. Reconnect Salesforce.");
  const config = integrationConfiguration(integration);
  const loginUrl = normalizeSalesforceLoginUrl(config.loginUrl);
  const instanceUrl = normalizeSalesforceInstanceUrl(config.instanceUrl);
  if (!loginUrl || !instanceUrl) throw new Error("The saved Salesforce connection is invalid. Reconnect Salesforce.");
  let refreshToken;
  try {
    refreshToken = decryptIntegrationValue(integration.refresh_token_cipher);
  } catch {
    throw new Error("The saved Salesforce refresh token cannot be decrypted. Reconnect Salesforce.");
  }
  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.SALESFORCE_CLIENT_ID || "",
      client_secret: process.env.SALESFORCE_CLIENT_SECRET || "",
      refresh_token: refreshToken
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10000)
  });
  const refreshed = await response.json().catch(() => ({}));
  if (!response.ok || !refreshed.access_token
    || normalizeSalesforceInstanceUrl(refreshed.instance_url || instanceUrl) !== instanceUrl) {
    throw new Error("Salesforce authorization could not be refreshed.");
  }
  accessToken = refreshed.access_token;
  const expiresAt = new Date(Date.now() + (Number(refreshed.expires_in) || 3600) * 1000).toISOString();
  const encryptedToken = encryptIntegrationValue(accessToken);
  await database.prepare(`
    UPDATE product_workspace_integrations SET access_token_cipher = $1,
      token_expires_at = $2, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = $3 AND provider = 'salesforce'
  `).run(encryptedToken, expiresAt, workspaceId);
  integration.token_expires_at = expiresAt;
  integration.access_token_cipher = encryptedToken;
  return accessToken;
}

async function salesforceApiRequest(integration, accessToken, pathname, searchParams) {
  const config = integrationConfiguration(integration);
  const instanceUrl = normalizeSalesforceInstanceUrl(config.instanceUrl);
  if (!instanceUrl || !pathname.startsWith(`/services/data/${SALESFORCE_API_VERSION}/`)) {
    throw new Error("The saved Salesforce connection is invalid.");
  }
  const url = new URL(pathname, instanceUrl);
  if (searchParams) url.searchParams.set("q", searchParams);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Salesforce returned HTTP ${response.status}.`);
  return result;
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

function safeDeliveryError(error) {
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/\bHTTP (\d{3})\b/)?.[1];
  if (status) return `Delivery provider returned HTTP ${status}.`;
  if (/not configured/i.test(message)) return "A required delivery provider is not configured.";
  if (/decrypt/i.test(message)) return "Saved integration credentials could not be decrypted.";
  return "Delivery failed. Check provider configuration and Worker logs.";
}

function installProductRoutes(app, db, isProduction) {
  const database = db.database;

  async function writeAuditLog({ workspaceId, implementationId = null, actorId, actorEmail, ipAddress, action, diff }) {
    await database.prepare(`
      INSERT INTO audit_logs
        (workspace_id, implementation_id, actor_id, actor_email, ip_address, action, diff_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `).run(
      workspaceId,
      implementationId,
      actorId,
      actorEmail || "",
      ipAddress || "",
      action,
      JSON.stringify(diff || {})
    );
  }

  async function ensureCustomerFileScanned(file, workspaceId, implementationId) {
    if (file.scan_status === "clean") return true;
    if (file.scan_status === "infected") return false;
    let scanResult;
    try {
      scanResult = await scanCustomerUpload(file.content);
    } catch (error) {
      if (!(error instanceof MalwareScannerError)) throw error;
      console.error(JSON.stringify({
        event: "customer_file_scan_failed",
        workspace_id: workspaceId,
        implementation_id: implementationId,
        file_id: file.id,
        error_code: error.code
      }));
      throw error;
    }

    return database.transaction(async () => {
      const current = await database.prepare(`
        SELECT scan_status FROM product_customer_files WHERE id = $1 FOR UPDATE
      `).get(file.id);
      if (!current) return false;
      if (current.scan_status === "infected") return false;
      if (scanResult.status === "infected") {
        await database.prepare(`
          UPDATE product_customer_files SET scan_status = 'infected', scanned_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `).run(file.id);
        await writeAuditLog({
          workspaceId,
          implementationId,
          actorId: "system:clamav-scanner",
          action: "customer.file_rejected_malware",
          diff: { fileId: file.id }
        });
        return false;
      }
      if (current.scan_status === "pending") {
        await database.prepare(`
          UPDATE product_customer_files SET scan_status = 'clean', scanned_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `).run(file.id);
      }
      return true;
    });
  }

  async function enqueueWorkspaceEvent(workspaceId, implementationId, eventType, payload = {}) {
    const eventKey = `${eventType}:${implementationId}:${randomUUID()}`;
    await database.prepare(`
      INSERT INTO product_workspace_events
        (event_key, workspace_id, implementation_id, event_type, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `).run(eventKey, workspaceId, implementationId, eventType, JSON.stringify(payload));
  }

  async function recalculateBudgetBurn(implementationId, workspaceId) {
    const implementation = await database.prepare(`
      SELECT id, customer_name, budget_type, budget_limit, hard_lock_on_exceed, last_alert_threshold_sent
      FROM product_implementations
      WHERE id = $1 AND workspace_id = $2
    `).get(implementationId, workspaceId);
    if (!implementation) return null;
    const totals = await database.prepare(`
      SELECT COALESCE(SUM(minutes), 0) AS logged_minutes,
        COALESCE(SUM(minutes * internal_cost_rate_snapshot / 60.0)
          FILTER (WHERE rate_snapshot_present), 0) AS delivery_cost
      FROM product_time_entries WHERE implementation_id = $1
    `).get(implementationId);
    const burnPercent = calculateBurn({
      budgetType: implementation.budget_type,
      budgetLimit: implementation.budget_limit,
      loggedMinutes: totals.logged_minutes,
      deliveryCost: totals.delivery_cost
    });
    const thresholds = burnPercent === null
      ? []
      : thresholdsCrossed(implementation.last_alert_threshold_sent, burnPercent);
    const nextThreshold = burnPercent === null ? 0
      : burnPercent >= 100 ? 100 : burnPercent >= 90 ? 90 : burnPercent >= 75 ? 75 : 0;
    await database.prepare(`
      UPDATE product_implementations SET last_alert_threshold_sent = $1
      WHERE id = $2 AND workspace_id = $3
    `).run(Math.max(nextThreshold, thresholds.at(-1) || 0), implementationId, workspaceId);
    for (const threshold of thresholds) {
      const severity = threshold >= 100 ? "Budget exceeded" : threshold >= 90 ? "Critical budget burn" : "Budget warning";
      const alert = {
        customerName: implementation.customer_name,
        threshold,
        burnPercent: Math.round(burnPercent * 100) / 100,
        severity,
        budgetType: implementation.budget_type
      };
      await enqueueWorkspaceEvent(workspaceId, implementationId, "budget.burn_alert", alert);
      await writeAuditLog({
        workspaceId,
        implementationId,
        actorId: "system:burn-evaluator",
        action: "budget.burn_alert",
        diff: alert
      });
    }
    return {
      burn_pct: burnPercent,
      logged_minutes: Number(totals.logged_minutes) || 0,
      delivery_cost: Number(totals.delivery_cost) || 0,
      hard_lock_on_exceed: implementation.hard_lock_on_exceed
    };
  }

  async function resolveCustomerAccess(token) {
    const hashedToken = hashToken(token);
    const delegation = await database.prepare(`
      SELECT d.id AS delegation_id, d.implementation_id, d.email AS delegate_email,
        d.display_name AS delegate_name, d.stakeholder_role, d.expires_at,
        i.workspace_id, i.customer_name, i.projected_go_live_date
      FROM product_customer_task_delegations d
      JOIN product_implementations i ON i.id = d.implementation_id
      JOIN product_workspace_subscriptions s ON s.workspace_id = i.workspace_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL
        AND d.expires_at > CURRENT_TIMESTAMP AND s.expires_at > CURRENT_TIMESTAMP
        AND i.archived_at IS NULL
    `).get(hashedToken);
    if (delegation) {
      return {
        kind: "delegate",
        implementation: {
          implementation_id: delegation.implementation_id,
          workspace_id: delegation.workspace_id,
          customer_name: delegation.customer_name
          , projected_go_live_date: delegation.projected_go_live_date
        },
        delegation
      };
    }

    const contact = await database.prepare(`
      SELECT c.id AS contact_id, c.email AS contact_email, c.display_name AS contact_name,
        c.implementation_id, c.expires_at, i.id, i.workspace_id, i.template_id,
        i.customer_name, i.target_launch_date, i.projected_go_live_date,
        i.customer_owner_name, i.customer_owner_email,
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
        AND i.archived_at IS NULL
    `).get(hashedToken);
    if (contact) return { kind: "contact", implementation: contact, contact };

    const implementation = await database.prepare(`
      SELECT i.id AS implementation_id, i.workspace_id, i.template_id, i.customer_name,
        i.target_launch_date, i.projected_go_live_date,
        i.customer_owner_name, i.customer_owner_email,
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
        AND i.archived_at IS NULL
    `).get(hashedToken);
    return implementation ? { kind: "shared", implementation, contact: null } : null;
  }

  function customerPortalUrl(req, token) {
    const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || `${req.protocol}://${req.get("host")}`;
    try {
      const customerUrl = new URL("/customer.html", baseUrl);
      if (!["http:", "https:"].includes(customerUrl.protocol) || customerUrl.username || customerUrl.password) {
        throw new Error("The customer portal URL is invalid.");
      }
      customerUrl.searchParams.set("token", token);
      return customerUrl.href;
    } catch {
      throw new Error("The customer portal URL is not configured correctly.");
    }
  }

  async function sendCustomerContactInvitation({ req, implementation, contactEmail, contactName, token }) {
    const link = customerPortalUrl(req, token);
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

  async function pollSalesforceOnboarding(integration, req) {
    const workspaceId = integration.workspace_id;
    const accessToken = await salesforceAccessToken(integration, workspaceId, database);
    const previousSync = Date.parse(integration.last_synced_at) || Date.now();
    const modifiedSince = new Date(Math.max(0, previousSync - 10 * 60 * 1000)).toISOString();
    const mappings = await database.prepare(`
      SELECT sku, template_id FROM product_salesforce_sku_template_mappings
      WHERE workspace_id = $1 ORDER BY sku
    `).all(workspaceId);
    if (!mappings.length) throw new Error("Map at least one Salesforce product SKU to a Relay template.");
    const templateIds = [...new Set(mappings.map((mapping) => Number(mapping.template_id)))];
    const templates = await database.prepare(`
      SELECT id, name, steps_json FROM product_templates
      WHERE workspace_id = $1 AND id = ANY($2::int[])
    `).all(workspaceId, templateIds);
    const failedImports = await database.prepare(`
      SELECT opportunity_id FROM product_salesforce_imports
      WHERE workspace_id = $1 AND status = 'failed'
      ORDER BY updated_at ASC LIMIT 100
    `).all(workspaceId);
    const retryIds = failedImports.map((item) => item.opportunity_id)
      .filter((id) => /^[A-Za-z0-9]{15,18}$/.test(id));
    const retryFilter = retryIds.length
      ? ` OR Id IN (${retryIds.map((id) => `'${id}'`).join(",")})`
      : "";
    const query = [
      "SELECT Id, Name, CloseDate, LastModifiedDate, Account.Name,",
      "(SELECT PricebookEntry.Product2.ProductCode FROM OpportunityLineItems),",
      "(SELECT Contact.Name, Contact.Email, IsPrimary FROM OpportunityContactRoles)",
      "FROM Opportunity",
      `WHERE IsWon = TRUE AND (LastModifiedDate >= ${modifiedSince}${retryFilter})`,
      "ORDER BY LastModifiedDate ASC LIMIT 500"
    ].join(" ");
    let page = await salesforceApiRequest(
      integration,
      accessToken,
      `/services/data/${SALESFORCE_API_VERSION}/query/`,
      query
    );
    let pages = 0;
    let created = 0;
    let failed = 0;
    if (process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM) {
      const unsentInvitations = await database.prepare(`
        SELECT h.opportunity_id, i.id, i.customer_name, i.target_launch_date,
          i.customer_owner_name, i.customer_owner_email, c.invitation_sent_at
        FROM product_salesforce_imports h
        JOIN product_implementations i ON i.id = h.implementation_id
        JOIN product_customer_contacts c
          ON c.implementation_id = i.id AND c.email = i.customer_owner_email
        WHERE h.workspace_id = $1 AND h.status = 'imported'
          AND c.invitation_sent_at IS NULL AND c.revoked_at IS NULL
          AND BTRIM(i.customer_owner_email) != ''
      `).all(workspaceId);
      for (const imported of unsentInvitations) {
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
        await database.prepare(`
          UPDATE product_customer_contacts SET token_hash = $1, expires_at = $2,
            revoked_at = NULL, invitation_sent_at = NULL, last_activity_at = CURRENT_TIMESTAMP
          WHERE implementation_id = $3 AND email = $4
        `).run(hashToken(token), expiresAt, imported.id, imported.customer_owner_email);
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
        } else {
          failed += 1;
        }
      }
    }
    do {
      if (++pages > 10 || !Array.isArray(page.records)) {
        throw new Error("Salesforce returned an invalid or oversized opportunity result.");
      }
      for (const opportunity of page.records) {
        if (!/^[A-Za-z0-9]{15,18}$/.test(opportunity.Id || "") || opportunity.IsWon === false) continue;
        const alreadyImported = await database.prepare(`
          SELECT implementation_id FROM product_salesforce_imports
          WHERE workspace_id = $1 AND opportunity_id = $2 AND status = 'imported'
        `).get(workspaceId, opportunity.Id);
        if (alreadyImported) continue;
        try {
          const skuCodes = (opportunity.OpportunityLineItems?.records || [])
            .map((item) => item.PricebookEntry?.Product2?.ProductCode)
            .filter((sku) => typeof sku === "string" && sku.trim())
            .map((sku) => sku.trim());
          const composition = composeSalesforceTemplate(skuCodes, mappings, templates);
          const primaryContact = (opportunity.OpportunityContactRoles?.records || [])
            .find((role) => role.IsPrimary) || opportunity.OpportunityContactRoles?.records?.[0];
          const contactName = requiredText(primaryContact?.Contact?.Name, 120);
          const contactEmail = typeof primaryContact?.Contact?.Email === "string"
            ? primaryContact.Contact.Email.trim().toLowerCase() : "";
          if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
            throw new Error("The Salesforce opportunity contact has an invalid email address.");
          }
          const customerName = requiredText(opportunity.Account?.Name, 120)
            || requiredText(opportunity.Name, 120)
            || `Salesforce opportunity ${opportunity.Id}`;
          const creation = await createImplementationFromTemplate({
            workspaceId,
            template: composition.template,
            requirementTemplateIds: composition.templateIds,
            customerName,
            customerOwnerName: contactName,
            customerOwnerEmail: contactEmail,
            sourceImport: {
              provider: "salesforce",
              recordId: opportunity.Id,
              recordName: opportunity.Name
            }
          });
          if (!creation.implementation) throw new Error(creation.error || "Relay could not create the implementation.");
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
          `).run(creation.implementation.id, contactEmail, contactName, hashToken(token), expiresAt);
          const invitation = await sendCustomerContactInvitation({
            req,
            implementation: creation.implementation,
            contactEmail,
            contactName,
            token
          });
          if (!invitation.sent) {
            failed += 1;
            continue;
          }
          await database.prepare(`
            UPDATE product_customer_contacts SET invitation_sent_at = CURRENT_TIMESTAMP
            WHERE implementation_id = $1 AND email = $2
          `).run(creation.implementation.id, contactEmail);
        } catch (error) {
          failed += 1;
          await database.prepare(`
            INSERT INTO product_salesforce_imports
              (workspace_id, opportunity_id, opportunity_name, status, last_error, updated_at)
            VALUES ($1, $2, $3, 'failed', $4, CURRENT_TIMESTAMP)
            ON CONFLICT (workspace_id, opportunity_id) DO UPDATE SET
              opportunity_name = excluded.opportunity_name,
              last_error = excluded.last_error, updated_at = CURRENT_TIMESTAMP
            WHERE product_salesforce_imports.status = 'failed'
          `).run(workspaceId, opportunity.Id, requiredText(opportunity.Name, 120), error.message.slice(0, 500));
        }
      }
      if (!page.nextRecordsUrl) break;
      const config = integrationConfiguration(integration);
      const instanceUrl = normalizeSalesforceInstanceUrl(config.instanceUrl);
      if (!instanceUrl) throw new Error("The saved Salesforce connection is invalid.");
      const nextUrl = new URL(page.nextRecordsUrl, instanceUrl);
      if (!instanceUrl || nextUrl.origin !== instanceUrl
        || !nextUrl.pathname.startsWith(`/services/data/${SALESFORCE_API_VERSION}/query/`)) {
        throw new Error("Salesforce returned an invalid pagination link.");
      }
      page = await salesforceApiRequest(integration, accessToken, `${nextUrl.pathname}${nextUrl.search}`);
    } while (true);

    await database.prepare(`
      UPDATE product_workspace_integrations
      SET last_synced_at = CURRENT_TIMESTAMP,
        last_sync_error = $1, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = $2 AND provider = 'salesforce'
    `).run(failed ? `${failed} Salesforce opportunity${failed === 1 ? "" : "ies"} need attention.` : "",
      workspaceId);
    return { created, failed };
  }

  function requirePlanFeature(req, res, feature, featureName, minimumPlan = "growth") {
    if (req.product.planDetails.features[feature]) return true;
    const availableIn = minimumPlan === "custom" ? "Custom" : "Growth and Custom";
    sendError(res, 403, `${featureName} is included with ${availableIn} plans. Upgrade this workspace to use it.`);
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
      WHERE i.workspace_id = $1 AND i.archived_at IS NULL AND (
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
    sourcePipelineId = "",
    sourceImport = null,
    requirementTemplateIds = null
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
      if (sourceImport?.provider === "salesforce") {
        const existing = await database.prepare(`
          SELECT implementation_id FROM product_salesforce_imports
          WHERE workspace_id = $1 AND opportunity_id = $2 AND status = 'imported'
        `).get(workspaceId, sourceImport.recordId);
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
      if (sourceImport?.provider === "salesforce") {
        const existing = await database.prepare(`
          SELECT implementation_id FROM product_salesforce_imports
          WHERE workspace_id = $1 AND opportunity_id = $2 AND status = 'imported'
        `).get(workspaceId, sourceImport.recordId);
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
            projected_go_live_date, customer_owner_name, customer_owner_email,
            hubspot_source_deal_id, hubspot_source_pipeline_id)
        VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)
        RETURNING id, customer_name, created_at, target_launch_date,
          projected_go_live_date, customer_owner_name, customer_owner_email
      `).get(workspaceId, template.id, customerName, targetLaunchDate,
        customerOwnerName, customerOwnerEmail, sourceDealId, sourcePipelineId);
      const insertStep = database.prepare(`
        INSERT INTO product_implementation_steps
          (implementation_id, title, description, owner, position, due_at, stage,
            assignee_user_id, customer_visible, estimated_duration_days, responsible_party)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
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
          step.customerVisible === true,
          Number.isInteger(step.estimatedDurationDays) ? step.estimatedDurationDays : 1,
          step.responsibleParty === "client" ? "client" : step.customerVisible === true ? "client" : "relay"
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
        WHERE workspace_id = $2 AND (
          template_id IS NULL OR template_id = ANY($3::int[])
        )
      `).run(implementation.id, workspaceId,
        [...new Set((requirementTemplateIds || [template.id]).map(Number))]);
      if (sourceImport?.provider === "salesforce") {
        await database.prepare(`
          INSERT INTO product_salesforce_imports
            (workspace_id, opportunity_id, opportunity_name, implementation_id,
              status, last_error, imported_at, updated_at)
          VALUES ($1, $2, $3, $4, 'imported', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (workspace_id, opportunity_id) DO UPDATE SET
            opportunity_name = excluded.opportunity_name,
            implementation_id = excluded.implementation_id, status = 'imported',
            last_error = '', imported_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        `).run(workspaceId, sourceImport.recordId,
          requiredText(sourceImport.recordName, 120), implementation.id);
        await writeAuditLog({
          workspaceId,
          actorId: "integration:salesforce",
          action: "implementation.created_from_salesforce",
          diff: { implementationId: implementation.id, opportunityId: sourceImport.recordId }
        });
      }
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
        s.assignee_user_id, s.customer_visible, s.estimated_duration_days, s.responsible_party,
        u.email AS assignee_email
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
      SELECT i.id, i.workspace_id, i.invited_email, i.role
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
          "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)"
        ).run(invite.workspace_id, user.id, invite.role));
        await writeAuditLog({
          workspaceId: invite.workspace_id,
          actorId: `user:${user.id}`,
          actorEmail: user.email,
          ipAddress: req.ip,
          action: "workspace.invitation_accepted",
          diff: { inviteId: invite.id, role: invite.role, email: user.email }
        });
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
          role: invite.role,
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
          SELECT i.id, i.workspace_id, i.invited_email, i.role
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
            "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)"
          ).run(invite.workspace_id, user.id, invite.role));
          await writeAuditLog({
            workspaceId: invite.workspace_id,
            actorId: `user:${user.id}`,
            actorEmail: user.email,
            ipAddress: req.ip,
            action: "workspace.invitation_accepted",
            diff: { inviteId: invite.id, role: invite.role, email: user.email }
          });
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
          workspace = { ...joinedWorkspace, role: invite.role };
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
    const authorize = () => {
      if (!canAccessWorkspaceRequest(req.product.role, req.method, req.path)) {
        return sendError(res, 403, "Your workspace role does not allow this action.");
      }
      return next();
    };
    if (req.product) return authorize();
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
      capabilities: getRoleCapabilities(session.role),
      subscriptionExpiresAt: session.subscription_expires_at,
      plan: session.plan,
      planDetails: getPlanDetails(session.plan, {
        memberLimit: session.member_limit,
        activeImplementationLimit: session.active_implementation_limit,
        templateLimit: session.template_limit
      })
    };
    return authorize();
  }

  app.get("/api/product/me", requireSession, (req, res) => {
    const justonecx = createJustOneCXIdentity(req.product.userId, req.product.workspaceId);
    res.json({
      user: { id: req.product.userId, email: req.product.email },
      workspace: {
        id: req.product.workspaceId,
        name: req.product.workspaceName,
        role: req.product.role,
        capabilities: req.product.capabilities,
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
            SELECT m.user_id FROM product_memberships m
            WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.user_id != $3
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
            await writeAuditLog({
              workspaceId: membership.workspace_id,
              actorId: `user:${req.product.userId}`,
              actorEmail: req.product.email,
              ipAddress: req.ip,
              action: "workspace.deleted_with_last_member",
              diff: { reason: "account_deletion" }
            });
            await (database.prepare("DELETE FROM product_workspaces WHERE id = $1").run(membership.workspace_id));
            continue;
          }
          if (membership.role === "owner") {
            const newOwnerUserId = transferByWorkspace.get(membership.workspace_id);
            await (database.prepare(`
              UPDATE product_memberships SET role = 'owner'
              WHERE workspace_id = $1 AND user_id = $2
            `).run(membership.workspace_id, newOwnerUserId));
            await writeAuditLog({
              workspaceId: membership.workspace_id,
              actorId: `user:${req.product.userId}`,
              actorEmail: req.product.email,
              ipAddress: req.ip,
              action: "workspace.owner_transferred",
              diff: { fromUserId: req.product.userId, toUserId: newOwnerUserId }
            });
          }
          await writeAuditLog({
            workspaceId: membership.workspace_id,
            actorId: `user:${req.product.userId}`,
            actorEmail: req.product.email,
            ipAddress: req.ip,
            action: "workspace.member_removed",
            diff: { userId: req.product.userId, role: membership.role, reason: "account_deletion" }
          });
          await (database.prepare("DELETE FROM product_memberships WHERE workspace_id = $1 AND user_id = $2")
            .run(membership.workspace_id, req.product.userId));
        }

        await database.prepare("SELECT set_config('relay.audit_privacy_scrub', 'on', true)").get();
        for (const membership of memberships) {
          await database.prepare(`
            UPDATE audit_logs SET actor_email = '', ip_address = ''
            WHERE actor_id = $1 OR workspace_id = $2
          `).run(`user:${req.product.userId}`, membership.workspace_id);
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
    const features = req.product.planDetails.features;
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
      WHERE i.workspace_id = $1 AND i.archived_at IS NULL
      ORDER BY i.created_at DESC, i.id DESC
    `).all(workspaceId));
    const archivedImplementations = await database.prepare(`
      SELECT i.id, i.customer_name, i.archived_at, t.name AS template_name
      FROM product_implementations i
      JOIN product_templates t ON t.id = i.template_id
      WHERE i.workspace_id = $1 AND i.archived_at IS NOT NULL
      ORDER BY i.archived_at DESC, i.id DESC
    `).all(workspaceId);
    const requirementsByImplementation = new Map();
    if (implementations.length) {
      const inputRows = await database.prepare(`
        SELECT i.id AS implementation_id, r.name, r.input_type, COALESCE(c.value, '') AS value
        FROM product_implementations i
        JOIN product_requirements r ON r.workspace_id = i.workspace_id
          AND (r.template_id IS NULL OR r.template_id = i.template_id)
        LEFT JOIN product_customer_inputs c
          ON c.requirement_id = r.id AND c.implementation_id = i.id
        WHERE i.workspace_id = $1 AND i.archived_at IS NULL
      `).all(workspaceId);
      for (const row of inputRows) {
        const scopedRequirements = requirementsByImplementation.get(row.implementation_id) || [];
        scopedRequirements.push(row);
        requirementsByImplementation.set(row.implementation_id, scopedRequirements);
      }
    }
    for (const implementation of implementations) {
      const scopedRequirements = requirementsByImplementation.get(implementation.id) || [];
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
      if (!features.blockers) {
        implementation.blocked_steps = 0;
        implementation.blocked_step_names = "";
      }
      if (implementation.completed_steps > 0 && implementation.open_steps > 0 && implementation.last_completed_at) {
        const elapsedDays = Math.max(1,
          (Date.parse(implementation.last_completed_at) - Date.parse(implementation.created_at)) / 86400000);
        const daysRemaining = Math.ceil((elapsedDays / implementation.completed_steps) * implementation.open_steps);
        implementation.projected_completion = new Date(Date.now() + daysRemaining * 86400000).toISOString().slice(0, 10);
      } else {
        implementation.projected_completion = implementation.open_steps === 0 ? new Date().toISOString().slice(0, 10) : "";
      }
    }
    if (req.product.role === "executive_viewer") {
      const activeImplementationCount = await countActiveImplementations(workspaceId);
      return res.json({
        processes: [],
        templates: [],
        implementations: [],
        archivedImplementations: [],
        requirements: [],
        members: [],
        invites: [],
        teamWorkload: [],
        notificationSettings: { email_enabled: false, reminder_days_before: 2 },
        integrations: [],
        capacityPlans: [],
        role: req.product.role,
        capabilities: req.product.capabilities,
        plan: req.product.planDetails,
        usage: { members: 0, pendingInvites: 0, templates: 0, activeImplementations: activeImplementationCount }
      });
    }
    const requirements = await (database.prepare(
      "SELECT id, name, description, required, input_type, template_id FROM product_requirements WHERE workspace_id = $1 ORDER BY id"
    ).all(workspaceId));
    const members = await (database.prepare(`
      SELECT u.id, u.email, m.role,
        m.default_internal_cost_rate, m.default_billable_rate
      FROM product_memberships m JOIN product_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY m.role = 'owner' DESC, u.email
    `).all(workspaceId));
    const invites = await (database.prepare(`
      SELECT id, invited_email, role, expires_at, created_at
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
        AND i.archived_at IS NULL
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
        hubspot_onboarding_last_error, hubspot_onboarding_last_error_at,
        webhook_url_cipher != '' AS has_slack_webhook,
        configuration_json, last_synced_at, last_sync_error
      FROM product_workspace_integrations WHERE workspace_id = $1
      ORDER BY provider
    `).all(workspaceId));
    const capacityPlans = await database.prepare(`
      SELECT c.user_id, u.email AS user_email, c.week_start, c.available_minutes, c.capacity_note
      FROM product_capacity_plans c JOIN product_users u ON u.id = c.user_id
      WHERE c.workspace_id = $1 ORDER BY c.week_start DESC, u.email
    `).all(workspaceId);
    const activeImplementationCount = await countActiveImplementations(workspaceId);
    const isContributor = req.product.role === "contributor";
    const canAdministerWorkspace = req.product.capabilities.administerWorkspace;
    const engineeringProviders = req.product.capabilities.manageTasks && features.enterpriseIntegrations
      ? await database.prepare(`
        SELECT provider FROM product_workspace_integrations
        WHERE workspace_id = $1 AND provider IN ('jira', 'linear')
        ORDER BY provider
      `).all(workspaceId)
      : [];
    return res.json({
      processes: canAdministerWorkspace ? processes : [],
      templates: isContributor ? [] : templates,
      implementations,
      archivedImplementations: canAdministerWorkspace ? archivedImplementations : [],
      requirements: isContributor ? [] : requirements,
      members: members.map((member) => {
        const { default_internal_cost_rate, default_billable_rate, ...publicMember } = member;
        return isWorkspaceAdmin(req.product.role) && features.financialProtection
          ? { ...publicMember, default_internal_cost_rate, default_billable_rate }
          : publicMember;
      }),
      invites: canAdministerWorkspace ? invites : [],
      teamWorkload: features.portfolioFull && !isContributor ? teamWorkload : [],
      notificationSettings: canAdministerWorkspace
        ? notificationSettings : { email_enabled: false, reminder_days_before: 2 },
      integrations: canAdministerWorkspace
        && (features.hubspot || features.slackAlerts || features.enterpriseIntegrations) ? integrations : [],
      engineeringProviders: engineeringProviders.map((integration) => integration.provider),
      capacityPlans: canAdministerWorkspace ? capacityPlans : [],
      role: req.product.role,
      capabilities: req.product.capabilities,
      plan: req.product.planDetails,
      usage: {
        members: members.length,
        pendingInvites: canAdministerWorkspace ? invites.length : 0,
        templates: isContributor ? 0 : templates.length,
        activeImplementations: activeImplementationCount
      }
    });
  });

  app.patch("/api/product/notifications", sameOrigin, requireSession, async (req, res) => {
      if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can change notification settings.");
      const emailEnabled = req.body.emailEnabled;
      const reminderDaysBefore = req.body.reminderDaysBefore;
      if (typeof emailEnabled !== "boolean" || !Number.isInteger(reminderDaysBefore)
        || reminderDaysBefore < 0 || reminderDaysBefore > 30) {
        return sendError(res, 400, "Choose whether email notifications are enabled and a reminder window from 0 to 30 days.");
      }
      await database.transaction(async () => {
        const previous = await database.prepare(`
          SELECT email_enabled, reminder_days_before
          FROM product_workspace_notification_settings WHERE workspace_id = $1 FOR UPDATE
        `).get(req.product.workspaceId);
        await database.prepare(`
          INSERT INTO product_workspace_notification_settings (workspace_id, email_enabled, reminder_days_before, updated_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          ON CONFLICT (workspace_id) DO UPDATE SET
            email_enabled = excluded.email_enabled,
            reminder_days_before = excluded.reminder_days_before,
            updated_at = CURRENT_TIMESTAMP
        `).run(req.product.workspaceId, emailEnabled, reminderDaysBefore);
        await writeAuditLog({
          workspaceId: req.product.workspaceId,
          actorId: `user:${req.product.userId}`,
          actorEmail: req.product.email,
          ipAddress: req.ip,
          action: "workspace.notification_settings_updated",
          diff: {
            before: previous || null,
            after: { email_enabled: emailEnabled, reminder_days_before: reminderDaysBefore }
          }
        });
      });
      return res.json({ emailEnabled, reminderDaysBefore });
    });

  app.post("/api/product/integrations/:provider/connect", sameOrigin, requireSession, async (req, res) => {
      const { provider } = req.params;
      if (!["hubspot", "salesforce"].includes(provider)) return sendError(res, 404, "Integration not found.");
      const feature = provider === "hubspot" ? "hubspot" : "enterpriseIntegrations";
      const featureName = provider === "hubspot" ? "HubSpot handoff" : "Salesforce SKU onboarding";
      if (!requirePlanFeature(req, res, feature, featureName,
        provider === "salesforce" ? "custom" : "growth")) return;
      if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can connect integrations.");
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
          `${provider === "salesforce" ? "Salesforce" : "HubSpot"} OAuth setup is incomplete. Configure ${missingConfiguration.join(", ")} in the Relay deployment.`);
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
      const salesforceLoginUrl = provider === "salesforce"
        ? normalizeSalesforceLoginUrl(process.env.SALESFORCE_LOGIN_URL) : "";
      if (provider === "salesforce" && !salesforceLoginUrl) {
        return sendError(res, 503, "SALESFORCE_LOGIN_URL must be login.salesforce.com or test.salesforce.com.");
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
      if (provider === "salesforce") {
        authorizationUrl.href = `${salesforceLoginUrl}/services/oauth2/authorize`;
      }
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizationUrl.searchParams.set("state", rawState);
      authorizationUrl.searchParams.set("scope", provider === "salesforce"
        ? "api refresh_token"
        : "crm.objects.deals.read crm.objects.deals.write crm.objects.contacts.read crm.schemas.deals.read");
      return res.json({ authorizationUrl: authorizationUrl.toString() });
    });

  app.put("/api/product/integrations/slack", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "slackAlerts", "Slack alerts")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure Slack alerts.");
    const webhook = normalizeSlackWebhookUrl(req.body.webhookUrl);
    if (!webhook) {
      return sendError(res, 400, "Enter a valid HTTPS Slack incoming webhook URL.");
    }
    let encryptedWebhook;
    try {
      encryptedWebhook = encryptIntegrationValue(webhook.href);
    } catch (error) {
      console.error(JSON.stringify({ event: "slack_encryption_not_configured", workspace_id: req.product.workspaceId, message: error.message }));
      return sendError(res, 503, "Integration token storage is not configured. Set INTEGRATION_ENCRYPTION_KEY in the Relay deployment.");
    }
    await database.transaction(async () => {
      await database.prepare(`
        INSERT INTO product_workspace_integrations
          (workspace_id, provider, access_token_cipher, webhook_url_cipher, connected_by, updated_at)
        VALUES ($1, 'slack', '', $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (workspace_id, provider) DO UPDATE SET
          webhook_url_cipher = excluded.webhook_url_cipher,
          connected_by = excluded.connected_by,
          updated_at = CURRENT_TIMESTAMP
      `).run(req.product.workspaceId, encryptedWebhook, req.product.userId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "integration.slack_configured",
        diff: { connected: true }
      });
    });
    return res.json({ success: true, connected: true });
  });

  app.post("/api/product/integrations/slack/test", sameOrigin, requireSession,
    limitRequests("slack-connection-test", 3, 15 * 60 * 1000, "Too many Slack tests. Please wait before trying again."),
    async (req, res) => {
      if (!requirePlanFeature(req, res, "slackAlerts", "Slack alerts")) return;
      if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can test Slack alerts.");
      const integration = await database.prepare(`
        SELECT webhook_url_cipher FROM product_workspace_integrations
        WHERE workspace_id = $1 AND provider = 'slack' AND webhook_url_cipher != ''
      `).get(req.product.workspaceId);
      if (!integration) return sendError(res, 404, "Configure a Slack webhook before sending a test.");
      let webhook;
      try {
        webhook = decryptIntegrationValue(integration.webhook_url_cipher);
      } catch {
        console.error(JSON.stringify({ event: "slack_saved_webhook_decryption_failed", workspace_id: req.product.workspaceId }));
        return sendError(res, 503, "The saved Slack webhook cannot be decrypted. Replace it or contact the Relay administrator.");
      }
      const delivery = await sendSlackWebhook(
        webhook,
        "Relay connection test. This channel is ready to receive workspace alerts."
      );
      if (!delivery.success) {
        console.error(JSON.stringify({
          event: "slack_test_message_failed",
          workspace_id: req.product.workspaceId,
          provider_status: delivery.status
        }));
        return sendError(res, delivery.status === 400 ? 500 : 502, delivery.message);
      }
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: req.product.userId,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "integration.slack_tested",
        diff: { success: true }
      });
      return res.json({ success: true, message: "Slack test message delivered." });
    });

  app.put("/api/product/integrations/jira", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "enterpriseIntegrations", "Jira engineering sync", "custom")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure Jira.");
    const baseUrl = normalizeJiraBaseUrl(req.body.baseUrl);
    const email = requiredText(req.body.email, 254).toLowerCase();
    const projectKey = requiredText(req.body.projectKey, 50);
    const issueType = requiredText(req.body.issueType, 100);
    const apiToken = requiredText(req.body.apiToken, 2048);
    if (!baseUrl || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || !/^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(projectKey) || !issueType) {
      return sendError(res, 400, "Enter a Jira Cloud URL, account email, project key, and issue type.");
    }
    const savedIntegration = await database.prepare(`
      SELECT access_token_cipher FROM product_workspace_integrations
      WHERE workspace_id = $1 AND provider = 'jira'
    `).get(req.product.workspaceId);
    if (!apiToken && !savedIntegration) return sendError(res, 400, "Enter a Jira API token.");
    let token = apiToken;
    if (!token) {
      try {
        token = decryptIntegrationValue(savedIntegration.access_token_cipher);
      } catch {
        return sendError(res, 503, "The saved Jira token cannot be decrypted. Enter a replacement token.");
      }
    }
    let verified;
    try {
      verified = await testJiraConnection({ baseUrl, email, projectKey, token });
    } catch (error) {
      return sendError(res, 502, error.message);
    }
    let encryptedToken;
    try {
      encryptedToken = apiToken ? encryptIntegrationValue(token) : savedIntegration.access_token_cipher;
    } catch (error) {
      console.error(JSON.stringify({
        event: "engineering_integration_encryption_failed",
        provider: "jira",
        workspace_id: req.product.workspaceId,
        message: error.message
      }));
      return sendError(res, 503, "Integration token storage is not configured. Set INTEGRATION_ENCRYPTION_KEY.");
    }
    const config = {
      baseUrl: verified.baseUrl,
      email,
      projectId: verified.projectId,
      projectKey: verified.projectKey,
      issueType
    };
    await database.transaction(async () => {
      await database.prepare(`
        INSERT INTO product_workspace_integrations
          (workspace_id, provider, access_token_cipher, external_account_id,
            configuration_json, connected_by, updated_at)
        VALUES ($1, 'jira', $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (workspace_id, provider) DO UPDATE SET
          access_token_cipher = excluded.access_token_cipher,
          external_account_id = excluded.external_account_id,
          configuration_json = excluded.configuration_json,
          connected_by = excluded.connected_by,
          last_sync_error = '', updated_at = CURRENT_TIMESTAMP
      `).run(req.product.workspaceId, encryptedToken, verified.projectId,
        JSON.stringify(config), req.product.userId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "integration.jira_configured",
        diff: {
          connected: true,
          site: verified.baseUrl,
          projectKey: verified.projectKey,
          issueType
        }
      });
    });
    return res.json({ success: true, connected: true, projectName: verified.projectName });
  });

  app.put("/api/product/integrations/linear", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "enterpriseIntegrations", "Linear engineering sync", "custom")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure Linear.");
    const apiToken = requiredText(req.body.apiToken, 2048);
    const teamId = requiredText(req.body.teamId, 36);
    if (!teamId) return sendError(res, 400, "Enter a Linear team ID.");
    const savedIntegration = await database.prepare(`
      SELECT access_token_cipher FROM product_workspace_integrations
      WHERE workspace_id = $1 AND provider = 'linear'
    `).get(req.product.workspaceId);
    if (!apiToken && !savedIntegration) return sendError(res, 400, "Enter a Linear API key.");
    let token = apiToken;
    if (!token) {
      try {
        token = decryptIntegrationValue(savedIntegration.access_token_cipher);
      } catch {
        return sendError(res, 503, "The saved Linear key cannot be decrypted. Enter a replacement key.");
      }
    }
    let verified;
    try {
      verified = await testLinearConnection({ token, teamId });
    } catch (error) {
      return sendError(res, 502, error.message);
    }
    let encryptedToken;
    try {
      encryptedToken = apiToken ? encryptIntegrationValue(token) : savedIntegration.access_token_cipher;
    } catch (error) {
      console.error(JSON.stringify({
        event: "engineering_integration_encryption_failed",
        provider: "linear",
        workspace_id: req.product.workspaceId,
        message: error.message
      }));
      return sendError(res, 503, "Integration token storage is not configured. Set INTEGRATION_ENCRYPTION_KEY.");
    }
    const config = { teamId: verified.teamId, teamName: verified.teamName };
    await database.transaction(async () => {
      await database.prepare(`
        INSERT INTO product_workspace_integrations
          (workspace_id, provider, access_token_cipher, external_account_id,
            configuration_json, connected_by, updated_at)
        VALUES ($1, 'linear', $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (workspace_id, provider) DO UPDATE SET
          access_token_cipher = excluded.access_token_cipher,
          external_account_id = excluded.external_account_id,
          configuration_json = excluded.configuration_json,
          connected_by = excluded.connected_by,
          last_sync_error = '', updated_at = CURRENT_TIMESTAMP
      `).run(req.product.workspaceId, encryptedToken, verified.externalAccountId,
        JSON.stringify(config), req.product.userId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "integration.linear_configured",
        diff: { connected: true, teamId: verified.teamId, teamName: verified.teamName }
      });
    });
    return res.json({ success: true, connected: true, teamName: verified.teamName });
  });

  app.get("/api/product/integrations/salesforce/catalog", requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "enterpriseIntegrations", "Salesforce SKU onboarding", "custom")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure Salesforce SKU mappings.");
    try {
      const integration = await database.prepare(`
        SELECT access_token_cipher, refresh_token_cipher, token_expires_at, configuration_json
        FROM product_workspace_integrations
        WHERE workspace_id = $1 AND provider = 'salesforce'
      `).get(req.product.workspaceId);
      if (!integration) return sendError(res, 404, "Connect Salesforce before configuring SKU mappings.");
      const accessToken = await salesforceAccessToken(integration, req.product.workspaceId, database);
      const result = await salesforceApiRequest(integration, accessToken,
        `/services/data/${SALESFORCE_API_VERSION}/query/`,
        "SELECT ProductCode, Name FROM Product2 WHERE IsActive = TRUE AND ProductCode != NULL ORDER BY ProductCode LIMIT 2000");
      const mappings = await database.prepare(`
        SELECT m.sku, m.template_id, t.name AS template_name
        FROM product_salesforce_sku_template_mappings m
        JOIN product_templates t ON t.id = m.template_id
        WHERE m.workspace_id = $1 ORDER BY m.sku
      `).all(req.product.workspaceId);
      const templates = await database.prepare(`
        SELECT id, name FROM product_templates WHERE workspace_id = $1 ORDER BY name, id
      `).all(req.product.workspaceId);
      const failedImports = await database.prepare(`
        SELECT opportunity_id, opportunity_name, last_error, updated_at
        FROM product_salesforce_imports
        WHERE workspace_id = $1 AND status = 'failed'
        ORDER BY updated_at DESC LIMIT 50
      `).all(req.product.workspaceId);
      return res.json({
        products: (result.records || []).filter((item) => typeof item.ProductCode === "string")
          .map((item) => ({ sku: item.ProductCode, name: String(item.Name || item.ProductCode) })),
        mappings,
        templates,
        failedImports
      });
    } catch (error) {
      return sendError(res, 502, error.message);
    }
  });

  app.put("/api/product/integrations/salesforce/sku-mappings", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "enterpriseIntegrations", "Salesforce SKU onboarding", "custom")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure Salesforce SKU mappings.");
    if (!Array.isArray(req.body.mappings) || req.body.mappings.length > 200) {
      return sendError(res, 400, "Choose up to 200 Salesforce SKU-to-template mappings.");
    }
    const mappings = [];
    const seenSkus = new Set();
    for (const item of req.body.mappings) {
      const sku = requiredText(item?.sku, 120);
      const templateId = validId(item?.templateId);
      if (!sku || !templateId || seenSkus.has(sku)) {
        return sendError(res, 400, "Each SKU needs one valid Relay template and cannot be duplicated.");
      }
      seenSkus.add(sku);
      mappings.push({ sku, templateId });
    }
    const integration = await database.prepare(`
      SELECT access_token_cipher, refresh_token_cipher, token_expires_at, configuration_json
      FROM product_workspace_integrations
      WHERE workspace_id = $1 AND provider = 'salesforce'
    `).get(req.product.workspaceId);
    if (!integration) return sendError(res, 404, "Connect Salesforce before configuring SKU mappings.");
    try {
      const accessToken = await salesforceAccessToken(integration, req.product.workspaceId, database);
      const catalog = await salesforceApiRequest(integration, accessToken,
        `/services/data/${SALESFORCE_API_VERSION}/query/`,
        "SELECT ProductCode FROM Product2 WHERE IsActive = TRUE AND ProductCode != NULL ORDER BY ProductCode LIMIT 2000");
      const availableSkus = new Set((catalog.records || []).map((item) => item.ProductCode).filter(Boolean));
      if (mappings.some((item) => !availableSkus.has(item.sku))) {
        return sendError(res, 400, "A selected SKU is not available in the connected Salesforce product catalog.");
      }
      const templateIds = [...new Set(mappings.map((item) => item.templateId))];
      const templates = await database.prepare(`
        SELECT id, steps_json FROM product_templates
        WHERE workspace_id = $1 AND id = ANY($2::int[])
      `).all(req.product.workspaceId, templateIds);
      if (templates.length !== templateIds.length
        || templates.some((template) => !Array.isArray(JSON.parse(template.steps_json))
          || !JSON.parse(template.steps_json).length)) {
        return sendError(res, 400, "Every mapped template must belong to this workspace and contain at least one task.");
      }
      await database.transaction(async () => {
        const previous = await database.prepare(`
          SELECT sku, template_id FROM product_salesforce_sku_template_mappings
          WHERE workspace_id = $1 ORDER BY sku
        `).all(req.product.workspaceId);
        await database.prepare(`
          DELETE FROM product_salesforce_sku_template_mappings WHERE workspace_id = $1
        `).run(req.product.workspaceId);
        for (const mapping of mappings) {
          await database.prepare(`
            INSERT INTO product_salesforce_sku_template_mappings
              (workspace_id, sku, template_id, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          `).run(req.product.workspaceId, mapping.sku, mapping.templateId, req.product.userId);
        }
        await writeAuditLog({
          workspaceId: req.product.workspaceId,
          actorId: `user:${req.product.userId}`,
          actorEmail: req.product.email,
          ipAddress: req.ip,
          action: "integration.salesforce_sku_mappings_updated",
          diff: { before: previous, after: mappings }
        });
      });
      return res.json({ success: true, count: mappings.length });
    } catch (error) {
      return sendError(res, 502, error.message);
    }
  });

  app.post("/api/product/implementations/:implementationId/tasks/:taskId/escalate",
    sameOrigin, requireSession, async (req, res) => {
      if (!requirePlanFeature(req, res, "enterpriseIntegrations", "Engineering issue sync", "custom")) return;
      if (!req.product.capabilities.manageTasks) return sendError(res, 403, "You cannot escalate implementation tasks.");
      const implementationId = validId(req.params.implementationId);
      const taskId = validId(req.params.taskId);
      const provider = req.body.provider;
      if (!implementationId || !taskId || !["jira", "linear"].includes(provider)) {
        return sendError(res, 400, "Choose a task and a configured Jira or Linear provider.");
      }
      try {
        const issue = await database.transaction(async () => {
          const task = await database.prepare(`
            SELECT step.id, step.title, step.description, step.due_at, implementation.id AS implementation_id,
              implementation.customer_name, implementation.projected_go_live_date
            FROM product_implementation_steps step
            JOIN product_implementations implementation ON implementation.id = step.implementation_id
            WHERE implementation.id = $1 AND step.id = $2 AND implementation.workspace_id = $3
              AND implementation.archived_at IS NULL AND step.status != 'done'
            FOR UPDATE OF step
          `).get(implementationId, taskId, req.product.workspaceId);
          if (!task) throw Object.assign(new Error("Open implementation task not found."), { status: 404 });
          const integration = await database.prepare(`
            SELECT access_token_cipher, configuration_json
            FROM product_workspace_integrations
            WHERE workspace_id = $1 AND provider = $2
          `).get(req.product.workspaceId, provider);
          if (!integration) {
            throw Object.assign(new Error(`Configure ${provider === "jira" ? "Jira" : "Linear"} first.`), { status: 409 });
          }
          const exists = await database.prepare(`
            SELECT external_key, external_url FROM product_external_issue_links
            WHERE workspace_id = $1 AND task_id = $2 AND provider = $3
          `).get(req.product.workspaceId, taskId, provider);
          if (exists) {
            throw Object.assign(new Error("This task is already linked to an issue."), { status: 409 });
          }
          let token;
          try {
            token = decryptIntegrationValue(integration.access_token_cipher);
          } catch {
            throw Object.assign(new Error(`The saved ${provider} credential cannot be decrypted. Replace it in Integrations.`), { status: 503 });
          }
          const issueInput = {
            config: integrationConfiguration(integration),
            token,
            title: task.title,
            description: task.description,
            customerName: task.customer_name,
            goLiveDate: task.projected_go_live_date,
            taskDueAt: task.due_at
          };
          let issue;
          try {
            issue = provider === "jira"
              ? await createJiraIssue(issueInput)
              : await createLinearIssue(issueInput);
          } catch (error) {
            throw Object.assign(error, { status: 502 });
          }
          const inserted = await database.prepare(`
            INSERT INTO product_external_issue_links
              (workspace_id, task_id, provider, external_issue_id, external_key,
                external_url, last_status, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)
            ON CONFLICT (task_id, provider) DO NOTHING
            RETURNING id
          `).get(req.product.workspaceId, taskId, provider, issue.id, issue.key, issue.url, req.product.userId);
          if (!inserted) throw Object.assign(new Error("This task was linked to an issue by another team member."), { status: 409 });
          await writeAuditLog({
            workspaceId: req.product.workspaceId,
            actorId: `user:${req.product.userId}`,
            actorEmail: req.product.email,
            ipAddress: req.ip,
            action: `task.escalated_to_${provider}`,
            diff: { taskId, implementationId, issueKey: issue.key }
          });
          return issue;
        });
        return res.status(201).json({ provider, issueKey: issue.key, issueUrl: issue.url });
      } catch (error) {
        if (error.status) return sendError(res, error.status, error.message);
        throw error;
      }
    });

  app.get("/api/product/integrations/hubspot/pipelines", requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "hubspot", "HubSpot handoff")) return;
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
    if (!requirePlanFeature(req, res, "hubspot", "HubSpot handoff")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure HubSpot handoff.");
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
      await database.transaction(async () => {
        const previous = await database.prepare(`
          SELECT hubspot_onboarding_pipeline_id, hubspot_onboarding_stage_id,
            hubspot_onboarding_template_id
          FROM product_workspace_integrations
          WHERE workspace_id = $1 AND provider = 'hubspot' FOR UPDATE
        `).get(req.product.workspaceId);
        await database.prepare(`
          UPDATE product_workspace_integrations
          SET hubspot_onboarding_pipeline_id = $1, hubspot_onboarding_stage_id = $2,
            hubspot_onboarding_template_id = $3, hubspot_onboarding_last_synced_at = CURRENT_TIMESTAMP,
            hubspot_onboarding_last_error = '', hubspot_onboarding_last_error_at = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $4 AND provider = 'hubspot'
        `).run(pipelineId, stageId, templateId, req.product.workspaceId);
        await writeAuditLog({
          workspaceId: req.product.workspaceId,
          actorId: `user:${req.product.userId}`,
          actorEmail: req.product.email,
          ipAddress: req.ip,
          action: "integration.hubspot_handoff_configured",
          diff: {
            before: previous || null,
            after: {
              hubspot_onboarding_pipeline_id: pipelineId,
              hubspot_onboarding_stage_id: stageId,
              hubspot_onboarding_template_id: templateId
            }
          }
        });
      });
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
      if (!["hubspot", "salesforce"].includes(provider)
        || !/^[A-Za-z0-9_-]{40,60}$/.test(stateToken) || !code) {
        return redirectToSettings("connect_failed");
      }
      const pending = await database.prepare(`
        SELECT integration_state.state_hash, integration_state.workspace_id, integration_state.created_by
        FROM product_integration_states integration_state
        JOIN product_workspace_subscriptions subscription
          ON subscription.workspace_id = integration_state.workspace_id
        WHERE integration_state.state_hash = $1 AND integration_state.provider = $2
          AND integration_state.expires_at > CURRENT_TIMESTAMP
          AND subscription.expires_at > CURRENT_TIMESTAMP
          AND (
            ($2 = 'hubspot' AND subscription.plan IN ('growth', 'custom'))
            OR ($2 = 'salesforce' AND subscription.plan = 'custom')
          )
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
        const salesforceLoginUrl = provider === "salesforce"
          ? normalizeSalesforceLoginUrl(process.env.SALESFORCE_LOGIN_URL) : "";
        if (provider === "salesforce" && !salesforceLoginUrl) throw new Error("Salesforce login host is not configured.");
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
          code
        });
        const tokenEndpoint = provider === "salesforce"
          ? `${salesforceLoginUrl}/services/oauth2/token`
          : "https://api.hubapi.com/oauth/v3/token";
        const response = await fetch(tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10000)
        });
        const result = await response.json().catch(() => ({}));
        const salesforceInstanceUrl = provider === "salesforce"
          ? normalizeSalesforceInstanceUrl(result.instance_url) : "";
        if (!response.ok || !result.access_token
          || (provider === "salesforce" && (!result.refresh_token || !salesforceInstanceUrl))) {
          console.error(JSON.stringify({ event: "integration_oauth_exchange_failed", provider, provider_status: response.status }));
          return redirectToSettings("connect_failed");
        }
        const providerConfig = provider === "salesforce"
          ? { loginUrl: salesforceLoginUrl, instanceUrl: salesforceInstanceUrl } : {};
        await database.transaction(async () => {
          await database.prepare(`
            INSERT INTO product_workspace_integrations
              (workspace_id, provider, access_token_cipher, refresh_token_cipher, webhook_url_cipher,
               token_expires_at, external_account_id, connected_by, configuration_json, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, CURRENT_TIMESTAMP)
            ON CONFLICT (workspace_id, provider) DO UPDATE SET
              access_token_cipher = excluded.access_token_cipher,
              refresh_token_cipher = excluded.refresh_token_cipher,
              webhook_url_cipher = excluded.webhook_url_cipher,
              token_expires_at = excluded.token_expires_at,
              external_account_id = excluded.external_account_id,
              configuration_json = excluded.configuration_json,
              connected_by = excluded.connected_by,
              updated_at = CURRENT_TIMESTAMP
          `).run(
            pending.workspace_id,
            provider,
            encryptIntegrationValue(result.access_token),
            result.refresh_token ? encryptIntegrationValue(result.refresh_token) : "",
            "",
            new Date(Date.now() + (Number(result.expires_in) || 3600) * 1000).toISOString(),
            provider === "salesforce" ? String(result.id || "").split("/").filter(Boolean).pop() || "" : String(result.hub_id || ""),
            pending.created_by,
            JSON.stringify(providerConfig)
          );
          await writeAuditLog({
            workspaceId: pending.workspace_id,
            actorId: `user:${pending.created_by}`,
            action: `integration.${provider}_connected`,
            diff: {
              connected: true,
              externalAccountId: provider === "salesforce"
                ? String(result.id || "").split("/").filter(Boolean).pop() || ""
                : String(result.hub_id || "")
            }
          });
        });
        return redirectToSettings(`${provider}_connected`);
      } catch (error) {
        console.error(JSON.stringify({ event: "integration_oauth_callback_failed", provider, message: error.message }));
        return redirectToSettings("connect_failed");
      }
    });

  app.delete("/api/product/integrations/:provider", sameOrigin, requireSession, async (req, res) => {
      const { provider } = req.params;
      if (!["hubspot", "slack", "salesforce", "jira", "linear"].includes(provider)) {
        return sendError(res, 404, "Integration not found.");
      }
      if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can disconnect integrations.");
      await database.transaction(async () => {
        const existing = await database.prepare(`
          SELECT provider FROM product_workspace_integrations
          WHERE workspace_id = $1 AND provider = $2 FOR UPDATE
        `).get(req.product.workspaceId, provider);
        if (!existing) return;
        await database.prepare(
          "DELETE FROM product_workspace_integrations WHERE workspace_id = $1 AND provider = $2"
        ).run(req.product.workspaceId, provider);
        await writeAuditLog({
          workspaceId: req.product.workspaceId,
          actorId: `user:${req.product.userId}`,
          actorEmail: req.product.email,
          ipAddress: req.ip,
          action: "integration.disconnected",
          diff: { provider, connected: false }
        });
      });
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
          AND s.expires_at > CURRENT_TIMESTAMP AND s.plan IN ('growth', 'custom')
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

      const configuredSalesforce = await database.prepare(`
        SELECT integration.workspace_id, integration.access_token_cipher,
          integration.refresh_token_cipher, integration.token_expires_at,
          integration.configuration_json, integration.last_synced_at
        FROM product_workspace_integrations integration
        JOIN product_workspace_subscriptions subscription
          ON subscription.workspace_id = integration.workspace_id
        WHERE integration.provider = 'salesforce'
          AND subscription.expires_at > CURRENT_TIMESTAMP AND subscription.plan = 'custom'
          AND EXISTS (
            SELECT 1 FROM product_salesforce_sku_template_mappings mapping
            WHERE mapping.workspace_id = integration.workspace_id
          )
      `).all();
      let salesforceImportsCreated = 0;
      let salesforceImportFailures = 0;
      for (const integration of configuredSalesforce) {
        try {
          const result = await pollSalesforceOnboarding(integration, req);
          salesforceImportsCreated += result.created;
          salesforceImportFailures += result.failed;
        } catch (error) {
          salesforceImportFailures += 1;
          await database.prepare(`
            UPDATE product_workspace_integrations
            SET last_sync_error = $1, updated_at = CURRENT_TIMESTAMP
            WHERE workspace_id = $2 AND provider = 'salesforce'
          `).run(error.message.slice(0, 500), integration.workspace_id);
          console.error(JSON.stringify({
            event: "salesforce_closed_won_poll_failed",
            workspace_id: integration.workspace_id,
            message: error.message
          }));
        }
      }

      const engineeringIssueLinks = await database.prepare(`
        SELECT link.id, link.workspace_id, link.task_id, link.provider,
          link.external_issue_id, link.external_key, link.last_status,
          integration.access_token_cipher, integration.configuration_json,
          implementation.id AS implementation_id, implementation.customer_name,
          implementation.projected_go_live_date, implementation.archived_at,
          step.status AS task_status, step.title, step.description, step.due_at
        FROM product_external_issue_links link
        JOIN product_workspace_integrations integration
          ON integration.workspace_id = link.workspace_id AND integration.provider = link.provider
        JOIN product_implementation_steps step ON step.id = link.task_id
        JOIN product_implementations implementation ON implementation.id = step.implementation_id
        JOIN product_workspace_subscriptions subscription
          ON subscription.workspace_id = link.workspace_id
        WHERE subscription.expires_at > CURRENT_TIMESTAMP AND subscription.plan = 'custom'
          AND implementation.archived_at IS NULL
        ORDER BY link.last_synced_at NULLS FIRST, link.id
        LIMIT 100
      `).all();
      let engineeringIssuesCompleted = 0;
      let engineeringIssueFailures = 0;
      for (let offset = 0; offset < engineeringIssueLinks.length; offset += 10) {
        await Promise.all(engineeringIssueLinks.slice(offset, offset + 10).map(async (link) => {
          try {
            const config = integrationConfiguration(link);
            const token = decryptIntegrationValue(link.access_token_cipher);
            const status = link.provider === "jira"
              ? await getJiraIssueStatus({ config, token, issueKey: link.external_key })
              : await getLinearIssueStatus({ token, issueId: link.external_issue_id });
            await database.transaction(async () => {
              await database.prepare(`
                UPDATE product_external_issue_links
                SET last_status = $1, last_error = '', last_synced_at = CURRENT_TIMESTAMP,
                  completed_at = CASE WHEN $2 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END,
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = $3 AND workspace_id = $4
              `).run(status.status, status.isDone, link.id, link.workspace_id);
              if (status.isDone && link.task_status !== "done") {
                const updated = await database.prepare(`
                  UPDATE product_implementation_steps step
                  SET status = 'done', updated_at = CURRENT_TIMESTAMP
                  FROM product_implementations implementation
                  WHERE step.id = $1 AND step.implementation_id = implementation.id
                    AND implementation.workspace_id = $2 AND step.status != 'done'
                  RETURNING step.id
                `).get(link.task_id, link.workspace_id);
                if (updated) {
                  engineeringIssuesCompleted += 1;
                  await writeAuditLog({
                    workspaceId: link.workspace_id,
                    actorId: `integration:${link.provider}`,
                    action: `task.completed_from_${link.provider}`,
                    diff: {
                      taskId: link.task_id,
                      implementationId: link.implementation_id,
                      issueKey: link.external_key
                    }
                  });
                }
              }
            });
          } catch (error) {
            engineeringIssueFailures += 1;
            await database.prepare(`
              UPDATE product_external_issue_links
              SET last_error = $1, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE id = $2 AND workspace_id = $3
            `).run(error.message.slice(0, 500), link.id, link.workspace_id);
          }
        }));
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
          AND i.archived_at IS NULL
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
          AND i.archived_at IS NULL
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
          AND i.archived_at IS NULL
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
        SET status = 'processing', available_at = CURRENT_TIMESTAMP + INTERVAL '10 minutes',
          last_attempted_at = CURRENT_TIMESTAMP
        WHERE id IN (
          SELECT id FROM product_workspace_events e
          WHERE status IN ('pending', 'processing') AND available_at <= CURRENT_TIMESTAMP
            AND (e.implementation_id IS NULL OR EXISTS (
              SELECT 1 FROM product_implementations i
              WHERE i.id = e.implementation_id AND i.archived_at IS NULL
            ))
          ORDER BY id
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, workspace_id, implementation_id, event_type, payload, attempts,
          email_sent_at, slack_sent_at, hubspot_synced_at
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
                SET status = 'sent', email_sent_at = CURRENT_TIMESTAMP,
                  processed_at = CURRENT_TIMESTAMP, last_error = ''
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
                      : event.event_type === "change_order.pending"
                        ? `A change order, “${event.payload.title},” is ready for your review in the ${implementation?.customer_name || "customer"} portal.`
              : event.event_type === "customer.information_submitted"
                ? `Customer information was submitted for ${implementation?.customer_name || "a customer"}.`
                : event.event_type === "customer.tasks_completed"
                  ? `Customer completed ${event.payload.count} task(s) for ${implementation?.customer_name || "a customer"}.`
                      : event.event_type === "budget.burn_alert"
                        ? `${event.payload.severity}: ${event.payload.customerName} is at ${event.payload.burnPercent}% of its ${event.payload.budgetType.replaceAll("_", " ")} budget (${event.payload.threshold}% threshold).`
                        : `Task “${event.payload.taskTitle || "Implementation task"}” for ${implementation?.customer_name || "a customer"} is now ${event.payload.status || "updated"}${event.payload.isBlocked ? " and blocked" : ""}.`;
          const settings = await database.prepare(`
            SELECT email_enabled FROM product_workspace_notification_settings WHERE workspace_id = $1
          `).get(event.workspace_id);
          if (!event.email_sent_at) {
            if (settings?.email_enabled) {
              const apiKey = process.env.RESEND_API_KEY?.trim();
              const from = process.env.AUTH_EMAIL_FROM?.trim();
              if (!apiKey || !from) throw new Error("Email notifications are enabled but Resend is not configured.");
              const recipientRows = ["customer.escalation", "customer.task_reminder", "team.message", "change_order.pending"].includes(event.event_type)
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
                          : event.event_type === "change_order.pending"
                            ? `Change order ready for review: ${event.payload.title}`
                      : event.event_type === "budget.burn_alert"
                        ? `${event.payload.severity}: ${event.payload.customerName} (${event.payload.threshold}% budget threshold)`
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
            FROM product_workspace_integrations integration
            JOIN product_workspace_subscriptions subscription
              ON subscription.workspace_id = integration.workspace_id
            WHERE integration.workspace_id = $1
              AND (integration.provider NOT IN ('hubspot', 'slack')
                OR subscription.plan IN ('growth', 'custom'))
          `).all(event.workspace_id);
          const slackEventTypes = new Set([
            "budget.burn_alert",
            "task.reminder",
            "task.updated",
            "implementation.created",
            "change_order.pending"
          ]);
          if (slackEventTypes.has(event.event_type) && !event.slack_sent_at) {
            const slack = integrations.find((item) => item.provider === "slack");
            if (slack?.webhook_url_cipher) {
              const slackMessage = event.event_type === "budget.burn_alert" || event.event_type === "task.reminder"
                ? message
                : `Relay: ${event.event_type.replaceAll(".", " ")} for ${implementation?.customer_name || "a customer"}. Open Relay to review.`;
              const delivery = await sendSlackWebhook(decryptIntegrationValue(slack.webhook_url_cipher), slackMessage);
              if (!delivery.success) throw new Error(delivery.message);
            }
            await database.prepare(
              "UPDATE product_workspace_events SET slack_sent_at = CURRENT_TIMESTAMP WHERE id = $1"
            ).run(event.id);
          }
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
            SET status = 'sent', processed_at = CURRENT_TIMESTAMP, attempts = attempts + 1,
              last_error = ''
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
              processed_at = CASE WHEN $2 >= 5 THEN CURRENT_TIMESTAMP ELSE NULL END,
              last_error = $4
            WHERE id = $1
          `).run(event.id, nextAttempt, retrySeconds, safeDeliveryError(error));
          console.error(JSON.stringify({
            event: "workspace_event_delivery_failed",
            event_id: event.id,
            event_type: event.event_type,
            attempt: nextAttempt,
            message: safeDeliveryError(error)
          }));
        }
      }
      return res.json({
        processed,
        failures,
        remindersQueued: reminders.length + customerTaskReminders.length,
        hubspotImportsCreated,
        hubspotImportFailures,
        salesforceImportsCreated,
        salesforceImportFailures,
        engineeringIssuesCompleted,
        engineeringIssueFailures
      });
    });

  app.post("/api/product/internal/shift-go-live", async (req, res) => {
      const expectedToken = process.env.NOTIFICATIONS_CRON_SECRET?.trim() || "";
      const authorization = req.get("Authorization") || "";
      const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const expectedBuffer = Buffer.from(expectedToken);
      const suppliedBuffer = Buffer.from(suppliedToken);
      if (!expectedToken) return sendError(res, 503, "Go-live scheduling is not configured.");
      if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        return sendError(res, 401, "Not authorized.");
      }
      const utcDate = new Date().toISOString().slice(0, 10);
      const implementations = await database.prepare(`
        SELECT i.id, i.workspace_id, i.projected_go_live_date, i.target_launch_date,
          s.plan, s.member_limit, s.active_implementation_limit, s.template_limit
        FROM product_implementations i
        JOIN product_workspace_subscriptions s ON s.workspace_id = i.workspace_id
        WHERE i.archived_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
        ORDER BY i.id
      `).all();
      let shiftedImplementations = 0;
      let shiftedTasks = 0;
      for (const implementation of implementations) {
        const plan = getPlanDetails(implementation.plan, {
          memberLimit: implementation.member_limit,
          activeImplementationLimit: implementation.active_implementation_limit,
          templateLimit: implementation.template_limit
        });
        if (!plan.features.criticalPath) continue;
        const [tasks, dependencies] = await Promise.all([
          database.prepare(`
            SELECT s.id, s.status, s.due_at, s.responsible_party,
              s.estimated_duration_days, s.customer_visible
            FROM product_implementation_steps s
            WHERE s.implementation_id = $1
          `).all(implementation.id),
          database.prepare(`
            SELECT implementation_step_id, depends_on_step_id
            FROM product_implementation_step_dependencies
            WHERE implementation_step_id IN (
              SELECT id FROM product_implementation_steps WHERE implementation_id = $1
            )
          `).all(implementation.id)
        ]);
        let overdueIds;
        try {
          overdueIds = overdueCriticalClientTaskIds(tasks, dependencies, utcDate);
        } catch (error) {
          console.error(JSON.stringify({
            event: "go_live_shift_cycle_or_invalid_duration",
            implementation_id: implementation.id,
            message: error.message
          }));
          continue;
        }
        if (!overdueIds.size) continue;
        await database.transaction(async () => {
          const lockedImplementation = await database.prepare(`
            SELECT id, projected_go_live_date, target_launch_date
            FROM product_implementations WHERE id = $1 FOR UPDATE
          `).get(implementation.id);
          let projected = lockedImplementation.projected_go_live_date
            || lockedImplementation.target_launch_date
            || utcDate;
          const previousProjected = projected;
          let added = 0;
          const shiftedTaskIds = [];
          for (const stepId of overdueIds) {
            const inserted = await database.prepare(`
              INSERT INTO product_implementation_go_live_shifts
                (implementation_id, step_id, shift_date)
              VALUES ($1, $2, $3::date)
              ON CONFLICT (implementation_id, step_id, shift_date) DO NOTHING
              RETURNING id
            `).get(implementation.id, stepId, utcDate);
            if (!inserted) continue;
            const date = new Date(`${projected}T00:00:00.000Z`);
            if (Number.isNaN(date.valueOf())) {
              date.setUTCFullYear(
                Number(utcDate.slice(0, 4)),
                Number(utcDate.slice(5, 7)) - 1,
                Number(utcDate.slice(8, 10))
              );
            }
            date.setUTCDate(date.getUTCDate() + 1);
            projected = date.toISOString().slice(0, 10);
            added += 1;
            shiftedTaskIds.push(stepId);
          }
          if (added) {
            await database.prepare(`
              UPDATE product_implementations SET projected_go_live_date = $1
              WHERE id = $2
            `).run(projected, implementation.id);
            shiftedImplementations += 1;
            shiftedTasks += added;
            await writeAuditLog({
              workspaceId: implementation.workspace_id,
              implementationId: implementation.id,
              actorId: "system:critical-path-scheduler",
              action: "go_live_date.auto_shifted",
              diff: {
                from: previousProjected,
                to: projected,
                shiftedDays: added,
                taskIds: shiftedTaskIds
              }
            });
          }
        });
      }
      return res.json({ shiftedImplementations, shiftedTasks, utcDate });
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
        WHERE i.workspace_id = $1 AND i.archived_at IS NULL
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

  app.get("/api/product/audit-logs", requireSession, async (req, res) => {
    if (!req.product.capabilities.viewAuditLogs) return sendError(res, 403, "Only workspace admins can review audit logs.");
    const rawLimit = Number(req.query.limit);
    const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
    const rawCursor = req.query.cursor;
    const validCursor = typeof rawCursor === "string" && /^[1-9]\d{0,18}$/.test(rawCursor)
      && BigInt(rawCursor) <= 9223372036854775807n;
    if (rawCursor !== undefined && !validCursor) return sendError(res, 400, "Invalid audit-log cursor.");
    const cursor = validCursor ? rawCursor : null;
    const rows = await database.prepare(`
      SELECT id::text AS id, implementation_id, actor_id, actor_email, ip_address,
        action, diff_json, "timestamp"
      FROM audit_logs
      WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC
      LIMIT $3
    `).all(req.product.workspaceId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit);
    return res.json({
      events,
      nextCursor: hasMore ? events.at(-1)?.id || null : null
    });
  });

  app.get("/api/product/notification-delivery", requireSession, async (req, res) => {
    if (!req.product.capabilities.viewAuditLogs) {
      return sendError(res, 403, "Only workspace admins can review notification delivery.");
    }
    const events = await database.prepare(`
      SELECT id, implementation_id, event_type, status, attempts, last_error,
        last_attempted_at, created_at
      FROM product_workspace_events
      WHERE workspace_id = $1
        AND (
          status = 'failed'
          OR (status IN ('pending', 'processing') AND attempts > 0)
          OR (status = 'processing' AND last_attempted_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes')
        )
      ORDER BY COALESCE(last_attempted_at, created_at) DESC, id DESC
      LIMIT 50
    `).all(req.product.workspaceId);
    return res.json({ events });
  });

  app.post("/api/product/notification-delivery/:eventId/retry", sameOrigin, requireSession, async (req, res) => {
    if (!req.product.capabilities.administerWorkspace) {
      return sendError(res, 403, "Only a workspace admin can retry notification delivery.");
    }
    const eventId = validId(req.params.eventId);
    if (!eventId) return sendError(res, 400, "Invalid notification event.");
    const retry = await database.transaction(async () => {
      const event = await database.prepare(`
        SELECT id, implementation_id, event_type, status, attempts
        FROM product_workspace_events
        WHERE id = $1 AND workspace_id = $2
        FOR UPDATE
      `).get(eventId, req.product.workspaceId);
      if (!event) return { notFound: true };
      if (event.status !== "failed") return { status: event.status };
      await database.prepare(`
        UPDATE product_workspace_events
        SET status = 'pending', attempts = 0, available_at = CURRENT_TIMESTAMP,
          processed_at = NULL, last_error = ''
        WHERE id = $1 AND workspace_id = $2
      `).run(eventId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId: event.implementation_id,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "notification.delivery_retry_requested",
        diff: { eventId, eventType: event.event_type, previousAttempts: event.attempts }
      });
      return { eventType: event.event_type };
    });
    if (retry.notFound) return sendError(res, 404, "Notification event not found.");
    if (retry.status) return sendError(res, 409, "Only failed notification events can be retried.");
    return res.status(202).json({ queued: true, eventType: retry.eventType });
  });

  app.patch("/api/product/team-members/:userId/role", sameOrigin, requireSession, async (req, res) => {
    if (!req.product.capabilities.administerWorkspace) {
      return sendError(res, 403, "Only a workspace admin can change teammate roles.");
    }
    const userId = validId(req.params.userId);
    const role = req.body.role;
    if (!userId || !["admin", "implementation_manager", "contributor", "executive_viewer"].includes(role)) {
      return sendError(res, 400, "Choose a valid teammate and workspace role.");
    }
    if (userId === req.product.userId) {
      return sendError(res, 409, "Ask another workspace admin to change your own role.");
    }
    const updated = await database.transaction(async () => {
      await database.prepare("SELECT id FROM product_workspaces WHERE id = $1 FOR UPDATE")
        .get(req.product.workspaceId);
      const member = await database.prepare(`
        SELECT u.email, m.role FROM product_memberships m
        JOIN product_users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND m.user_id = $2
        FOR UPDATE OF m
      `).get(req.product.workspaceId, userId);
      if (!member) return { error: "Teammate not found.", status: 404 };
      if (member.role === "owner") {
        return { error: "Workspace ownership can only be changed through the account ownership transfer flow.", status: 409 };
      }
      if (member.role === "admin" && role !== "admin") {
        const admins = await database.prepare(`
          SELECT COUNT(*) AS count FROM product_memberships
          WHERE workspace_id = $1 AND role IN ('owner', 'admin')
        `).get(req.product.workspaceId);
        if (Number(admins.count) <= 1) {
          return { error: "A workspace must keep at least one full admin.", status: 409 };
        }
      }
      await database.prepare(`
        UPDATE product_memberships SET role = $1
        WHERE workspace_id = $2 AND user_id = $3
      `).run(role, req.product.workspaceId, userId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "workspace.member_role_changed",
        diff: {
          userId,
          email: member.email,
          before: member.role,
          after: role
        }
      });
      return { member: { id: userId, email: member.email, role } };
    });
    if (updated.error) return sendError(res, updated.status, updated.error);
    return res.json(updated);
  });

  app.post("/api/product/invites", sameOrigin, requireSession, async (req, res) => {
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can invite teammates.");
    const email = requiredText(req.body.email, 254).toLowerCase();
    const role = req.body.role || "contributor";
    if (!["admin", "implementation_manager", "contributor", "executive_viewer"].includes(role)) {
      return sendError(res, 400, "Choose a valid workspace role.");
    }
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
      const created = await database.prepare(`
        INSERT INTO product_workspace_invites (workspace_id, invited_email, role, token_hash, expires_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, role
      `).get(req.product.workspaceId, email, role, hashToken(rawToken), expiresAt, req.product.userId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "workspace.member_invited",
        diff: { email, role, inviteId: created.id }
      });
      return created;
    });
    if (invite.error) return sendError(res, 409, invite.error);
    const inviteUrl = new URL(`/product.html?invite=${encodeURIComponent(rawToken)}`, req.get("Origin")).toString();
    return res.status(201).json({ invite: { id: invite.id, email, role: invite.role, expiresAt, inviteUrl } });
  });

  app.delete("/api/product/invites/:inviteId", sameOrigin, requireSession, async (req, res) => {
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can revoke invitations.");
    const inviteId = validId(req.params.inviteId);
    if (!inviteId) return sendError(res, 400, "Invalid invitation.");
    const revoked = await database.transaction(async () => {
      const invite = await database.prepare(`
        SELECT invited_email, role FROM product_workspace_invites
        WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL FOR UPDATE
      `).get(inviteId, req.product.workspaceId);
      if (!invite) return false;
      const result = await database.prepare(
        "DELETE FROM product_workspace_invites WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL"
      ).run(inviteId, req.product.workspaceId);
      if (!result.changes) return false;
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "workspace.invitation_revoked",
        diff: { inviteId, email: invite.invited_email, role: invite.role }
      });
      return true;
    });
    if (!revoked) return sendError(res, 404, "Invitation not found or already accepted.");
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
    const estimatedDurationDays = req.body.estimatedDurationDays === undefined ? 1 : req.body.estimatedDurationDays;
    const responsibleParty = req.body.responsibleParty === undefined
      ? req.body.customerVisible === true ? "client" : "relay"
      : req.body.responsibleParty;
    const assignee = await (workspaceAssignee(req.product.workspaceId, req.body.assigneeUserId));
    const dependsOn = Array.isArray(req.body.dependsOn) ? req.body.dependsOn.map(validId) : [];
    if (dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length) {
      return sendError(res, 400, "Choose valid, unique prerequisite steps.");
    }
    if (!processId || !title || !stage || !assignee.valid || !Number.isInteger(dueOffsetDays) || dueOffsetDays < 0 || dueOffsetDays > 3650
      || (req.body.customerVisible !== undefined && typeof req.body.customerVisible !== "boolean")
      || !Number.isInteger(estimatedDurationDays) || estimatedDurationDays < 1 || estimatedDurationDays > 3650
      || !["relay", "client"].includes(responsibleParty)) {
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
            (process_id, title, description, owner, position, stage, due_offset_days,
              assignee_user_id, customer_visible, estimated_duration_days, responsible_party)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id, title, description, owner, position, stage, due_offset_days,
            assignee_user_id, customer_visible, estimated_duration_days, responsible_party
        `).get(processId, title, description, owner, position, stage, dueOffsetDays, assignee.id,
        req.body.customerVisible === true, estimatedDurationDays, responsibleParty));
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
    const estimatedDurationDays = req.body.estimatedDurationDays;
    const responsibleParty = req.body.responsibleParty;
    const assignee = await (workspaceAssignee(req.product.workspaceId, req.body.assigneeUserId));
    const dependsOn = Array.isArray(req.body.dependsOn) ? req.body.dependsOn.map(validId) : null;
    if (!processId || !stepId || !title || !stage || !Number.isInteger(dueOffsetDays)
      || dueOffsetDays < 0 || dueOffsetDays > 3650 || !dependsOn
      || dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length || !assignee.valid
      || (req.body.customerVisible !== undefined && typeof req.body.customerVisible !== "boolean")
      || !Number.isInteger(estimatedDurationDays) || estimatedDurationDays < 1 || estimatedDurationDays > 3650
      || !["relay", "client"].includes(responsibleParty)
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
          due_offset_days = $5, assignee_user_id = $6, customer_visible = $7,
          estimated_duration_days = $8, responsible_party = $9
        WHERE id = $10 AND process_id = $11
      `).run(title, description, owner, stage, dueOffsetDays, assignee.id, customerVisible,
        estimatedDurationDays, responsibleParty, stepId, processId));
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
        estimatedDurationDays: step.estimated_duration_days ?? 1,
        responsibleParty: step.responsible_party || (step.customer_visible ? "client" : "relay"),
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
      estimatedDurationDays: step.estimated_duration_days ?? 1,
      responsibleParty: step.responsible_party || (step.customer_visible ? "client" : "relay"),
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
        estimatedDurationDays: step.estimated_duration_days ?? 1,
        responsibleParty: step.responsible_party || (step.customer_visible ? "client" : "relay"),
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
    const salesforceMapping = await database.prepare(`
      SELECT sku FROM product_salesforce_sku_template_mappings
      WHERE workspace_id = $1 AND template_id = $2 ORDER BY sku LIMIT 1
    `).get(req.product.workspaceId, templateId);
    if (salesforceMapping) {
      return sendError(res, 409,
        `This template is mapped to Salesforce SKU ${salesforceMapping.sku}. Update the SKU mapping before deleting it.`);
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

  app.patch("/api/product/implementations/:implementationId/archive", sameOrigin, requireSession, async (req, res) => {
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can archive implementations.");
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const result = await database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT archived_at FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!implementation) return "missing";
      if (implementation.archived_at) return "archived";
      await database.prepare(`
        UPDATE product_implementations SET archived_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND workspace_id = $2
      `).run(implementationId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "implementation.archived",
        diff: { archived: true }
      });
      return "archived_now";
    });
    if (result === "missing") return sendError(res, 404, "Implementation not found.");
    if (result === "archived") return sendError(res, 409, "This implementation is already archived.");
    return res.json({ success: true });
  });

  app.patch("/api/product/implementations/:implementationId/restore", sameOrigin, requireSession, async (req, res) => {
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can restore implementations.");
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const result = await database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT archived_at FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!implementation) return "missing";
      if (!implementation.archived_at) return "active";
      await database.prepare(`
        UPDATE product_implementations SET archived_at = NULL
        WHERE id = $1 AND workspace_id = $2
      `).run(implementationId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "implementation.restored",
        diff: { archived: false }
      });
      return "restored";
    });
    if (result === "missing") return sendError(res, 404, "Implementation not found.");
    if (result === "active") return sendError(res, 409, "This implementation is not archived.");
    return res.json({ success: true });
  });

  app.delete("/api/product/implementations/:implementationId", sameOrigin, requireSession, async (req, res) => {
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can permanently delete implementations.");
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const deleted = await database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT id FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!implementation) return false;
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "implementation.permanently_deleted",
        diff: { permanent: true }
      });
      await database.prepare(
        "DELETE FROM product_implementations WHERE id = $1 AND workspace_id = $2"
      ).run(implementationId, req.product.workspaceId);
      return true;
    });
    if (!deleted) return sendError(res, 404, "Implementation not found.");
    return res.json({ success: true });
  });

  app.use("/api/product/implementations/:implementationId", requireSession, async (req, res, next) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const implementation = await database.prepare(`
      SELECT id FROM product_implementations
      WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
    `).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    return next();
  });

  app.post("/api/product/implementations/:implementationId/customer-link", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const implementation = await (database.prepare(
      "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL"
    ).get(implementationId, req.product.workspaceId));
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const rawToken = randomBytes(32).toString("base64url");
    await database.transaction(async () => {
      await database.prepare(`
        UPDATE product_implementations SET portal_token_hash = $1
        WHERE id = $2 AND workspace_id = $3
      `).run(hashToken(rawToken), implementationId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "customer.portal_link_regenerated",
        diff: { tokenRegenerated: true }
      });
    });
    return res.json({ customerPortalToken: rawToken });
  });

  app.get("/api/product/implementations/:implementationId", requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const hasFinancialProtection = req.product.planDetails.features.financialProtection
      && req.product.capabilities.viewFinancials;
    const hasTimeTracking = req.product.planDetails.features.financialProtection
      && req.product.capabilities.logTime;
    const hasCsvSchemaValidation = req.product.planDetails.features.csvSchemaValidation;
    const hasCredentialVerification = req.product.planDetails.features.credentialVerification;
    const canViewRates = isWorkspaceAdmin(req.product.role);
    const hasChangeOrders = req.product.planDetails.features.changeOrders
      && req.product.capabilities.manageImplementations;
    const implementation = await (database.prepare(`
      SELECT i.id, i.customer_name, i.created_at, i.template_id, i.escalation_email,
        i.escalation_delay_days, i.target_launch_date, i.projected_go_live_date,
        ${hasFinancialProtection ? "i.base_onboarding_fee, i.budget_type, i.budget_limit, i.hard_lock_on_exceed, i.last_alert_threshold_sent," : ""}
        i.customer_owner_name, i.customer_owner_email,
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
      WHERE i.id = $1 AND i.workspace_id = $2 AND i.archived_at IS NULL
    `).get(implementationId, req.product.workspaceId));
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const [
      steps,
      requirements,
      customerContacts,
      customerMessages,
      customerFiles,
      changeOrders,
      launchStakeholders,
      launchRisks,
      approvals,
      timeEntries,
      financialPlan,
      timeTotals,
      calendarEvents
    ] = await Promise.all([
      database.prepare(`
        SELECT s.id, s.title, s.description, s.owner, s.position, s.status, s.updated_at, s.stage,
          s.assignee_user_id, s.customer_visible, u.email AS assignee_email,
          s.due_at, s.is_blocked, s.blocker_reason, s.blocker_next_action,
          s.estimated_duration_days, s.responsible_party,
          ${hasCsvSchemaValidation ? "s.csv_schema_json, s.csv_schema_hash," : ""}
          ${hasCredentialVerification ? "s.credential_verification_json," : ""}
          EXISTS (
            SELECT 1 FROM product_change_order_steps linked
            JOIN product_change_orders co ON co.id = linked.change_order_id
            WHERE linked.step_id = s.id AND co.status = 'pending_client'
          ) AS change_order_locked,
          EXISTS (
            SELECT 1 FROM product_change_order_steps linked
            JOIN product_change_orders co ON co.id = linked.change_order_id
            WHERE linked.step_id = s.id AND co.status = 'approved'
          ) AS change_order_approved,
          COALESCE((SELECT string_agg(parent.title, ', ')
            FROM product_implementation_step_dependencies d
            JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
            WHERE d.implementation_step_id = s.id AND parent.status != 'done'), '') AS waiting_on,
          COALESCE((SELECT json_agg(json_build_object(
              'provider', issue.provider,
              'issue_key', issue.external_key,
              'issue_url', issue.external_url,
              'last_status', issue.last_status,
              'last_error', issue.last_error
            ) ORDER BY issue.provider)
            FROM product_external_issue_links issue
            WHERE issue.task_id = s.id AND issue.workspace_id = $2), '[]'::json) AS engineering_issues
        FROM product_implementation_steps s
        LEFT JOIN product_users u ON u.id = s.assignee_user_id
        WHERE s.implementation_id = $1
        ORDER BY s.position, s.id
      `).all(implementationId, req.product.workspaceId),
      implementationRequirements(implementationId, req.product.workspaceId, implementation.template_id),
      database.prepare(`
        SELECT id, email, display_name, expires_at, invitation_sent_at, revoked_at, last_activity_at, created_at
        FROM product_customer_contacts
        WHERE implementation_id = $1
        ORDER BY created_at DESC, id DESC
      `).all(implementationId),
      database.prepare(`
        SELECT id, sender_role, sender_name, sender_email, body, created_at
        FROM product_customer_messages WHERE implementation_id = $1
        ORDER BY created_at, id
      `).all(implementationId),
      database.prepare(`
        SELECT id, uploaded_by_role, uploaded_by_name, filename, content_type, size_bytes, created_at
        FROM product_customer_files WHERE implementation_id = $1
        ORDER BY created_at DESC, id DESC
      `).all(implementationId),
      hasChangeOrders ? database.prepare(`
        SELECT co.id, co.title, co.scope_description, co.additional_fee,
          co.timeline_extension_days, co.status, co.signed_by_email, co.signed_at,
          co.created_at, co.updated_at,
          COALESCE(array_agg(linked.step_id) FILTER (WHERE linked.step_id IS NOT NULL), '{}') AS task_ids
        FROM product_change_orders co
        LEFT JOIN product_change_order_steps linked
          ON linked.change_order_id = co.id AND linked.implementation_id = co.implementation_id
        WHERE co.implementation_id = $1
        GROUP BY co.id
        ORDER BY co.created_at DESC, co.id DESC
      `).all(implementationId) : Promise.resolve([]),
      database.prepare(`
        SELECT id, display_name, email, role, approval_status, next_action, created_at
        FROM product_launch_stakeholders WHERE implementation_id = $1
        ORDER BY created_at, id
      `).all(implementationId),
      database.prepare(`
        SELECT id, category, title, owner_name, owner_email, severity, status, next_action, due_at, created_at
        FROM product_launch_risks WHERE implementation_id = $1
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          created_at DESC, id DESC
      `).all(implementationId),
      database.prepare(`
        SELECT id, title, approval_type, approver_name, approver_email, stage_gate, status, due_at, created_at
        FROM product_approval_requests WHERE implementation_id = $1
        ORDER BY created_at DESC, id DESC
      `).all(implementationId),
      hasTimeTracking ? database.prepare(`
        SELECT t.id, t.user_id, u.email AS user_email, t.task_id, s.title AS task_title,
          t.work_date, t.minutes, t.billable, t.note,
          ${canViewRates ? "t.hourly_rate, t.internal_cost_rate_snapshot, t.client_bill_rate_snapshot," : ""}
          ${hasFinancialProtection ? "t.rate_snapshot_present," : ""}
          t.logged_at, t.created_at
          ${hasFinancialProtection ? `,
            CASE WHEN t.rate_snapshot_present
              THEN ROUND(t.minutes / 60.0 * t.internal_cost_rate_snapshot, 2)
              ELSE NULL END AS labor_cost
            ${canViewRates ? ", ROUND(t.minutes / 60.0 * t.client_bill_rate_snapshot, 2) AS billable_amount" : ""}` : ""}
        FROM product_time_entries t
        LEFT JOIN product_users u ON u.id = t.user_id
        LEFT JOIN product_implementation_steps s ON s.id = t.task_id
        WHERE t.implementation_id = $1 ORDER BY t.work_date DESC, t.id DESC
      `).all(implementationId) : Promise.resolve([]),
      hasFinancialProtection ? database.prepare(`
        SELECT budget_amount, forecast_amount, actual_cost, invoice_status, invoice_reference, margin_note, updated_at
        FROM product_financial_plans WHERE implementation_id = $1
      `).get(implementationId) : Promise.resolve(null),
      hasFinancialProtection ? database.prepare(`
        SELECT COALESCE(SUM(minutes), 0) AS logged_minutes,
          COALESCE(SUM(minutes * internal_cost_rate_snapshot / 60.0)
            FILTER (WHERE rate_snapshot_present), 0) AS delivery_cost
        FROM product_time_entries WHERE implementation_id = $1
      `).get(implementationId) : Promise.resolve({ logged_minutes: 0, delivery_cost: 0 }),
      database.prepare(`
        SELECT id, title, start_at, end_at, event_type, external_url, created_at
        FROM product_calendar_events WHERE implementation_id = $1
        ORDER BY start_at, id
      `).all(implementationId)
    ]);
    if (!req.product.planDetails.features.blockers) {
      for (const step of steps) {
        step.is_blocked = false;
        step.blocker_reason = "";
        step.blocker_next_action = "";
      }
    }
    Object.assign(implementation, {
      steps,
      requirements,
      customerContacts,
      customerMessages,
      customerFiles,
      changeOrders,
      launchStakeholders,
      launchRisks,
      approvals,
      ...(hasTimeTracking ? { timeEntries } : {}),
      ...(hasFinancialProtection ? {
        budgetBurn: {
        burn_pct: calculateBurn({
          budgetType: implementation.budget_type,
          budgetLimit: implementation.budget_limit,
          loggedMinutes: timeTotals.logged_minutes,
          deliveryCost: timeTotals.delivery_cost
        }),
        logged_minutes: Number(timeTotals.logged_minutes) || 0,
        delivery_cost: Number(timeTotals.delivery_cost) || 0,
        hard_lock_on_exceed: implementation.hard_lock_on_exceed
        },
        financialPlan: financialPlan || {
        budget_amount: 0, forecast_amount: 0, actual_cost: 0, invoice_status: "not_started",
        invoice_reference: "", margin_note: ""
        }
      } : {}),
      calendarEvents
    });
    return res.json({ implementation });
  });

  app.get("/api/product/analytics/portfolio-margins", requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Time tracking, budget caps, and margin reporting", "custom")) return;
    const projects = await database.prepare(`
      SELECT id, customer_name, base_onboarding_fee, budget_type, budget_limit,
        hard_lock_on_exceed
      FROM product_implementations
      WHERE workspace_id = $1 AND archived_at IS NULL
      ORDER BY lower(customer_name), id
    `).all(req.product.workspaceId);
    const implementationIds = projects.map((project) => project.id);
    if (!implementationIds.length) {
      return res.json({
        summary: summarizePortfolio([]),
        projects: [],
        alerts: []
      });
    }
    const [entries, approvedChangeOrders, alerts] = await Promise.all([
      database.prepare(`
        SELECT t.id, t.implementation_id, t.minutes,
          t.internal_cost_rate_snapshot, t.client_bill_rate_snapshot, t.rate_snapshot_present,
          t.logged_at,
          EXISTS (
            SELECT 1 FROM product_change_order_steps linked
            JOIN product_change_orders co ON co.id = linked.change_order_id
            WHERE linked.step_id = t.task_id AND co.status = 'approved'
          ) AS change_order_approved
        FROM product_time_entries t
        WHERE t.implementation_id = ANY($1::integer[])
      `).all(implementationIds),
      database.prepare(`
        SELECT implementation_id, COALESCE(SUM(additional_fee), 0) AS approved_total
        FROM product_change_orders
        WHERE implementation_id = ANY($1::integer[]) AND status = 'approved'
        GROUP BY implementation_id
      `).all(implementationIds),
      database.prepare(`
        SELECT id, implementation_id, payload, created_at, status
        FROM product_workspace_events
        WHERE workspace_id = $1 AND event_type = 'budget.burn_alert'
        ORDER BY created_at DESC, id DESC
        LIMIT 25
      `).all(req.product.workspaceId)
    ]);
    const entriesByProject = new Map();
    for (const entry of entries) {
      const scopedEntries = entriesByProject.get(entry.implementation_id) || [];
      scopedEntries.push(entry);
      entriesByProject.set(entry.implementation_id, scopedEntries);
    }
    const changeOrderTotals = new Map(approvedChangeOrders.map((row) => [
      row.implementation_id, Number(row.approved_total) || 0
    ]));
    const rows = projects.map((project) => ({
      id: project.id,
      customer_name: project.customer_name,
      budget_type: project.budget_type,
      budget_limit: Number(project.budget_limit) || 0,
      hard_lock_on_exceed: project.hard_lock_on_exceed,
      ...calculateProjectFinancials(
        project,
        entriesByProject.get(project.id) || [],
        changeOrderTotals.get(project.id) || 0
      )
    }));
    return res.json({
      summary: summarizePortfolio(rows),
      projects: rows,
      alerts
    });
  });

  app.post("/api/product/implementations/:implementationId/change-orders", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "changeOrders", "Change-order approvals")) return;
    if (!req.product.capabilities.manageImplementations) return sendError(res, 403, "Only an implementation manager or workspace admin can draft change orders.");
    const implementationId = validId(req.params.implementationId);
    const title = requiredText(req.body.title, 160);
    const scopeDescription = requiredText(req.body.scopeDescription, 4000);
    const feeValue = req.body.additionalFee;
    const additionalFee = typeof feeValue === "number" || (typeof feeValue === "string" && feeValue.trim())
      ? Number(feeValue) : null;
    const timelineExtensionDays = req.body.timelineExtensionDays;
    const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds.map(validId) : [];
    if (!implementationId || !title || !scopeDescription
      || additionalFee === null || !Number.isFinite(additionalFee) || additionalFee < 0
      || additionalFee > 9999999999.99 || Math.round(additionalFee * 100) !== additionalFee * 100
      || !Number.isInteger(timelineExtensionDays) || timelineExtensionDays < 0 || timelineExtensionDays > 3650
      || taskIds.length > 100 || taskIds.some((id) => !id) || new Set(taskIds).size !== taskIds.length) {
      return sendError(res, 400, "Enter a title, scope, valid fee, timeline extension, and unique task selections.");
    }
    const implementation = await database.prepare(`
      SELECT id FROM product_implementations
      WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
    `).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const changeOrder = await database.transaction(async () => {
      if (taskIds.length) {
        const tasks = await database.prepare(`
          SELECT id FROM product_implementation_steps
          WHERE implementation_id = $1 AND id = ANY($2::integer[]) FOR UPDATE
        `).all(implementationId, taskIds);
        if (tasks.length !== taskIds.length) return null;
      }
      const created = await database.prepare(`
        INSERT INTO product_change_orders
          (implementation_id, title, scope_description, additional_fee,
            timeline_extension_days, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, title, scope_description, additional_fee, timeline_extension_days, status, created_at
      `).get(implementationId, title, scopeDescription, additionalFee, timelineExtensionDays, req.product.userId);
      const insertLink = database.prepare(`
        INSERT INTO product_change_order_steps (change_order_id, implementation_id, step_id)
        VALUES ($1, $2, $3)
      `);
      for (const stepId of taskIds) await insertLink.run(created.id, implementationId, stepId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "change_order.drafted",
        diff: {
          changeOrderId: created.id,
          title,
          additionalFee,
          timelineExtensionDays,
          taskIds
        }
      });
      return { ...created, task_ids: taskIds };
    });
    if (!changeOrder) return sendError(res, 400, "Select tasks from this implementation only.");
    return res.status(201).json({ changeOrder });
  });

  app.post("/api/product/implementations/:implementationId/change-orders/:changeOrderId/send", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "changeOrders", "Change-order approvals")) return;
    if (!req.product.capabilities.manageImplementations) return sendError(res, 403, "Only an implementation manager or workspace admin can send change orders.");
    const implementationId = validId(req.params.implementationId);
    const changeOrderId = validId(req.params.changeOrderId);
    if (!implementationId || !changeOrderId) return sendError(res, 400, "Invalid change order.");
    const sent = await database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT id, customer_owner_email FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!implementation) return { error: "Implementation not found.", status: 404 };
      const contact = await database.prepare(`
        SELECT id, email, display_name FROM product_customer_contacts
        WHERE implementation_id = $1 AND lower(email) = lower($2)
          AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        LIMIT 1
      `).get(implementationId, implementation.customer_owner_email);
      if (!contact) {
        return {
          error: "Set the customer owner email and invite that primary contact before sending a change order.",
          status: 409
        };
      }
      const changeOrder = await database.prepare(`
        SELECT id, title, status FROM product_change_orders
        WHERE id = $1 AND implementation_id = $2 FOR UPDATE
      `).get(changeOrderId, implementationId);
      if (!changeOrder) return { error: "Change order not found.", status: 404 };
      if (changeOrder.status !== "draft") {
        return { error: "Only a draft change order can be sent.", status: 409 };
      }
      await database.prepare(`
        SELECT s.id
        FROM product_change_order_steps linked
        JOIN product_implementation_steps s ON s.id = linked.step_id
          AND s.implementation_id = linked.implementation_id
        WHERE linked.change_order_id = $1 FOR UPDATE OF s
      `).all(changeOrderId);
      await database.prepare(`
        UPDATE product_change_orders SET status = 'pending_client', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `).run(changeOrderId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "change_order.sent",
        diff: { changeOrderId, from: "draft", to: "pending_client" }
      });
      await enqueueWorkspaceEvent(req.product.workspaceId, implementationId, "change_order.pending", {
        recipientEmail: contact.email,
        recipientName: contact.display_name,
        title: changeOrder.title
      });
      return { success: true };
    });
    if (sent.error) return sendError(res, sent.status, sent.error);
    return res.json(sent);
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
    const saved = await database.transaction(async () => {
      const previous = await database.prepare(`
        SELECT customer_owner_name, customer_owner_email, target_launch_date
        FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!previous) return false;
      await database.prepare(`
        UPDATE product_implementations
        SET customer_owner_name = $1, customer_owner_email = $2, target_launch_date = $3
        WHERE id = $4 AND workspace_id = $5
      `).run(customerOwnerName, customerOwnerEmail, targetLaunchDate, implementationId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "implementation.launch_plan_updated",
        diff: {
          before: previous,
          after: {
            customer_owner_name: customerOwnerName,
            customer_owner_email: customerOwnerEmail,
            target_launch_date: targetLaunchDate
          }
        }
      });
      return true;
    });
    if (!saved) return sendError(res, 404, "Implementation not found.");
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
    const updated = await database.transaction(async () => {
      const previous = await database.prepare(`
        SELECT success_criteria, acceptance_status, test_plan, training_status,
          support_owner_name, support_owner_email, rollback_plan, go_live_status
        FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!previous) return false;
      await database.prepare(`
        UPDATE product_implementations
        SET success_criteria = $1, acceptance_status = $2, test_plan = $3, training_status = $4,
          support_owner_name = $5, support_owner_email = $6, rollback_plan = $7, go_live_status = $8
        WHERE id = $9 AND workspace_id = $10
      `).run(successCriteria, acceptanceStatus, testPlan, trainingStatus, supportOwnerName,
        supportOwnerEmail, rollbackPlan, goLiveStatus, implementationId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "implementation.launch_readiness_updated",
        diff: {
          before: previous,
          after: {
            success_criteria: successCriteria,
            acceptance_status: acceptanceStatus,
            test_plan: testPlan,
            training_status: trainingStatus,
            support_owner_name: supportOwnerName,
            support_owner_email: supportOwnerEmail,
            rollback_plan: rollbackPlan,
            go_live_status: goLiveStatus
          }
        }
      });
      return true;
    });
    if (!updated) return sendError(res, 404, "Implementation not found.");
    return res.json({
      successCriteria, acceptanceStatus, testPlan, trainingStatus,
      supportOwnerName, supportOwnerEmail, rollbackPlan, goLiveStatus
    });
  });

  app.patch("/api/product/implementations/:implementationId/sow", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!req.product.capabilities.manageImplementations) return sendError(res, 403, "Only an implementation manager or workspace admin can update SOW and stage-gate details.");
    const sowScope = typeof req.body.sowScope === "string" ? req.body.sowScope.trim().slice(0, 4000) : "";
    const sowMilestones = typeof req.body.sowMilestones === "string" ? req.body.sowMilestones.trim().slice(0, 4000) : "";
    const sowExclusions = typeof req.body.sowExclusions === "string" ? req.body.sowExclusions.trim().slice(0, 4000) : "";
    const stageGateStatus = ["kickoff", "configuration", "testing", "launch", "hypercare", "complete"].includes(req.body.stageGateStatus)
      ? req.body.stageGateStatus : "kickoff";
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const updated = await database.transaction(async () => {
      const previous = await database.prepare(`
        SELECT sow_scope, sow_milestones, sow_exclusions, stage_gate_status
        FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!previous) return { error: "Implementation not found.", status: 404 };
      const gatesToPass = stagesRequiringApprovalBeforeMove(previous.stage_gate_status, stageGateStatus);
      if (!gatesToPass) return { error: "The saved stage-gate status is invalid.", status: 409 };
      if (gatesToPass.length) {
        const blockingApproval = await database.prepare(`
          SELECT stage_gate FROM product_approval_requests
          WHERE implementation_id = $1 AND stage_gate = ANY($2::text[])
            AND status != 'approved'
          ORDER BY array_position($2::text[], stage_gate), created_at, id
          LIMIT 1
        `).get(implementationId, gatesToPass);
        if (blockingApproval) {
          return {
            error: `Approve all required ${blockingApproval.stage_gate} approvals before moving to ${stageGateStatus}.`,
            status: 409
          };
        }
      }
      await database.prepare(`
        UPDATE product_implementations
        SET sow_scope = $1, sow_milestones = $2, sow_exclusions = $3, stage_gate_status = $4
        WHERE id = $5 AND workspace_id = $6
      `).run(sowScope, sowMilestones, sowExclusions, stageGateStatus, implementationId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "implementation.scope_stage_gate_updated",
        diff: {
          before: previous,
          after: {
            sow_scope: sowScope,
            sow_milestones: sowMilestones,
            sow_exclusions: sowExclusions,
            stage_gate_status: stageGateStatus
          }
        }
      });
      return { success: true };
    });
    if (updated.error) return sendError(res, updated.status, updated.error);
    return res.json({ sowScope, sowMilestones, sowExclusions, stageGateStatus });
  });

  app.patch("/api/product/implementations/:implementationId/financial-plan", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Financial planning", "custom")) return;
    const implementationId = validId(req.params.implementationId);
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can update financial plans.");
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
    const saved = await database.transaction(async () => {
      const implementation = await database.prepare(
        "SELECT id FROM product_implementations WHERE id = $1 AND workspace_id = $2 FOR UPDATE"
      ).get(implementationId, req.product.workspaceId);
      if (!implementation) return false;
      const previous = await database.prepare(`
        SELECT budget_amount, forecast_amount, actual_cost, invoice_status,
          invoice_reference, margin_note
        FROM product_financial_plans WHERE implementation_id = $1 FOR UPDATE
      `).get(implementationId);
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
      const financialFields = (plan) => plan ? {
        budget_amount: plan.budget_amount,
        forecast_amount: plan.forecast_amount,
        actual_cost: plan.actual_cost,
        invoice_status: plan.invoice_status,
        invoice_reference: plan.invoice_reference,
        has_margin_note: Boolean(plan.margin_note)
      } : null;
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "financial_plan.updated",
        diff: {
          before: financialFields(previous),
          after: financialFields({
            budget_amount: budgetAmount,
            forecast_amount: forecastAmount,
            actual_cost: actualCost,
            invoice_status: invoiceStatus,
            invoice_reference: invoiceReference,
            margin_note: marginNote
          })
        }
      });
      return true;
    });
    if (!saved) return sendError(res, 404, "Implementation not found.");
    return res.json({ budgetAmount, forecastAmount, actualCost, invoiceStatus, invoiceReference, marginNote });
  });

  app.patch("/api/product/implementations/:implementationId/budget", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Project budget caps", "custom")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can update project budgets.");
    const implementationId = validId(req.params.implementationId);
    const amount = (value) => {
      if (typeof value !== "number" && typeof value !== "string") return null;
      if (typeof value === "string" && value.trim() === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000000000 ? parsed : null;
    };
    const baseOnboardingFee = amount(req.body.baseOnboardingFee);
    const budgetLimit = amount(req.body.budgetLimit);
    const budgetType = req.body.budgetType;
    const hardLockOnExceed = req.body.hardLockOnExceed;
    if (!implementationId || baseOnboardingFee === null || budgetLimit === null
      || !["fixed_hours", "fixed_fee", "time_and_materials"].includes(budgetType)
      || typeof hardLockOnExceed !== "boolean") {
      return sendError(res, 400, "Enter a valid budget type, limit, base fee, and hard-lock setting.");
    }
    const result = await database.transaction(async () => {
      const previous = await database.prepare(`
        SELECT base_onboarding_fee, budget_type, budget_limit, hard_lock_on_exceed,
          last_alert_threshold_sent
        FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!previous) return null;
      const resetAlertThreshold = previous.budget_type !== budgetType
        || Number(previous.budget_limit) !== budgetLimit;
      await database.prepare(`
        UPDATE product_implementations SET base_onboarding_fee = $1, budget_type = $2,
          budget_limit = $3, hard_lock_on_exceed = $4,
          last_alert_threshold_sent = CASE WHEN $5 THEN 0 ELSE last_alert_threshold_sent END
        WHERE id = $6 AND workspace_id = $7
      `).run(baseOnboardingFee, budgetType, budgetLimit, hardLockOnExceed, resetAlertThreshold,
        implementationId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: String(req.product.userId),
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "budget.configuration_updated",
        diff: {
          before: previous,
          after: { base_onboarding_fee: baseOnboardingFee, budget_type: budgetType,
            budget_limit: budgetLimit, hard_lock_on_exceed: hardLockOnExceed }
        }
      });
      const burn = await recalculateBudgetBurn(implementationId, req.product.workspaceId);
      return { baseOnboardingFee, budgetType, budgetLimit, hardLockOnExceed, burn };
    });
    if (!result) return sendError(res, 404, "Implementation not found.");
    return res.json(result);
  });

  app.post("/api/product/implementations/:implementationId/budget-overrides", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Budget overrides", "custom")) return;
    if (!req.product.capabilities.manageImplementations) {
      return sendError(res, 403, "Only an implementation manager or workspace admin can grant budget overrides.");
    }
    const implementationId = validId(req.params.implementationId);
    const reason = requiredText(req.body.reason, 1000);
    const durationHours = Number(req.body.durationHours);
    if (!implementationId || !reason || !Number.isInteger(durationHours)
      || durationHours < 1 || durationHours > 24) {
      return sendError(res, 400, "Enter an override reason and a duration between 1 and 24 hours.");
    }
    const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
    const override = await database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT id FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!implementation) return null;
      await database.prepare(`
        UPDATE product_budget_overrides SET revoked_at = CURRENT_TIMESTAMP
        WHERE implementation_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      `).run(implementationId);
      const created = await database.prepare(`
        INSERT INTO product_budget_overrides (implementation_id, granted_by, reason, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id, reason, expires_at, created_at
      `).get(implementationId, req.product.userId, reason, expiresAt);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: String(req.product.userId),
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "budget.override_granted",
        diff: created
      });
      return created;
    });
    if (!override) return sendError(res, 404, "Implementation not found.");
    return res.status(201).json({ override });
  });

  app.post("/api/product/team-members/:userId/rates", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Team time and effort rates", "custom")) return;
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can update team rates.");
    const userId = validId(req.params.userId);
    const rate = (value) => {
      if (typeof value !== "number" && typeof value !== "string") return null;
      if (typeof value === "string" && value.trim() === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000000 ? parsed : null;
    };
    const costRate = rate(req.body.defaultInternalCostRate);
    const billRate = rate(req.body.defaultBillableRate);
    if (!userId || costRate === null || billRate === null) {
      return sendError(res, 400, "Enter valid non-negative hourly rates.");
    }
    const updated = await database.transaction(async () => {
      const member = await database.prepare(`
        SELECT m.default_internal_cost_rate, m.default_billable_rate
        FROM product_users u JOIN product_memberships m ON m.user_id = u.id
        WHERE u.id = $1 AND m.workspace_id = $2
        FOR UPDATE OF m
      `).get(userId, req.product.workspaceId);
      if (!member) return null;
      await database.prepare(`
        UPDATE product_memberships SET default_internal_cost_rate = $1, default_billable_rate = $2
        WHERE user_id = $3 AND workspace_id = $4
      `).run(costRate, billRate, userId, req.product.workspaceId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        actorId: String(req.product.userId),
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "team_member.rates_updated",
        diff: {
          userId,
          before: { internalCostRate: member.default_internal_cost_rate, billableRate: member.default_billable_rate },
          after: { internalCostRate: costRate, billableRate: billRate }
        }
      });
      return { userId, default_internal_cost_rate: costRate, default_billable_rate: billRate };
    });
    if (!updated) return sendError(res, 404, "Team member not found.");
    return res.json({ member: updated });
  });

  async function createTimeEntry(req, implementationId, taskId, minutes, workDate, note, legacy) {
    const billableInput = typeof req.body.isBillable === "boolean" ? req.body.isBillable : req.body.billable;
    const hasBillableInput = typeof billableInput === "boolean";
    return database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT id, customer_name, budget_type, budget_limit, hard_lock_on_exceed
        FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!implementation) return { error: "Implementation not found.", status: 404 };
      let approvedChangeOrder = false;
      if (taskId !== null) {
        const task = await database.prepare(`
          SELECT s.id FROM product_implementation_steps s
          WHERE s.id = $1 AND s.implementation_id = $2
        `).get(taskId, implementationId);
        if (!task) return { error: "Task not found in this implementation.", status: 404 };
        const approved = await database.prepare(`
          SELECT 1 FROM product_change_order_steps linked
          JOIN product_change_orders co ON co.id = linked.change_order_id
          WHERE linked.step_id = $1 AND linked.implementation_id = $2 AND co.status = 'approved'
          LIMIT 1
        `).get(taskId, implementationId);
        approvedChangeOrder = Boolean(approved);
      }
      const user = await database.prepare(`
        SELECT default_internal_cost_rate, default_billable_rate
        FROM product_memberships WHERE user_id = $1 AND workspace_id = $2
      `).get(req.product.userId, req.product.workspaceId);
      const internalRate = Number(user?.default_internal_cost_rate) || 0;
      const explicitLegacyRate = legacy && req.body.hourlyRate !== undefined && req.body.hourlyRate !== ""
        ? Number(req.body.hourlyRate) : null;
      const billRate = explicitLegacyRate !== null && Number.isFinite(explicitLegacyRate)
        ? Math.min(1000000, Math.max(0, explicitLegacyRate))
        : Number(user?.default_billable_rate) || 0;
      const isBillable = hasBillableInput ? billableInput : legacy ? true : approvedChangeOrder;
      const totals = await database.prepare(`
        SELECT COALESCE(SUM(minutes), 0) AS logged_minutes,
          COALESCE(SUM(minutes * internal_cost_rate_snapshot / 60.0)
            FILTER (WHERE rate_snapshot_present), 0) AS delivery_cost
        FROM product_time_entries WHERE implementation_id = $1
      `).get(implementationId);
      const currentBurn = calculateBurn({
        budgetType: implementation.budget_type,
        budgetLimit: implementation.budget_limit,
        loggedMinutes: totals.logged_minutes,
        deliveryCost: totals.delivery_cost
      });
      const projectedMinutes = Number(totals.logged_minutes) + minutes;
      const projectedCost = (Number(totals.delivery_cost) || 0) + minutes / 60 * internalRate;
      const projectedBurn = calculateBurn({
        budgetType: implementation.budget_type,
        budgetLimit: implementation.budget_limit,
        loggedMinutes: projectedMinutes,
        deliveryCost: projectedCost
      });
      const override = await database.prepare(`
        SELECT id FROM product_budget_overrides
        WHERE implementation_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        LIMIT 1
      `).get(implementationId);
      if (implementation.hard_lock_on_exceed && !isWorkspaceAdmin(req.product.role)
        && !approvedChangeOrder && !override
        && ((currentBurn !== null && currentBurn >= 100) || (projectedBurn !== null && projectedBurn > 100))) {
        return {
          error: "This project has reached its budget cap. Ask a workspace admin to grant a time-entry override or link the task to an approved change order.",
          status: 409
        };
      }
      const entry = await database.prepare(`
        INSERT INTO product_time_entries
          (implementation_id, task_id, user_id, work_date, minutes, billable, note, hourly_rate,
            internal_cost_rate_snapshot, client_bill_rate_snapshot, rate_snapshot_present, logged_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, CURRENT_TIMESTAMP)
        RETURNING id, implementation_id, task_id, user_id, work_date, minutes, billable, note,
          hourly_rate, internal_cost_rate_snapshot, client_bill_rate_snapshot, rate_snapshot_present,
          logged_at, created_at
      `).get(implementationId, taskId, req.product.userId, workDate, minutes, isBillable, note,
        billRate, internalRate, billRate);
      const burn = await recalculateBudgetBurn(implementationId, req.product.workspaceId);
      if (!req.product.capabilities.viewRates) {
        delete entry.hourly_rate;
        delete entry.internal_cost_rate_snapshot;
        delete entry.client_bill_rate_snapshot;
      }
      return {
        entry,
        ...(req.product.capabilities.viewFinancials ? { burn } : {})
      };
    });
  }

  app.post("/api/product/implementations/:implementationId/time-entries", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Task time tracking", "custom")) return;
    const implementationId = validId(req.params.implementationId);
    const minutes = Number(req.body.minutes);
    const workDate = req.body.workDate ?? "";
    const note = typeof req.body.note === "string" ? req.body.note.trim().slice(0, 500) : "";
    if (!implementationId || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440
      || !validDate(workDate)) return sendError(res, 400, "Enter a valid work date and time entry.");
    const taskId = req.body.taskId === undefined || req.body.taskId === null || req.body.taskId === ""
      ? null : validId(req.body.taskId);
    if (req.body.taskId !== undefined && req.body.taskId !== null && req.body.taskId !== "" && !taskId) {
      return sendError(res, 400, "Invalid task.");
    }
    const result = await createTimeEntry(req, implementationId, taskId, minutes, workDate, note, true);
    if (result.error) return sendError(res, result.status, result.error);
    return res.status(201).json(result);
  });

  app.post("/api/product/implementations/:implementationId/steps/:stepId/time-entries", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Task time tracking", "custom")) return;
    const implementationId = validId(req.params.implementationId);
    const taskId = validId(req.params.stepId);
    const minutes = Number(req.body.minutes);
    const workDate = req.body.workDate ?? new Date().toISOString().slice(0, 10);
    const note = typeof req.body.note === "string" ? req.body.note.trim().slice(0, 500) : "";
    if (!implementationId || !taskId || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440
      || !validDate(workDate)) return sendError(res, 400, "Enter a valid work date and time entry.");
    const result = await createTimeEntry(req, implementationId, taskId, minutes, workDate, note, false);
    if (result.error) return sendError(res, result.status, result.error);
    return res.status(201).json(result);
  });

  app.get("/api/product/implementations/:implementationId/time-entries", requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Task time tracking", "custom")) return;
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const implementation = await database.prepare(`
      SELECT id FROM product_implementations
      WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
    `).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const canViewFinancials = req.product.capabilities.viewFinancials;
    const canViewRates = req.product.capabilities.viewRates;
    const entries = await database.prepare(`
      SELECT t.id, t.implementation_id, t.task_id, s.title AS task_title, t.user_id,
        u.email AS user_email, t.work_date, t.minutes, t.billable, t.note,
        ${canViewRates ? "t.internal_cost_rate_snapshot, t.client_bill_rate_snapshot," : ""}
        ${canViewFinancials ? `t.rate_snapshot_present,
          CASE WHEN t.rate_snapshot_present
            THEN ROUND(t.minutes / 60.0 * t.internal_cost_rate_snapshot, 2)
            ELSE NULL END AS labor_cost${canViewRates
            ? ", ROUND(t.minutes / 60.0 * t.client_bill_rate_snapshot, 2) AS billable_amount" : ""},` : ""}
        t.logged_at
      FROM product_time_entries t
      LEFT JOIN product_implementation_steps s ON s.id = t.task_id
      LEFT JOIN product_users u ON u.id = t.user_id
      WHERE t.implementation_id = $1
      ORDER BY t.logged_at DESC, t.id DESC
    `).all(implementationId);
    return res.json({ entries });
  });

  app.delete("/api/product/time-entries/:entryId", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Task time tracking", "custom")) return;
    const entryId = validId(req.params.entryId);
    if (!entryId) return sendError(res, 400, "Invalid time entry.");
    const result = await database.transaction(async () => {
      const entry = await database.prepare(`
        SELECT t.id, t.implementation_id, t.user_id FROM product_time_entries t
        JOIN product_implementations i ON i.id = t.implementation_id
        WHERE t.id = $1 AND i.workspace_id = $2 AND i.archived_at IS NULL
        FOR UPDATE OF i
      `).get(entryId, req.product.workspaceId);
      if (!entry) return null;
      if (!req.product.capabilities.manageImplementations
        && entry.user_id !== req.product.userId) {
        return { error: "You can only delete your own time entries.", status: 403 };
      }
      await database.prepare("DELETE FROM product_time_entries WHERE id = $1").run(entryId);
      const burn = await recalculateBudgetBurn(entry.implementation_id, req.product.workspaceId);
      return { burn };
    });
    if (!result) return sendError(res, 404, "Time entry not found.");
    if (result.error) return sendError(res, result.status, result.error);
    return res.json({
      success: true,
      ...(req.product.capabilities.viewFinancials ? { burn: result.burn } : {})
    });
  });

  app.delete("/api/product/implementations/:implementationId/time-entries/:entryId", sameOrigin, requireSession, async (req, res) => {
    if (!requirePlanFeature(req, res, "financialProtection", "Task time tracking", "custom")) return;
    const implementationId = validId(req.params.implementationId);
    const entryId = validId(req.params.entryId);
    if (!implementationId || !entryId) return sendError(res, 400, "Invalid time entry.");
    const entry = await database.prepare(`
      SELECT implementation_id, user_id FROM product_time_entries
      WHERE id = $1 AND implementation_id = $2
    `).get(entryId, implementationId);
    if (!entry) return sendError(res, 404, "Time entry not found.");
    if (!req.product.capabilities.manageImplementations && entry.user_id !== req.product.userId) {
      return sendError(res, 403, "You can only delete your own time entries.");
    }
    const result = await database.transaction(async () => {
      const lockedImplementation = await database.prepare(`
        SELECT id FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!lockedImplementation) return false;
      const deleted = await database.prepare("DELETE FROM product_time_entries WHERE id = $1").run(entryId);
      if (!deleted.changes) return false;
      await recalculateBudgetBurn(implementationId, req.product.workspaceId);
      return true;
    });
    if (!result) return sendError(res, 404, "Time entry not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/implementations/:implementationId/approvals", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const title = requiredText(req.body.title, 240);
    const approvalType = typeof req.body.approvalType === "string" ? req.body.approvalType.trim().slice(0, 80) : "other";
    const stageGate = typeof req.body.stageGate === "string" ? req.body.stageGate : "";
    const approverName = typeof req.body.approverName === "string" ? req.body.approverName.trim().slice(0, 120) : "";
    const approverEmail = typeof req.body.approverEmail === "string" ? req.body.approverEmail.trim().toLowerCase().slice(0, 254) : "";
    const dueAt = req.body.dueAt ?? "";
    if (!implementationId || !title || (approverEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(approverEmail))
      || (dueAt !== "" && !validDate(dueAt)) || !APPROVAL_STAGE_GATES.includes(stageGate)) {
      return sendError(res, 400, "Enter a valid approval, approver, and required stage gate.");
    }
    const result = await database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT id, stage_gate_status FROM product_implementations
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        FOR UPDATE
      `).get(implementationId, req.product.workspaceId);
      if (!implementation) return { error: "Implementation not found.", status: 404 };
      if (STAGE_GATE_ORDER.indexOf(stageGate)
        < STAGE_GATE_ORDER.indexOf(implementation.stage_gate_status)) {
        return { error: "Choose the current stage or a later stage for this approval.", status: 409 };
      }
      const created = await database.prepare(`
        INSERT INTO product_approval_requests
          (implementation_id, title, approval_type, approver_name, approver_email, stage_gate, status, due_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
        RETURNING id, title, approval_type, approver_name, approver_email, stage_gate, status, due_at, created_at
      `).get(implementationId, title, approvalType, approverName, approverEmail, stageGate, dueAt);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "stage_gate.approval_created",
        diff: { approvalId: created.id, title, approvalType, approverEmail, stageGate, status: "pending" }
      });
      return { approval: created };
    });
    if (result.error) return sendError(res, result.status, result.error);
    return res.status(201).json({ approval: result.approval });
  });

  app.patch("/api/product/implementations/:implementationId/approvals/:approvalId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const approvalId = validId(req.params.approvalId);
    const status = ["pending", "approved", "rejected"].includes(req.body.status) ? req.body.status : "";
    if (!implementationId || !approvalId || !status) return sendError(res, 400, "Choose a valid approval status.");
    const updated = await database.transaction(async () => {
      const approval = await database.prepare(`
        SELECT a.title, a.status FROM product_approval_requests a
        JOIN product_implementations i ON i.id = a.implementation_id
        WHERE a.id = $1 AND a.implementation_id = $2 AND i.workspace_id = $3
        FOR UPDATE OF a
      `).get(approvalId, implementationId, req.product.workspaceId);
      if (!approval) return false;
      await database.prepare(`
        UPDATE product_approval_requests SET status = $1
        WHERE id = $2 AND implementation_id = $3
      `).run(status, approvalId, implementationId);
      if (approval.status !== status) {
        await writeAuditLog({
          workspaceId: req.product.workspaceId,
          implementationId,
          actorId: `user:${req.product.userId}`,
          actorEmail: req.product.email,
          ipAddress: req.ip,
          action: "stage_gate.approval_status_changed",
          diff: { approvalId, title: approval.title, before: approval.status, after: status }
        });
      }
      return true;
    });
    if (!updated) return sendError(res, 404, "Approval not found.");
    return res.json({ success: true, status });
  });

  app.delete("/api/product/implementations/:implementationId/approvals/:approvalId", sameOrigin, requireSession, async (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const approvalId = validId(req.params.approvalId);
    if (!implementationId || !approvalId) return sendError(res, 400, "Invalid approval.");
    const deleted = await database.transaction(async () => {
      const approval = await database.prepare(`
        SELECT a.title FROM product_approval_requests a
        JOIN product_implementations i ON i.id = a.implementation_id
        WHERE a.id = $1 AND a.implementation_id = $2 AND i.workspace_id = $3
        FOR UPDATE OF a
      `).get(approvalId, implementationId, req.product.workspaceId);
      if (!approval) return false;
      await database.prepare(`
        DELETE FROM product_approval_requests WHERE id = $1 AND implementation_id = $2
      `).run(approvalId, implementationId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "stage_gate.approval_deleted",
        diff: { approvalId, title: approval.title }
      });
      return true;
    });
    if (!deleted) return sendError(res, 404, "Approval not found.");
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
    if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can update capacity plans.");
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

  app.post("/api/product/implementations/:implementationId/delegations", sameOrigin, requireSession, async (req, res) => {
    if (!req.product.capabilities.manageImplementations) return sendError(res, 403, "Only an implementation manager or workspace admin can create task delegations.");
    const implementationId = validId(req.params.implementationId);
    const email = requiredText(req.body.email, 254).toLowerCase();
    const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim().slice(0, 120) : "";
    const stakeholderRole = req.body.stakeholderRole;
    const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds.map(validId) : [];
    if (!implementationId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || !["it", "legal", "finance", "ops", "other"].includes(stakeholderRole)
      || !taskIds.length || taskIds.length > 20 || taskIds.some((id) => !id)
      || new Set(taskIds).size !== taskIds.length) {
      return sendError(res, 400, "Enter a valid delegate email, role, and assigned tasks.");
    }
    const implementation = await database.prepare(`
      SELECT i.id, i.customer_name, i.customer_owner_email
      FROM product_implementations i
      WHERE i.id = $1 AND i.workspace_id = $2 AND i.archived_at IS NULL
    `).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    if (!implementation.customer_owner_email) {
      return sendError(res, 409, "Set a primary customer owner email and invite that contact first.");
    }
    const primaryContact = await database.prepare(`
      SELECT id, email, display_name
      FROM product_customer_contacts
      WHERE implementation_id = $1 AND lower(email) = lower($2)
        AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      LIMIT 1
    `).get(implementationId, implementation.customer_owner_email);
    if (!primaryContact) {
      return sendError(res, 409, "Invite the primary customer owner before creating task delegations.");
    }
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
    const created = await database.transaction(async () => {
      const tasks = await database.prepare(`
        SELECT id FROM product_implementation_steps
        WHERE implementation_id = $1 AND customer_visible = TRUE AND status != 'done'
          AND id = ANY($2::integer[]) FOR UPDATE
      `).all(implementationId, taskIds);
      if (tasks.length !== taskIds.length) return null;
      const delegation = await database.prepare(`
        INSERT INTO product_customer_task_delegations
          (implementation_id, primary_contact_id, email, display_name, stakeholder_role, token_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, email, display_name, stakeholder_role, expires_at
      `).get(implementationId, primaryContact.id, email, displayName, stakeholderRole, hashToken(rawToken), expiresAt);
      const addTask = database.prepare(`
        INSERT INTO product_customer_task_delegation_steps (delegation_id, implementation_id, step_id)
        VALUES ($1, $2, $3)
      `);
      for (const stepId of taskIds) await addTask.run(delegation.id, implementationId, stepId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "customer.tasks_delegated",
        diff: { delegationId: delegation.id, email, stakeholderRole, taskIds }
      });
      return delegation;
    });
    if (!created) return sendError(res, 400, "Choose open customer-visible tasks from this implementation.");
    const delegationPortalUrl = customerPortalUrl(req, rawToken);
    let invitation;
    try {
      invitation = await sendProductEmail({
        to: email,
        subject: `Tasks delegated to you for ${implementation.customer_name}`,
        text: `Hello${displayName ? ` ${displayName}` : ""},\n\n${primaryContact.display_name || "Your project lead"} delegated ${taskIds.length} customer task${taskIds.length === 1 ? "" : "s"} to you as ${stakeholderRole}. Open this private link to review and complete only those assigned tasks:\n\n${delegationPortalUrl}\n\nThis scoped invitation expires in ${CUSTOMER_LINK_DAYS} days.`
      });
    } catch (error) {
      invitation = { sent: false, error: `Invitation email could not be sent: ${error.message}` };
    }
    return res.status(201).json({
      delegation: created,
      invitationSent: invitation.sent,
      ...(invitation.sent ? {} : { message: invitation.error, delegationPortalUrl })
    });
  });

  app.post("/api/product/implementations/:implementationId/delegations/:delegationId/revoke", sameOrigin, requireSession, async (req, res) => {
    if (!req.product.capabilities.manageImplementations) return sendError(res, 403, "Only an implementation manager or workspace admin can revoke task delegations.");
    const implementationId = validId(req.params.implementationId);
    const delegationId = validId(req.params.delegationId);
    if (!implementationId || !delegationId) return sendError(res, 400, "Invalid task delegation.");
    const revoked = await database.prepare(`
      UPDATE product_customer_task_delegations d
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE d.id = $1 AND d.implementation_id = $2
        AND d.implementation_id IN (
          SELECT id FROM product_implementations
          WHERE id = d.implementation_id AND workspace_id = $3
        )
        AND d.revoked_at IS NULL
      RETURNING d.id, d.email, d.stakeholder_role
    `).get(delegationId, implementationId, req.product.workspaceId);
    if (!revoked) return sendError(res, 404, "Active task delegation not found.");
    await writeAuditLog({
      workspaceId: req.product.workspaceId,
      implementationId,
      actorId: `user:${req.product.userId}`,
      actorEmail: req.product.email,
      ipAddress: req.ip,
      action: "customer.delegation_revoked",
      diff: { delegationId, email: revoked.email, stakeholderRole: revoked.stakeholder_role }
    });
    return res.json({ success: true });
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
    const estimatedDurationDays = req.body.estimatedDurationDays === undefined
      ? (step.estimated_duration_days || 1) : req.body.estimatedDurationDays;
    const responsibleParty = req.body.responsibleParty === undefined
      ? (step.responsible_party || (step.customer_visible ? "client" : "relay"))
      : req.body.responsibleParty;
    const csvSchemaRequested = Object.hasOwn(req.body, "csvSchema");
    const credentialVerificationRequested = Object.hasOwn(req.body, "credentialProvider");
    let currentCsvSchema;
    try {
      const storedCsvSchema = Array.isArray(step.csv_schema_json)
        ? step.csv_schema_json : JSON.parse(step.csv_schema_json || "[]");
      currentCsvSchema = Array.isArray(storedCsvSchema) && storedCsvSchema.length === 0
        ? [] : validateCsvSchema(storedCsvSchema);
    } catch {
      currentCsvSchema = null;
    }
    if (!currentCsvSchema) return sendError(res, 500, "This task’s CSV schema is invalid. Ask an administrator to review it.");
    const csvSchema = csvSchemaRequested
      ? Array.isArray(req.body.csvSchema) && req.body.csvSchema.length === 0
        ? [] : validateCsvSchema(req.body.csvSchema)
      : currentCsvSchema;
    const nextCsvSchemaHash = csvSchemaRequested
      ? csvSchema?.length ? csvSchemaHash(csvSchema) : ""
      : step.csv_schema_hash || (currentCsvSchema.length ? csvSchemaHash(currentCsvSchema) : "");
    let currentCredentialProvider = "";
    try {
      const currentCredentialConfig = typeof step.credential_verification_json === "string"
        ? JSON.parse(step.credential_verification_json) : step.credential_verification_json;
      if (currentCredentialConfig?.provider) {
        currentCredentialProvider = validateCredentialProvider(currentCredentialConfig.provider);
        if (!currentCredentialProvider) throw new Error("Unsupported provider.");
      }
    } catch {
      return sendError(res, 500, "This task’s credential verification setting is invalid. Ask an administrator to review it.");
    }
    const credentialProvider = credentialVerificationRequested
      ? req.body.credentialProvider === "" ? "" : validateCredentialProvider(req.body.credentialProvider)
      : currentCredentialProvider;
    if (!["not_started", "in_progress", "done"].includes(status) || owner === null || !assignee.valid
      || (dueAt !== "" && !validDate(dueAt))
      || typeof isBlocked !== "boolean" || blockerReason === null || blockerNextAction === null
      || typeof customerVisible !== "boolean"
      || csvSchema === null
      || (credentialVerificationRequested && credentialProvider === null)
      || !Number.isInteger(estimatedDurationDays) || estimatedDurationDays < 1 || estimatedDurationDays > 3650
      || !["relay", "client"].includes(responsibleParty)
      || (isBlocked && (!blockerReason || !blockerNextAction))
      || (status === "done" && isBlocked && req.product.planDetails.features.blockers)) {
      return sendError(res, 400, "Enter a valid task status, owner, due date, and blocker details.");
    }
    if (csvSchemaRequested) {
      if (!requirePlanFeature(req, res, "csvSchemaValidation", "CSV schema validation")) return;
      if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure CSV validation.");
    }
    if (credentialVerificationRequested) {
      if (!requirePlanFeature(req, res, "credentialVerification", "Credential verification")) return;
      if (!isWorkspaceAdmin(req.product.role)) return sendError(res, 403, "Only a workspace admin can configure credential verification.");
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
    const saved = await database.transaction(async () => {
      await database.prepare(`
        SELECT id FROM product_implementation_steps WHERE id = $1 AND implementation_id = $2 FOR UPDATE
      `).get(stepId, implementationId);
      const activeChangeOrder = await database.prepare(`
        SELECT 1 FROM product_change_order_steps linked
        JOIN product_change_orders co ON co.id = linked.change_order_id
        WHERE linked.step_id = $1 AND co.status = 'pending_client'
        LIMIT 1
      `).get(stepId);
      if (activeChangeOrder && status !== "not_started") return false;
      await database.prepare(`
        UPDATE product_implementation_steps
        SET status = $1, owner = $2, assignee_user_id = $3, due_at = $4, is_blocked = $5, blocker_reason = $6,
          blocker_next_action = $7, customer_visible = $8, estimated_duration_days = $9,
          responsible_party = $10, csv_schema_json = $11::jsonb, csv_schema_hash = $12,
          credential_verified_provider = CASE WHEN credential_verification_json IS DISTINCT FROM $13::jsonb THEN '' ELSE credential_verified_provider END,
          credential_verified_at = CASE WHEN credential_verification_json IS DISTINCT FROM $13::jsonb THEN NULL ELSE credential_verified_at END,
          credential_verification_json = $13::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE id = $14 AND implementation_id = $15
      `).run(status, owner, assignee.id, dueAt, isBlocked, isBlocked ? blockerReason : "",
        isBlocked ? blockerNextAction : "", customerVisible, estimatedDurationDays, responsibleParty,
        JSON.stringify(csvSchema), nextCsvSchemaHash,
        JSON.stringify(credentialProvider ? { provider: credentialProvider } : {}),
        stepId, implementationId);
      await enqueueWorkspaceEvent(req.product.workspaceId, implementationId, "task.updated", {
        taskTitle: step.title,
        status,
        isBlocked
      });
      return true;
    });
    if (!saved) return sendError(res, 409, "This task is locked until its change order is approved.");
    if (csvSchemaRequested) {
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: req.product.userId,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "task.csv_schema_updated",
        diff: { taskId: stepId, before: currentCsvSchema, after: csvSchema }
      });
    }
    if (credentialVerificationRequested) {
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: req.product.userId,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "task.credential_verification_updated",
        diff: {
          taskId: stepId,
          before: currentCredentialProvider,
          after: credentialProvider
        }
      });
    }
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
    const primaryContact = access.kind === "contact"
      && contact.contact_email.toLowerCase() === String(implementation.customer_owner_email || "").toLowerCase();
    const accessRole = access.kind === "delegate" ? "delegate" : primaryContact ? "primary" : "viewer";
    const requirements = access.kind === "delegate" ? [] : await implementationRequirements(
      implementationId, implementation.workspace_id, implementation.template_id
    );
    const tasks = access.kind === "delegate"
      ? await database.prepare(`
        SELECT s.id, s.title, s.description, s.stage, s.csv_schema_json, s.csv_schema_hash,
          s.credential_verification_json, s.credential_verified_provider, s.credential_verified_at,
          EXISTS (
            SELECT 1 FROM product_customer_files f
            WHERE f.task_id = s.id AND s.csv_schema_hash != ''
              AND f.validation_schema_hash = s.csv_schema_hash
          ) AS csv_upload_validated,
          (s.credential_verification_json->>'provider' = s.credential_verified_provider
            AND s.credential_verified_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours') AS credential_verified,
          CASE WHEN EXISTS (
            SELECT 1 FROM product_change_order_steps linked
            JOIN product_change_orders co ON co.id = linked.change_order_id
            WHERE linked.step_id = s.id AND co.status = 'pending_client'
          ) THEN 'locked_pending_co' ELSE s.status END AS status,
          EXISTS (
            SELECT 1 FROM product_change_order_steps linked
            JOIN product_change_orders co ON co.id = linked.change_order_id
            WHERE linked.step_id = s.id AND co.status = 'pending_client'
          ) AS locked_pending_co,
          s.due_at, s.is_blocked, s.blocker_reason, s.blocker_next_action,
          EXISTS (
            SELECT 1 FROM product_implementation_step_dependencies d
            JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
            WHERE d.implementation_step_id = s.id AND parent.status != 'done'
          ) AS waiting
        FROM product_implementation_steps s
        JOIN product_customer_task_delegation_steps assigned
          ON assigned.step_id = s.id AND assigned.delegation_id = $2
        WHERE s.implementation_id = $1 AND s.customer_visible = TRUE
        ORDER BY s.position, s.id
      `).all(implementationId, access.delegation.delegation_id)
      : await database.prepare(`
        SELECT s.id, s.title, s.description, s.stage,
          CASE WHEN EXISTS (
            SELECT 1 FROM product_change_order_steps linked
            JOIN product_change_orders co ON co.id = linked.change_order_id
            WHERE linked.step_id = s.id AND co.status = 'pending_client'
          ) THEN 'locked_pending_co' ELSE s.status END AS status,
          EXISTS (
            SELECT 1 FROM product_change_order_steps linked
            JOIN product_change_orders co ON co.id = linked.change_order_id
            WHERE linked.step_id = s.id AND co.status = 'pending_client'
          ) AS locked_pending_co,
          s.due_at, s.is_blocked, s.blocker_reason, s.blocker_next_action,
          EXISTS (
            SELECT 1 FROM product_implementation_step_dependencies d
            JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
            WHERE d.implementation_step_id = s.id AND parent.status != 'done'
          ) AS waiting
        FROM product_implementation_steps s
        WHERE s.implementation_id = $1 AND s.customer_visible = TRUE
        ORDER BY s.position, s.id
      `).all(implementationId);
    const implementationDate = implementation.projected_go_live_date || implementation.target_launch_date || "";
    const goLiveShifts = await database.prepare(`
      SELECT s.id, s.title, s.due_at, MIN(sh.shift_date)::text AS first_shift_date,
        COUNT(*)::integer AS days_shifted
      FROM product_implementation_go_live_shifts sh
      JOIN product_implementation_steps s ON s.id = sh.step_id
        AND s.implementation_id = sh.implementation_id
      WHERE sh.implementation_id = $1 AND s.status != 'done' AND s.customer_visible = TRUE
        AND ($2::integer IS NULL OR EXISTS (
          SELECT 1 FROM product_customer_task_delegation_steps assigned
          WHERE assigned.delegation_id = $2 AND assigned.step_id = s.id
        ))
      GROUP BY s.id
      ORDER BY MIN(sh.shift_date), s.position, s.id
    `).all(implementationId, access.kind === "delegate" ? access.delegation.delegation_id : null);
    if (access.kind === "delegate") {
      const delegatedTasks = tasks.map((task) => {
        let schema = [];
        try {
          const storedSchema = Array.isArray(task.csv_schema_json)
            ? task.csv_schema_json : JSON.parse(task.csv_schema_json || "[]");
          schema = validateCsvSchema(storedSchema) || [];
        } catch {
          schema = [];
        }
        const {
          csv_schema_json: ignoredSchema,
          csv_schema_hash: ignoredSchemaHash,
          credential_verification_json: credentialConfig,
          credential_verified_provider: ignoredVerifiedProvider,
          credential_verified_at: ignoredVerifiedAt,
          csv_upload_validated: csvUploadValidated,
          credential_verified: credentialVerified,
          ...publicTask
        } = task;
        let credentialProvider = "";
        try {
          const parsedConfig = typeof credentialConfig === "string" ? JSON.parse(credentialConfig) : credentialConfig;
          credentialProvider = validateCredentialProvider(parsedConfig?.provider) || "";
        } catch { credentialProvider = ""; }
        return {
          ...publicTask,
          csvSchema: schema,
          csvUploadValidated: Boolean(csvUploadValidated),
          credentialProvider,
          credentialVerified: Boolean(credentialVerified)
        };
      });
      await database.prepare(`
        UPDATE product_customer_task_delegations SET last_activity_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `).run(access.delegation.delegation_id);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        accessRole,
        customerName: implementation.customer_name,
        delegateName: access.delegation.delegate_name,
        stakeholderRole: access.delegation.stakeholder_role,
        projectedGoLiveDate: implementationDate,
        goLiveShifts,
        requirements: [],
        tasks: delegatedTasks,
        milestones: [...new Set(delegatedTasks.map((task) => task.stage))].map((stage) => {
          const stageTasks = delegatedTasks.filter((task) => task.stage === stage);
          return {
            name: stage,
            total: stageTasks.length,
            completed: stageTasks.filter((task) => task.status === "done").length
          };
        }),
        messages: [],
        files: [],
        changeOrders: [],
        progress: delegatedTasks.length
          ? Math.round((delegatedTasks.filter((task) => task.status === "done").length / delegatedTasks.length) * 100)
          : null
      });
    }
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
      SELECT id, uploaded_by_role, uploaded_by_name, filename, content_type, size_bytes,
        scan_status, created_at
      FROM product_customer_files WHERE implementation_id = $1
      ORDER BY created_at DESC, id DESC
    `).all(implementationId);
    const changeOrders = await database.prepare(`
      SELECT co.id, co.title, co.scope_description, co.additional_fee,
        co.timeline_extension_days, co.status, co.signed_at,
        COALESCE(json_agg(json_build_object('id', s.id, 'title', s.title))
          FILTER (WHERE s.id IS NOT NULL AND s.customer_visible = TRUE), '[]'::json) AS tasks
      FROM product_change_orders co
      LEFT JOIN product_change_order_steps linked ON linked.change_order_id = co.id
      LEFT JOIN product_implementation_steps s ON s.id = linked.step_id
        AND s.implementation_id = linked.implementation_id
      WHERE co.implementation_id = $1 AND co.status != 'draft'
      GROUP BY co.id
      ORDER BY co.created_at DESC, co.id DESC
    `).all(implementationId);
    const delegations = primaryContact ? await database.prepare(`
      SELECT delegation.id, delegation.email, delegation.display_name, delegation.stakeholder_role,
        delegation.expires_at, delegation.revoked_at, delegation.last_activity_at,
        COALESCE(array_agg(step.title) FILTER (WHERE step.id IS NOT NULL), '{}') AS task_titles
      FROM product_customer_task_delegations delegation
      LEFT JOIN product_customer_task_delegation_steps assigned
        ON assigned.delegation_id = delegation.id
      LEFT JOIN product_implementation_steps step ON step.id = assigned.step_id
        AND step.implementation_id = assigned.implementation_id
      WHERE delegation.implementation_id = $1 AND delegation.primary_contact_id = $2
      GROUP BY delegation.id
      ORDER BY delegation.created_at DESC, delegation.id DESC
    `).all(implementationId, contact.contact_id) : [];
    if (contact) {
      await database.prepare(`
        UPDATE product_customer_contacts SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1
      `).run(contact.contact_id);
    }
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      customerName: implementation.customer_name,
      accessRole,
      customerOwnerName: implementation.customer_owner_name,
      customerOwnerEmail: implementation.customer_owner_email,
      targetLaunchDate: implementation.target_launch_date,
      projectedGoLiveDate: implementationDate,
      goLiveShifts,
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
      changeOrders,
      delegations,
      progress: tasks.length
        ? Math.round((tasks.filter((task) => task.status === "done").length / tasks.length) * 100)
        : null
    });
  });

  app.post("/api/product/customer/:token/tasks/:stepId/csv", sameOrigin,
    limitRequests("customer-csv-validation", 5, 15 * 60 * 1000, "Too many CSV uploads. Please wait before trying again."),
    async (req, res) => {
      const token = req.params.token;
      const stepId = validId(req.params.stepId);
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !stepId) return sendError(res, 404, "Customer task not found.");
      const access = await resolveCustomerAccess(token);
      if (!access || access.kind !== "delegate") {
        return sendError(res, 403, "Only a scoped task delegate can upload a task data file.");
      }
      const implementationId = access.implementation.implementation_id;
      const workspaceId = access.implementation.workspace_id;
      const plan = await database.prepare(`
        SELECT plan FROM product_workspace_subscriptions
        WHERE workspace_id = $1 AND expires_at > CURRENT_TIMESTAMP
      `).get(workspaceId);
      if (plan?.plan !== "custom") {
        return sendError(res, 403, "CSV schema validation is available on Custom workspaces.");
      }
      const task = await database.prepare(`
        SELECT s.id, s.csv_schema_json
        FROM product_implementation_steps s
        JOIN product_customer_task_delegation_steps assigned
          ON assigned.step_id = s.id AND assigned.delegation_id = $3
        WHERE s.id = $1 AND s.implementation_id = $2 AND s.customer_visible = TRUE
      `).get(stepId, implementationId, access.delegation.delegation_id);
      if (!task) return sendError(res, 403, "This task is outside this invitation’s scope.");
      let schema;
      try {
        const storedSchema = Array.isArray(task.csv_schema_json)
          ? task.csv_schema_json : JSON.parse(task.csv_schema_json || "[]");
        schema = validateCsvSchema(storedSchema);
      } catch {
        schema = null;
      }
      if (!schema) return sendError(res, 500, "This task’s CSV schema is invalid. Ask your implementation team to review it.");
      if (!schema.length) return sendError(res, 409, "CSV validation is not configured for this task.");
      if (!Buffer.isBuffer(req.body) || req.body.length < 1 || req.body.length > MAX_CSV_BYTES) {
        return sendError(res, 400, "Choose a CSV file no larger than 5 MB.");
      }
      const filename = safeCustomerFilename(req.get("X-Relay-Filename") || "");
      const contentType = (req.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      const extension = filename.toLowerCase().split(".").pop();
      const validatedContentType = customerFileType(contentType, filename, req.body);
      if (!["csv", "xlsx"].includes(extension) || !validatedContentType) {
        return sendError(res, 400, "Choose a valid CSV or XLSX file.");
      }
      let malwareScan;
      try {
        malwareScan = await scanCustomerUpload(req.body);
      } catch (error) {
        if (!(error instanceof MalwareScannerError)) throw error;
        console.error(JSON.stringify({
          event: "customer_upload_scan_unavailable",
          workspace_id: workspaceId,
          implementation_id: implementationId,
          task_id: stepId,
          error_code: error.code
        }));
        return sendError(res, 503, "Secure file scanning is temporarily unavailable. Try again later.");
      }
      if (malwareScan.status === "infected") {
        await writeAuditLog({
          workspaceId,
          implementationId,
          actorId: `delegate:${access.delegation.delegation_id}`,
          actorEmail: access.delegation.delegate_email,
          ipAddress: req.ip,
          action: "customer.csv_rejected_malware",
          diff: { taskId: stepId, sizeBytes: req.body.length }
        });
        return sendError(res, 422, "The file did not pass malware scanning. Choose another file or contact your implementation team.");
      }
      let parsed;
      if (extension === "xlsx") {
        parsed = await parseXlsx(req.body);
      } else {
        let csvText;
        try {
          csvText = new TextDecoder("utf-8", { fatal: true }).decode(req.body);
        } catch {
          return sendError(res, 400, "The CSV must use UTF-8 text encoding.");
        }
        parsed = parseCsv(csvText);
      }
      if (parsed.structureErrors.length) {
        return res.status(422).json({
          valid: false,
          errorCount: parsed.structureErrors.length,
          errors: parsed.structureErrors
        });
      }
      const mappingHeader = req.get("X-Relay-Csv-Mapping") || "";
      if (!mappingHeader) {
        res.setHeader("Cache-Control", "no-store");
        return res.json({
          mappingRequired: true,
          headers: parsed.headers,
          suggestions: suggestCsvHeaderMapping(parsed.headers, schema),
          rowCount: parsed.rows.length
        });
      }
      if (mappingHeader.length > 8192) return sendError(res, 400, "The column mapping is too large.");
      let mapping;
      try {
        mapping = JSON.parse(Buffer.from(mappingHeader, "base64url").toString("utf8"));
      } catch {
        return sendError(res, 400, "Confirm a valid column mapping.");
      }
      const validation = validateCsvRows(parsed, schema, mapping);
      if (!validation.valid) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(422).json({
          valid: false,
          rowCount: parsed.rows.length,
          errorCount: validation.errorCount,
          errors: validation.errors
        });
      }
      const taskLock = await database.prepare(`
        SELECT EXISTS (
          SELECT 1 FROM product_change_order_steps linked
          JOIN product_change_orders co ON co.id = linked.change_order_id
          WHERE linked.implementation_id = $1 AND linked.step_id = $2
            AND co.status = 'pending_client'
        ) AS locked
      `).get(implementationId, stepId);
      if (taskLock?.locked) return sendError(res, 409, "This task is locked until its change order is approved.");
      const saved = await database.transaction(async () => {
        const currentTask = await database.prepare(`
          SELECT csv_schema_hash FROM product_implementation_steps
          WHERE id = $1 AND implementation_id = $2 FOR UPDATE
        `).get(stepId, implementationId);
        if (!currentTask || currentTask.csv_schema_hash !== csvSchemaHash(schema)) {
          return { staleSchema: true };
        }
        await database.prepare(`
          SELECT id FROM product_implementations WHERE id = $1 FOR UPDATE
        `).get(implementationId);
        const usage = await database.prepare(`
          SELECT COUNT(*)::integer AS file_count, COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes
          FROM product_customer_files WHERE implementation_id = $1
        `).get(implementationId);
        if (usage.file_count >= CUSTOMER_FILE_COUNT_LIMIT
          || Number(usage.total_bytes) + req.body.length > CUSTOMER_FILE_TOTAL_LIMIT) {
          return { storageLimit: true };
        }
        const file = await database.prepare(`
          INSERT INTO product_customer_files
            (implementation_id, contact_id, uploaded_by_role, uploaded_by_name, filename,
             content_type, size_bytes, content, task_id, validation_schema_hash, scan_status, scanned_at)
          VALUES ($1, NULL, 'customer', $2, $3, $4, $5, $6, $7, $8, 'clean', CURRENT_TIMESTAMP)
          RETURNING id
        `).get(implementationId, access.delegation.delegate_name || access.delegation.delegate_email,
          filename, validatedContentType, req.body.length, req.body, stepId, csvSchemaHash(schema));
        return { id: file.id };
      });
      if (saved.staleSchema) return sendError(res, 409, "The task’s CSV schema changed. Reload the portal and validate your file again.");
      if (saved.storageLimit) return sendError(res, 413, "This implementation has reached its shared file storage limit.");
      await writeAuditLog({
        workspaceId,
        implementationId,
        actorId: `delegate:${access.delegation.delegation_id}`,
        actorEmail: access.delegation.delegate_email,
        ipAddress: req.ip,
        action: "customer.csv_uploaded",
        diff: { taskId: stepId, fileId: saved.id, rowCount: parsed.rows.length }
      });
      await database.prepare(`
        UPDATE product_customer_task_delegations SET last_activity_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `).run(access.delegation.delegation_id);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ valid: true, fileId: saved.id, rowCount: parsed.rows.length, errorCount: 0 });
    });

  app.post("/api/product/customer/:token/tasks/:stepId/credentials/test", sameOrigin,
    limitRequests("customer-credential-test", 3, 15 * 60 * 1000, "Too many connection tests. Please wait before trying again."),
    async (req, res) => {
      const token = req.params.token;
      const stepId = validId(req.params.stepId);
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !stepId) return sendError(res, 404, "Customer task not found.");
      const access = await resolveCustomerAccess(token);
      if (!access || access.kind !== "delegate") {
        return sendError(res, 403, "Only a scoped task delegate can test a task connection.");
      }
      const workspaceId = access.implementation.workspace_id;
      const implementationId = access.implementation.implementation_id;
      const plan = await database.prepare(`
        SELECT plan FROM product_workspace_subscriptions
        WHERE workspace_id = $1 AND expires_at > CURRENT_TIMESTAMP
      `).get(workspaceId);
      if (plan?.plan !== "custom") {
        return sendError(res, 403, "Credential verification is available on Custom workspaces.");
      }
      const task = await database.prepare(`
        SELECT s.credential_verification_json
        FROM product_implementation_steps s
        JOIN product_customer_task_delegation_steps assigned
          ON assigned.step_id = s.id AND assigned.delegation_id = $3
        WHERE s.id = $1 AND s.implementation_id = $2 AND s.customer_visible = TRUE
      `).get(stepId, implementationId, access.delegation.delegation_id);
      if (!task) return sendError(res, 403, "This task is outside this invitation’s scope.");
      let config;
      try {
        config = typeof task.credential_verification_json === "string"
          ? JSON.parse(task.credential_verification_json) : task.credential_verification_json;
      } catch {
        config = null;
      }
      const provider = validateCredentialProvider(config?.provider);
      if (!provider) return sendError(res, 409, "Connection verification is not configured for this task.");
      const result = await testCredentialConnection(provider, req.body?.credential);
      const verified = await database.prepare(`
        UPDATE product_implementation_steps
        SET credential_verified_provider = CASE WHEN $4 THEN $3 ELSE '' END,
          credential_verified_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = $1 AND implementation_id = $2 AND customer_visible = TRUE
          AND credential_verification_json->>'provider' = $3
          AND EXISTS (
            SELECT 1 FROM product_customer_task_delegation_steps assigned
            WHERE assigned.step_id = $1 AND assigned.delegation_id = $5
          )
      `).run(stepId, implementationId, provider, result.success, access.delegation.delegation_id);
      if (!verified.changes) return sendError(res, 409, "The connection settings changed. Reload the portal and try again.");
      await writeAuditLog({
        workspaceId,
        implementationId,
        actorId: `delegate:${access.delegation.delegation_id}`,
        actorEmail: access.delegation.delegate_email,
        ipAddress: req.ip,
        action: "customer.credential_tested",
        diff: { taskId: stepId, provider, status: result.status, success: result.success }
      });
      await database.prepare(`
        UPDATE product_customer_task_delegations SET last_activity_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `).run(access.delegation.delegation_id);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ provider, ...result });
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
    if (access.kind !== "delegate") {
      return sendError(res, 403, "The primary customer portal is read-only. Only a scoped task delegate can complete assigned tasks.");
    }
    if (inputs.length) return sendError(res, 403, "Scoped delegates can only complete their assigned tasks.");
    const stepIds = completedStepIds.map(validId);
    if (stepIds.some((id) => !id) || new Set(stepIds).size !== stepIds.length || !stepIds.length) {
      return sendError(res, 400, "Choose valid assigned customer tasks.");
    }
    const authorizedImplementation = access.implementation;
    const implementationId = authorizedImplementation.implementation_id;
    const assignedTasks = await database.prepare(`
      SELECT s.id, s.is_blocked, s.csv_schema_json, s.credential_verification_json,
        s.credential_verified_provider, s.credential_verified_at,
        EXISTS (
          SELECT 1 FROM product_implementation_step_dependencies d
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE d.implementation_step_id = s.id AND parent.status != 'done'
        ) AS waiting
      FROM product_implementation_steps s
      JOIN product_customer_task_delegation_steps assigned
        ON assigned.step_id = s.id AND assigned.delegation_id = $3
      WHERE s.implementation_id = $1 AND s.customer_visible = TRUE
        AND s.id = ANY($2::integer[])
    `).all(implementationId, stepIds, access.delegation.delegation_id);
    if (assignedTasks.length !== stepIds.length) return sendError(res, 403, "One or more tasks are outside this invitation’s scope.");
    if (assignedTasks.some((step) => step.is_blocked)) {
      return sendError(res, 409, "This task is blocked. Contact your implementation lead for the next update.");
    }
    if (assignedTasks.some((step) => step.waiting)) {
      return sendError(res, 409, "Complete the prerequisite steps before marking this task done.");
    }
    const workspacePlan = await database.prepare(`
      SELECT plan FROM product_workspace_subscriptions
      WHERE workspace_id = $1 AND expires_at > CURRENT_TIMESTAMP
    `).get(authorizedImplementation.workspace_id);
    if (workspacePlan?.plan === "custom") {
      for (const step of assignedTasks) {
        let schema;
        try {
          const storedSchema = Array.isArray(step.csv_schema_json)
            ? step.csv_schema_json : JSON.parse(step.csv_schema_json || "[]");
          schema = validateCsvSchema(storedSchema);
        } catch {
          schema = null;
        }
        if (!schema) return sendError(res, 500, "This task’s CSV schema is invalid. Ask your implementation team to review it.");
        if (schema.length) {
          const validUpload = await database.prepare(`
            SELECT 1 FROM product_customer_files
            WHERE implementation_id = $1 AND task_id = $2 AND validation_schema_hash = $3
            LIMIT 1
          `).get(implementationId, step.id, csvSchemaHash(schema));
          if (!validUpload) return sendError(res, 409, "Upload a valid CSV for each configured task before marking it complete.");
        }
        let credentialConfig;
        try {
          credentialConfig = typeof step.credential_verification_json === "string"
            ? JSON.parse(step.credential_verification_json) : step.credential_verification_json;
        } catch {
          return sendError(res, 500, "This task’s credential verification setting is invalid. Ask an administrator to review it.");
        }
        const provider = validateCredentialProvider(credentialConfig?.provider);
        if (credentialConfig?.provider && !provider) {
          return sendError(res, 500, "This task’s credential verification setting is invalid. Ask an administrator to review it.");
        }
        if (provider && (step.credential_verified_provider !== provider
          || !step.credential_verified_at
          || Date.parse(step.credential_verified_at) < Date.now() - 24 * 60 * 60 * 1000)) {
          return sendError(res, 409, "Test the configured provider connection successfully before marking this task complete.");
        }
      }
    }
    const completed = await database.transaction(async () => {
      await database.prepare(`
        SELECT id FROM product_implementation_steps
        WHERE implementation_id = $1 AND id = ANY($2::integer[]) FOR UPDATE
      `).all(implementationId, stepIds);
      const lockedTasks = await database.prepare(`
        SELECT linked.step_id
        FROM product_change_order_steps linked
        JOIN product_change_orders co ON co.id = linked.change_order_id
        WHERE linked.implementation_id = $1 AND linked.step_id = ANY($2::integer[])
          AND co.status = 'pending_client'
      `).all(implementationId, stepIds);
      if (lockedTasks.length) return { locked: true, count: 0 };
      const result = await database.prepare(`
        UPDATE product_implementation_steps SET status = 'done', updated_at = CURRENT_TIMESTAMP
        WHERE implementation_id = $1 AND customer_visible = TRUE AND status != 'done'
          AND id = ANY($2::integer[])
          AND EXISTS (
            SELECT 1 FROM product_customer_task_delegation_steps assigned
            WHERE assigned.delegation_id = $3 AND assigned.step_id = product_implementation_steps.id
          )
      `).run(implementationId, stepIds, access.delegation.delegation_id);
      if (result.changes) {
        await enqueueWorkspaceEvent(authorizedImplementation.workspace_id, implementationId, "customer.tasks_completed", {
          count: result.changes
        });
        await writeAuditLog({
          workspaceId: authorizedImplementation.workspace_id,
          implementationId,
          actorId: `delegate:${access.delegation.delegation_id}`,
          actorEmail: access.delegation.delegate_email,
          ipAddress: req.ip,
          action: "customer.task_completed",
          diff: { taskIds: stepIds }
        });
      }
      await database.prepare(`
        UPDATE product_customer_task_delegations SET last_activity_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `).run(access.delegation.delegation_id);
      return { locked: false, count: result.changes };
    });
    if (completed.locked) return sendError(res, 409, "This task is locked until its change order is approved.");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.json({ success: true, completed: completed.count });
  });

  app.post("/api/product/customer/:token/messages", sameOrigin,
    limitRequests("customer-message", 10, 15 * 60 * 1000, "Too many messages. Please wait before sending another."),
    async (req, res) => {
      const token = req.params.token;
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return sendError(res, 404, "Customer link not found.");
      const access = await resolveCustomerAccess(token);
      if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
      return sendError(res, 403, "The customer portal is read-only. Contact your implementation lead for help.");
    });

  app.post("/api/product/customer/:token/files", sameOrigin, async (req, res) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return sendError(res, 404, "Customer link not found.");
    const access = await resolveCustomerAccess(token);
    if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
    return sendError(res, 403, "The customer portal is read-only. Ask your implementation lead to share files.");
    });

  app.get("/api/product/customer/:token/files/:fileId", async (req, res) => {
    const token = req.params.token;
    const fileId = validId(req.params.fileId);
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !fileId) {
      return sendError(res, 404, "Customer file not found.");
    }
    const access = await resolveCustomerAccess(token);
    if (!access) return sendError(res, 404, "Customer file not found.");
    if (access.kind === "delegate") return sendError(res, 404, "Customer file not found.");
    const file = await database.prepare(`
      SELECT id, filename, content_type, content, size_bytes, scan_status FROM product_customer_files
      WHERE id = $1 AND implementation_id = $2
    `).get(fileId, access.implementation.implementation_id);
    if (!file) return sendError(res, 404, "Customer file not found.");
    let isClean;
    try {
      isClean = await ensureCustomerFileScanned(
        file,
        access.implementation.workspace_id,
        access.implementation.implementation_id
      );
    } catch (error) {
      if (!(error instanceof MalwareScannerError)) throw error;
      return sendError(res, 503, "Customer file scanning is temporarily unavailable. Try again later.");
    }
    if (!isClean) return sendError(res, 404, "Customer file not found.");
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
      SELECT f.id, f.filename, f.content_type, f.content, f.size_bytes, f.scan_status
      FROM product_customer_files f
      JOIN product_implementations i ON i.id = f.implementation_id
      WHERE f.id = $1 AND f.implementation_id = $2 AND i.workspace_id = $3
    `).get(fileId, implementationId, req.product.workspaceId);
    if (!file) return sendError(res, 404, "Customer file not found.");
    let isClean;
    try {
      isClean = await ensureCustomerFileScanned(file, req.product.workspaceId, implementationId);
    } catch (error) {
      if (!(error instanceof MalwareScannerError)) throw error;
      return sendError(res, 503, "Customer file scanning is temporarily unavailable. Try again later.");
    }
    if (!isClean) return sendError(res, 410, "This file failed malware scanning and cannot be downloaded.");
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
    const deleted = await database.transaction(async () => {
      const file = await database.prepare(`
        SELECT f.task_id FROM product_customer_files f
        JOIN product_implementations i ON i.id = f.implementation_id
        WHERE f.id = $1 AND f.implementation_id = $2 AND i.workspace_id = $3
        FOR UPDATE OF f
      `).get(fileId, implementationId, req.product.workspaceId);
      if (!file) return false;
      await database.prepare(`
        DELETE FROM product_customer_files
        WHERE id = $1 AND implementation_id = $2
      `).run(fileId, implementationId);
      await writeAuditLog({
        workspaceId: req.product.workspaceId,
        implementationId,
        actorId: `user:${req.product.userId}`,
        actorEmail: req.product.email,
        ipAddress: req.ip,
        action: "customer.file_deleted",
        diff: { fileId, taskId: file.task_id }
      });
      return true;
    });
    if (!deleted) return sendError(res, 404, "Customer file not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/customer/:token/delegations", sameOrigin,
    limitRequests("customer-task-delegation", 10, 15 * 60 * 1000, "Too many delegation requests. Please wait before trying again."),
    async (req, res) => {
      const token = req.params.token;
      const access = /^[A-Za-z0-9_-]{40,60}$/.test(token) ? await resolveCustomerAccess(token) : null;
      if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
      const isPrimary = access.kind === "contact"
        && access.contact.contact_email.toLowerCase()
          === String(access.implementation.customer_owner_email || "").toLowerCase();
      if (!isPrimary) return sendError(res, 403, "Only the primary customer contact can delegate tasks.");
      const email = requiredText(req.body.email, 254).toLowerCase();
      const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim().slice(0, 120) : "";
      const stakeholderRole = req.body.stakeholderRole;
      const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds.map(validId) : [];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || !["it", "legal", "finance", "ops", "other"].includes(stakeholderRole)
        || !taskIds.length || taskIds.length > 20 || taskIds.some((id) => !id)
        || new Set(taskIds).size !== taskIds.length) {
        return sendError(res, 400, "Enter a valid teammate email, role, and one or more tasks to delegate.");
      }
      const expiresAt = new Date(Date.now() + CUSTOMER_LINK_DAYS * 86400000).toISOString();
      const rawToken = randomBytes(32).toString("base64url");
      const delegation = await database.transaction(async () => {
        const tasks = await database.prepare(`
          SELECT id FROM product_implementation_steps
          WHERE implementation_id = $1 AND customer_visible = TRUE AND status != 'done'
            AND id = ANY($2::integer[]) FOR UPDATE
        `).all(access.implementation.implementation_id, taskIds);
        if (tasks.length !== taskIds.length) return null;
        const created = await database.prepare(`
          INSERT INTO product_customer_task_delegations
            (implementation_id, primary_contact_id, email, display_name, stakeholder_role, token_hash, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, email, display_name, stakeholder_role, expires_at
        `).get(
          access.implementation.implementation_id,
          access.contact.contact_id,
          email,
          displayName,
          stakeholderRole,
          hashToken(rawToken),
          expiresAt
        );
        const addTask = database.prepare(`
          INSERT INTO product_customer_task_delegation_steps (delegation_id, implementation_id, step_id)
          VALUES ($1, $2, $3)
        `);
        for (const stepId of taskIds) await addTask.run(
          created.id, access.implementation.implementation_id, stepId
        );
        await writeAuditLog({
          workspaceId: access.implementation.workspace_id,
          implementationId: access.implementation.implementation_id,
          actorId: `contact:${access.contact.contact_id}`,
          actorEmail: access.contact.contact_email,
          ipAddress: req.ip,
          action: "customer.tasks_delegated",
          diff: { delegationId: created.id, email, stakeholderRole, taskIds }
        });
        return created;
      });
      if (!delegation) return sendError(res, 400, "Choose open customer-visible tasks from this implementation.");
      const link = customerPortalUrl(req, rawToken);
      let invitation = { sent: false, error: "Customer email is not configured. Copy the secure link and share it directly." };
      try {
        invitation = await sendProductEmail({
          to: email,
          subject: `Tasks delegated to you for ${access.implementation.customer_name}`,
          text: `Hello${displayName ? ` ${displayName}` : ""},\n\n${access.contact.contact_name || "Your project lead"} delegated ${taskIds.length} customer task${taskIds.length === 1 ? "" : "s"} to you as ${stakeholderRole}. Open this private link to review and complete only those assigned tasks:\n\n${link}\n\nThis scoped invitation expires in ${CUSTOMER_LINK_DAYS} days.`
        });
      } catch (error) {
        invitation = { sent: false, error: `Invitation email could not be sent: ${error.message}` };
      }
      return res.status(201).json({
        delegation,
        invitationSent: invitation.sent,
        ...(invitation.sent ? {} : { message: invitation.error, delegationPortalUrl: link })
      });
    });

  app.post("/api/product/customer/:token/delegations/:delegationId/revoke", sameOrigin, async (req, res) => {
    const token = req.params.token;
    const delegationId = validId(req.params.delegationId);
    const access = /^[A-Za-z0-9_-]{40,60}$/.test(token) ? await resolveCustomerAccess(token) : null;
    if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
    const isPrimary = access.kind === "contact"
      && access.contact.contact_email.toLowerCase()
        === String(access.implementation.customer_owner_email || "").toLowerCase();
    if (!isPrimary) return sendError(res, 403, "Only the primary customer contact can revoke task delegation.");
    if (!delegationId) return sendError(res, 400, "Invalid task delegation.");
    const revoked = await database.prepare(`
      UPDATE product_customer_task_delegations SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND implementation_id = $2 AND primary_contact_id = $3 AND revoked_at IS NULL
      RETURNING id, email, stakeholder_role
    `).get(delegationId, access.implementation.implementation_id, access.contact.contact_id);
    if (!revoked) return sendError(res, 404, "Active task delegation not found.");
    await writeAuditLog({
      workspaceId: access.implementation.workspace_id,
      implementationId: access.implementation.implementation_id,
      actorId: `contact:${access.contact.contact_id}`,
      actorEmail: access.contact.contact_email,
      ipAddress: req.ip,
      action: "customer.delegation_revoked",
      diff: { delegationId, email: revoked.email, stakeholderRole: revoked.stakeholder_role }
    });
    return res.json({ success: true });
  });

  app.post("/api/product/customer/:token/change-orders/:changeOrderId/decision", sameOrigin, async (req, res) => {
    const token = req.params.token;
    const changeOrderId = validId(req.params.changeOrderId);
    const decision = req.body.decision;
    const consent = req.body.consent === true;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !changeOrderId
      || !["approved", "rejected"].includes(decision) || (decision === "approved" && !consent)) {
      return sendError(res, 400, "Review the change order and confirm your approval decision.");
    }
    const access = await resolveCustomerAccess(token);
    if (!access) return sendError(res, 404, "Customer link not found or no longer available.");
    const isPrimary = access.kind === "contact"
      && access.contact.contact_email.toLowerCase()
        === String(access.implementation.customer_owner_email || "").toLowerCase();
    if (!isPrimary) return sendError(res, 403, "Only the primary customer contact can sign a change order.");
    const result = await database.transaction(async () => {
      const implementation = await database.prepare(`
        SELECT id, workspace_id, target_launch_date, projected_go_live_date
        FROM product_implementations WHERE id = $1 AND archived_at IS NULL FOR UPDATE
      `).get(access.implementation.implementation_id);
      if (!implementation) return { error: "Implementation not found.", status: 404 };
      const order = await database.prepare(`
        SELECT id, title, additional_fee, timeline_extension_days, status
        FROM product_change_orders
        WHERE id = $1 AND implementation_id = $2 FOR UPDATE
      `).get(changeOrderId, implementation.id);
      if (!order) return { error: "Change order not found.", status: 404 };
      if (order.status !== "pending_client") {
        return { error: "This change order is no longer awaiting a decision.", status: 409 };
      }
      let projectedGoLiveDate = implementation.projected_go_live_date || implementation.target_launch_date || "";
      if (decision === "approved" && order.timeline_extension_days > 0) {
        if (!validDate(projectedGoLiveDate)) projectedGoLiveDate = new Date().toISOString().slice(0, 10);
        const date = new Date(`${projectedGoLiveDate}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() + order.timeline_extension_days);
        projectedGoLiveDate = date.toISOString().slice(0, 10);
      }
      const signedAt = new Date().toISOString();
      await database.prepare(`
        UPDATE product_change_orders
        SET status = $1, signed_by_email = $2, signed_ip = $3, signed_at = $4, updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
      `).run(decision, access.contact.contact_email, req.ip || "", signedAt, changeOrderId);
      if (decision === "approved" && order.timeline_extension_days > 0) {
        await database.prepare(`
          UPDATE product_implementations SET projected_go_live_date = $1 WHERE id = $2
        `).run(projectedGoLiveDate, implementation.id);
      }
      await writeAuditLog({
        workspaceId: implementation.workspace_id,
        implementationId: implementation.id,
        actorId: `contact:${access.contact.contact_id}`,
        actorEmail: access.contact.contact_email,
        ipAddress: req.ip,
        action: decision === "approved" ? "change_order.approved" : "change_order.rejected",
        diff: {
          changeOrderId,
          title: order.title,
          status: decision,
          additionalFee: Number(order.additional_fee),
          timelineExtensionDays: order.timeline_extension_days,
          projectedGoLiveDate: decision === "approved" ? projectedGoLiveDate : null
        }
      });
      await enqueueWorkspaceEvent(implementation.workspace_id, implementation.id, "change_order.client_decision", {
        title: order.title,
        decision,
        contactEmail: access.contact.contact_email
      });
      return { success: true, status: decision, projectedGoLiveDate };
    });
    if (result.error) return sendError(res, result.status, result.error);
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.json(result);
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
          AND i.archived_at IS NULL
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
