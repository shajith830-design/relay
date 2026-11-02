"use strict";

const express = require("express");
const db = require("./db");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const path = require("node:path");
const { makePasswordHash } = require("./product-auth");

/*
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   INQUIRIES_API_TOKEN
 *
 * Keep secrets private.
 */
const isProduction = process.env.NODE_ENV === "production";
const env = (name, fallback = "") => process.env[name]?.trim() || fallback;
const portValue = Number.parseInt(env("PORT", "3000"), 10);
const port = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535
 ? portValue
 : 3000;
const trustProxyHops = Number.parseInt(env("TRUST_PROXY_HOPS", "0"), 10);
if (port !== portValue) {
 console.warn(`Invalid PORT; using ${port}.`);
}
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) {
  throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 10.");
}

const config = {
 inquiriesApiToken: env("INQUIRIES_API_TOKEN"),
 ownerAdminToken: env("OWNER_ADMIN_TOKEN"),
 port
};

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", trustProxyHops);
app.use((_req, res, next) => {
  const headers = {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
  if (isProduction) headers["Strict-Transport-Security"] = "max-age=31536000";
  res.set(headers);
  next();
});
app.use("/api/product/customer", express.json({ limit: "128kb" }));
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.get("/product", (req, res) => {
  const query = req.originalUrl.slice("/product".length);
  return res.redirect(302, `/product.html${query}`);
});
if (process.env.RELAY_CLOUDFLARE_WORKER !== "1") {
  app.use(express.static(path.join(__dirname, "public"), {
    etag: true,
    maxAge: isProduction ? "1h" : 0
  }));
}

require("./product-routes")(app, db, isProduction);

async function sendInquiryNotification(inquiry) {
  const notifications = [];
  const notificationEmail = process.env.INQUIRY_NOTIFICATION_EMAIL?.trim();
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const emailFrom = process.env.AUTH_EMAIL_FROM?.trim();

  if (notificationEmail && resendApiKey && emailFrom) {
    notifications.push((async () => {
      try {
        const emailUrl = process.env.NODE_ENV === "test" && process.env.AUTH_EMAIL_API_URL
          ? process.env.AUTH_EMAIL_API_URL
          : "https://api.resend.com/emails";
        const response = await fetch(emailUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: emailFrom,
            to: [notificationEmail],
            subject: "New Relay contact or demo inquiry",
            text: `A new inquiry was submitted through the Relay website.\n\nName: ${inquiry.name}\nPhone: ${inquiry.phone}\n\n${inquiry.message}\n\nInquiry ID: ${inquiry.id}`
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
          console.error(JSON.stringify({
            event: "inquiry_email_notification_failed",
            inquiry_id: inquiry.id,
            provider_status: response.status
          }));
          return;
        }
        console.info(JSON.stringify({ event: "inquiry_email_notification_sent", inquiry_id: inquiry.id }));
      } catch (error) {
        console.error(JSON.stringify({
          event: "inquiry_email_notification_failed",
          inquiry_id: inquiry.id,
          reason: error.name === "TimeoutError" ? "timeout" : "request_error",
          message: error.message
        }));
      }
    })());
  } else {
    console.error(JSON.stringify({
      event: "inquiry_email_notification_failed",
      inquiry_id: inquiry.id,
      reason: "email_not_configured"
    }));
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const messageText =
    `📩 *New Customer Onboarding Inquiry*\n\n` +
    `👤 *Name:* ${inquiry.name}\n` +
    `📞 *Phone:* ${inquiry.phone}\n` +
    `💬 *Message:* ${inquiry.message}`;

  if (botToken && chatId) notifications.push((async () => {
    try {
      const telegramUrl = process.env.NODE_ENV === "test" && process.env.TELEGRAM_API_URL
        ? process.env.TELEGRAM_API_URL
        : `https://api.telegram.org/bot${botToken}/sendMessage`;
      const response = await fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: messageText
        }),
        signal: AbortSignal.timeout(10000)
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        console.info(JSON.stringify({ event: "inquiry_telegram_notification_sent", inquiry_id: inquiry.id }));
        return;
      }
      console.error(JSON.stringify({
        event: "inquiry_telegram_notification_failed",
        inquiry_id: inquiry.id,
        provider_status: response.status
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "inquiry_telegram_notification_failed",
        inquiry_id: inquiry.id,
        reason: error.name === "TimeoutError" ? "timeout" : "request_error",
        message: error.message
      }));
    }
  })());
  await Promise.all(notifications);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function allowInquirySubmissionCors(_req, res, next) {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  next();
}

const inquirySubmissionAttempts = new Map();
function rateLimitInquirySubmission(req, res, next) {
  const now = Date.now();
  for (const [ip, bucket] of inquirySubmissionAttempts) {
    if (now - bucket.windowStart >= 60 * 1000) inquirySubmissionAttempts.delete(ip);
  }
  const key = req.ip || "unknown";
  const bucket = inquirySubmissionAttempts.get(key) || { count: 0, windowStart: now };
  if (bucket.count >= 5) {
    return res.status(429).json({ success: false, error: "Too many inquiries. Please try again later." });
  }
  bucket.count += 1;
  inquirySubmissionAttempts.set(key, bucket);
  return next();
}

app.options("/api/inquiries", allowInquirySubmissionCors, (_req, res) => {
  res.sendStatus(204);
});

app.post("/api/inquiries", allowInquirySubmissionCors, rateLimitInquirySubmission, asyncRoute(async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
  const message = typeof req.body.message === "string" ? req.body.message.trim() : "";

  if (!name || name.length > 120 || !/^\+[1-9]\d{7,14}$/.test(phone) || !message || message.length > 2000) {
    return res.status(400).json({
      success: false,
      error: "Name (up to 120 characters), a valid E.164 phone number, and a message (up to 2000 characters) are required"
    });
  }

  const inquiry = await db.createInquiry({ name, phone, message });
  await sendInquiryNotification(inquiry);
  return res.status(201).json({ success: true, inquiry: { id: inquiry.id } });
}));

function authorizeAdminRequest(req, res, expectedToken, tokenName) {
  res.setHeader("Cache-Control", "no-store");
  if (!expectedToken) {
    console.error(`Rejected admin request: ${tokenName} is not configured.`);
    res.status(503).json({ success: false, error: "Admin access is not configured." });
    return false;
  }

  const authorization = req.get("Authorization") || "";
  const providedToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || "";
  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  const validToken = expected.length === provided.length
    && timingSafeEqual(expected, provided);

  if (!validToken) {
    res.status(401).json({ success: false, error: "Unauthorized. Enter a valid admin token." });
    return false;
  }
  return true;
}

app.get("/inquiries", asyncRoute(async (req, res) => {
  if (!authorizeAdminRequest(req, res, config.inquiriesApiToken, "INQUIRIES_API_TOKEN")) return;
  try {
    const inquiries = await db.getInquiries();
    return res.json({
      success: true,
      count: inquiries.length,
      inquiries
    });
  } catch (error) {
    console.error(`Error fetching inquiries: ${error.message}`);
    return res.status(500).json({ success: false, error: "Failed to retrieve inquiries" });
  }
}));

app.get("/admin/workspaces", asyncRoute(async (req, res) => {
  if (!authorizeAdminRequest(req, res, config.ownerAdminToken, "OWNER_ADMIN_TOKEN")) return;
  const workspaces = await db.database.prepare(`
    SELECT w.id, w.name, u.email AS owner_email, s.activated_at, s.expires_at,
      (s.expires_at > CURRENT_TIMESTAMP) AS active
    FROM product_workspace_subscriptions s
    JOIN product_workspaces w ON w.id = s.workspace_id
    JOIN product_memberships m ON m.workspace_id = w.id AND m.role = 'owner'
    JOIN product_users u ON u.id = m.user_id
    ORDER BY s.expires_at DESC, w.id DESC
  `).all();
  return res.json({ success: true, workspaces });
}));

app.post("/admin/workspaces", asyncRoute(async (req, res) => {
  if (!authorizeAdminRequest(req, res, config.ownerAdminToken, "OWNER_ADMIN_TOKEN")) return;
  const name = typeof req.body.workspaceName === "string" ? req.body.workspaceName.trim() : "";
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({
      success: false,
      error: "Enter a workspace name (up to 100 characters) and a valid owner email."
    });
  }

  const initialPassword = randomBytes(24).toString("base64url");
  const passwordHash = await makePasswordHash(initialPassword);
  try {
    const workspace = await db.database.transaction(async () => {
      const owner = await db.database.prepare(
        "INSERT INTO product_users (email, password_hash) VALUES ($1, $2) RETURNING id, email"
      ).get(email, passwordHash);
      const createdWorkspace = await db.database.prepare(
        "INSERT INTO product_workspaces (name) VALUES ($1) RETURNING id, name"
      ).get(name);
      await db.database.prepare(
        "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')"
      ).run(createdWorkspace.id, owner.id);
      const subscription = await db.database.prepare(`
        INSERT INTO product_workspace_subscriptions (workspace_id, activated_at, expires_at)
        VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 month')
        RETURNING activated_at, expires_at
      `).get(createdWorkspace.id);
      return { ...createdWorkspace, ownerEmail: owner.email, ...subscription };
    });
    console.info(JSON.stringify({
      event: "paid_workspace_provisioned",
      workspace_id: workspace.id,
      owner_email: workspace.ownerEmail
    }));
    return res.status(201).json({ success: true, workspace, initialPassword });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "An account with that email already exists. Contact Relay for help managing its workspace."
      });
    }
    throw error;
  }
}));

app.post("/admin/workspaces/:workspaceId/renew", asyncRoute(async (req, res) => {
  if (!authorizeAdminRequest(req, res, config.ownerAdminToken, "OWNER_ADMIN_TOKEN")) return;
  const workspaceIdValue = req.params.workspaceId;
  const workspaceId = /^\d+$/.test(workspaceIdValue) ? Number.parseInt(workspaceIdValue, 10) : 0;
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) {
    return res.status(400).json({ success: false, error: "Invalid workspace." });
  }
  const renewed = await db.database.prepare(`
    UPDATE product_workspace_subscriptions
    SET expires_at = GREATEST(expires_at, CURRENT_TIMESTAMP) + INTERVAL '1 month'
    WHERE workspace_id = $1
    RETURNING expires_at
  `).get(workspaceId);
  if (!renewed) return res.status(404).json({ success: false, error: "Paid workspace not found." });
  console.info(JSON.stringify({ event: "paid_workspace_renewed", workspace_id: workspaceId }));
  return res.json({ success: true, expiresAt: renewed.expires_at });
}));

app.get(["/health", "/healthz"], asyncRoute(async (_req, res) => {
  try {
    await db.ready;
    await db.database.prepare("SELECT 1").get();
    return res.status(200).json({ status: "ok", database: "ok" });
  } catch (error) {
    console.error(JSON.stringify({ event: "health_check_failed", message: error.message }));
    return res.status(503).json({ status: "unavailable", database: "unavailable" });
  }
}));

app.use((error, _req, res, _next) => {
  if (res.headersSent) {
    return;
  }
  console.error(JSON.stringify({
    event: "request_failed",
    message: error.message,
    status: error.status || 500
  }));
  res.status(error.status && error.status < 500 ? error.status : 500).send("Internal server error");
});

if (require.main === module) {
  db.ready.then(() => {
    const server = app.listen(config.port, () => {
      console.info(`Relay Automation server listening on port ${config.port}.`);
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        server.close(async (error) => {
          if (error) {
            console.error(`Failed to shut down cleanly: ${error.message}`);
            process.exit(1);
          }
          await db.close();
          process.exit(0);
        });
      });
    }
  }).catch((error) => {
    console.error(`Relay could not initialize its database: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = app;