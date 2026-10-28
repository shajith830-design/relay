"use strict";

const express = require("express");
const db = require("./db");
const { timingSafeEqual } = require("node:crypto");
const path = require("node:path");

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
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: isProduction ? "1h" : 0
}));

require("./product-routes")(app, db, isProduction);

async function sendInquiryNotification(inquiry) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const messageText =
    `📩 *New Customer Onboarding Inquiry*\n\n` +
    `👤 *Name:* ${inquiry.name}\n` +
    `📞 *Phone:* ${inquiry.phone}\n` +
    `💬 *Message:* ${inquiry.message}`;

  if (!botToken || !chatId) {
    console.error(JSON.stringify({
      event: "inquiry_notification_failed",
      inquiry_id: inquiry.id,
      reason: "telegram_not_configured"
    }));
    return;
  }

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
      console.info(JSON.stringify({ event: "inquiry_notification_sent", inquiry_id: inquiry.id }));
      return;
    }
    console.error(JSON.stringify({
      event: "inquiry_notification_failed",
      inquiry_id: inquiry.id,
      provider_status: response.status
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "inquiry_notification_failed",
      inquiry_id: inquiry.id,
      reason: error.name === "TimeoutError" ? "timeout" : "request_error",
      message: error.message
    }));
  }
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

  const inquiry = db.createInquiry({ name, phone, message });
  await sendInquiryNotification(inquiry);
  return res.status(201).json({ success: true, inquiry: { id: inquiry.id } });
}));

app.get("/inquiries", (req, res) => {
  if (!config.inquiriesApiToken) {
    console.error("Rejected inquiry API request: INQUIRIES_API_TOKEN is not configured.");
    return res.status(503).json({ success: false, error: "Inquiries API is not configured" });
  }

  const authorization = req.get("Authorization") || "";
  const providedToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || "";
  const expected = Buffer.from(config.inquiriesApiToken);
  const provided = Buffer.from(providedToken);
  const validToken = expected.length === provided.length
    && timingSafeEqual(expected, provided);

  if (!validToken) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const inquiries = db.getInquiries();
    return res.json({
      success: true,
      count: inquiries.length,
      inquiries
    });
  } catch (error) {
    console.error(`Error fetching inquiries: ${error.message}`);
    return res.status(500).json({ success: false, error: "Failed to retrieve inquiries" });
  }
});

app.get(["/health", "/healthz"], (_req, res) => {
  try {
    db.database.prepare("SELECT 1").get();
    return res.status(200).json({ status: "ok", database: "ok" });
  } catch (error) {
    console.error(JSON.stringify({ event: "health_check_failed", message: error.message }));
    return res.status(503).json({ status: "unavailable", database: "unavailable" });
  }
});

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
  const server = app.listen(config.port, () => {
    console.info(`Relay Automation server listening on port ${config.port}.`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close((error) => {
        if (error) {
          console.error(`Failed to shut down cleanly: ${error.message}`);
          process.exit(1);
        }
        db.close();
        process.exit(0);
      });
    });
  }
}

module.exports = app;