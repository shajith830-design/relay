"use strict";

const express = require("express");
const db = require("./db");
const { timingSafeEqual } = require("node:crypto");
const path = require("node:path");

/*
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   LEADS_API_TOKEN
 *
 * Keep secrets private.
 */
const isProduction = process.env.NODE_ENV === "production";
const env = (name, fallback = "") => process.env[name]?.trim() || fallback;
const portValue = Number.parseInt(env("PORT", "3000"), 10);
const port = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535
 ? portValue
 : 3000;
if (port !== portValue) {
 console.warn(`Invalid PORT; using ${port}.`);
}

const config = {
 leadsApiToken: env("LEADS_API_TOKEN"),
 port
};

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: isProduction ? "1h" : 0
}));

async function sendLeadNotification(leadData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const messageText =
    `🚨 *New Lead Received!*\n\n` +
    `👤 *Name:* ${leadData.name || "N/A"}\n` +
    `📞 *Phone:* ${leadData.phone || "N/A"}\n` +
    `💬 *Message:* ${leadData.message || "N/A"}`;

  if (!botToken || !chatId) {
    console.error("❌ Failed to send Telegram notification: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.");
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
        parse_mode: "Markdown"
      })
    });

    const data = await response.json();
    if (data.ok) {
      console.log("✅ Telegram notification sent successfully!");
    } else {
      console.error("❌ Telegram API error:", data);
    }
  } catch (error) {
    console.error("❌ Failed to send Telegram notification:", error);
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.post("/api/leads", asyncRoute(async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
  const message = typeof req.body.message === "string" ? req.body.message.trim() : "";

  if (!name || name.length > 120 || !/^\+[1-9]\d{7,14}$/.test(phone) || !message || message.length > 2000) {
    return res.status(400).json({
      success: false,
      error: "Name (up to 120 characters), a valid E.164 phone number, and a message (up to 2000 characters) are required"
    });
  }

  const lead = db.createLead({ name, phone, message });
  await sendLeadNotification({ name, phone, message });
  return res.status(201).json({ success: true, lead });
}));

app.get("/leads", (req, res) => {
  if (!config.leadsApiToken) {
    console.error("Rejected leads API request: LEADS_API_TOKEN is not configured.");
    return res.status(503).json({ success: false, error: "Leads API is not configured" });
  }

  const authorization = req.get("Authorization") || "";
  const providedToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || "";
  const expected = Buffer.from(config.leadsApiToken);
  const provided = Buffer.from(providedToken);
  const validToken = expected.length === provided.length
    && timingSafeEqual(expected, provided);

  if (!validToken) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const leads = db.getLeads();
    return res.json({
      success: true,
      count: leads.length,
      leads
    });
  } catch (error) {
    console.error(`Error fetching leads: ${error.message}`);
    return res.status(500).json({ success: false, error: "Failed to retrieve leads" });
  }
});

app.get(["/health", "/healthz"], (_req, res) => {
  res.status(200).json({ status: "ok" });
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