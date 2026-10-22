"use strict";

const express = require("express");
const twilio = require("twilio");
const db = require("./db");
const { timingSafeEqual } = require("node:crypto");
const path = require("node:path");

/*
 * Environment variables:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (E.164)
 *   HVAC_COMPANY_NAME, DISPATCHER_PHONE_NUMBER (E.164), PUBLIC_BASE_URL
 *   ALLOW_UNSIGNED_LOCAL_WEBHOOKS=true (optional, local development only)
 *
 * Local setup: run `npm install`, then `npx cloudflared tunnel --url http://localhost:3000`.
 * For real Twilio webhooks, set PUBLIC_BASE_URL to the HTTPS tunnel URL and configure
 * that URL plus /voice-webhook and /sms-webhook in the Twilio Console. Keep secrets private.
 * Unsigned requests are only accepted from loopback connections without a Cloudflare
 * request marker; never enable this bypass in production or use it for tunneled traffic.
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

let publicBaseUrl;
try {
  const parsedUrl = new URL(env("PUBLIC_BASE_URL", "http://localhost:3000"));
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("PUBLIC_BASE_URL must use HTTP or HTTPS.");
  }
  publicBaseUrl = parsedUrl.origin;
} catch (error) {
  console.warn(`Invalid PUBLIC_BASE_URL; using http://localhost:3000 (${error.message}).`);
  publicBaseUrl = "http://localhost:3000";
}

const config = {
  accountSid: env("TWILIO_ACCOUNT_SID"),
  authToken: env("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: env("TWILIO_PHONE_NUMBER"),
  companyName: env("HVAC_COMPANY_NAME", "your HVAC company"),
  dispatcherPhoneNumber: env("DISPATCHER_PHONE_NUMBER"),
  leadsApiToken: env("LEADS_API_TOKEN"),
  publicBaseUrl,
  port
};
const validPhoneNumber = (phone) => /^\+[1-9]\d{7,14}$/.test(phone);
const hasValidTwilioCredentials = /^AC[0-9a-f]{32}$/i.test(config.accountSid)
  && config.authToken.length > 0
  && validPhoneNumber(config.twilioPhoneNumber)
  && validPhoneNumber(config.dispatcherPhoneNumber);
const explicitLocalTestMode = ["1", "true", "yes"].includes(
  env("ALLOW_UNSIGNED_LOCAL_WEBHOOKS").toLowerCase()
);

const app = express();
const twilioClient = hasValidTwilioCredentials
  ? twilio(config.accountSid, config.authToken)
  : null;
const missedCallStatuses = new Set(["no-answer", "busy", "failed", "canceled"]);
const xmlAcknowledgement = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: isProduction ? "1h" : 0
}));

function verifyTwilioRequest(req, res, next) {
  const signature = req.get("X-Twilio-Signature");
  const remoteAddress = req.socket.remoteAddress || "";
  const isLoopback = remoteAddress === "::1"
    || remoteAddress === "127.0.0.1"
    || remoteAddress.startsWith("::ffff:127.");
  const isLocalHostname = ["localhost", "127.0.0.1", "::1"].includes(req.hostname);
  const isLocalUnsignedRequest = !isProduction
    && isLoopback
    && !req.get("CF-Ray")
    && (isLocalHostname || explicitLocalTestMode);

  if (isLocalUnsignedRequest) {
    console.warn("Twilio signature validation bypassed for a loopback development request.");
    return next();
  }

  if (!config.authToken) {
    console.error("Cannot validate Twilio signature: TWILIO_AUTH_TOKEN is not configured.");
    return res.status(503).send("Twilio webhook verification is not configured");
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.originalUrl, config.publicBaseUrl).toString();
  } catch (error) {
    console.error(`Could not construct webhook URL for signature validation: ${error.message}`);
    return res.status(400).send("Invalid webhook URL");
  }
  const valid = signature && twilio.validateRequest(
    config.authToken,
    signature,
    requestUrl,
    req.body
  );

  if (!valid) {
    console.warn("Rejected webhook with an invalid or missing Twilio signature.");
    return res.status(403).send("Forbidden");
  }

  next();
}

function maskPhoneNumber(phone) {
  return phone.length > 4 ? `${"*".repeat(phone.length - 4)}${phone.slice(-4)}` : "****";
}

function logTwilioError(event, error) {
  console.error(JSON.stringify({
    event,
    message: error.message,
    code: error.code || null,
    status: error.status || null
  }));
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/*
 * Configure the Twilio number's Voice Status Callback URL as:
 *   https://<your-public-host>/voice-webhook
 * Select call status events that include no-answer, busy, failed, and canceled.
 * Do not use this as the live Voice URL: Twilio must report the final call status
 * before this handler can know the call was missed.
 */
app.post("/voice-webhook", verifyTwilioRequest, asyncRoute(async (req, res) => {
  const callerNumber = String(req.body.From || "").trim();
  const calledNumber = String(req.body.To || "").trim();
  const callStatus = String(req.body.CallStatus || "").trim().toLowerCase();

  if (!callerNumber || !calledNumber || !callStatus) {
    console.warn(JSON.stringify({
      event: "invalid_voice_webhook",
      hasFrom: Boolean(callerNumber),
      hasTo: Boolean(calledNumber),
      hasCallStatus: Boolean(callStatus)
    }));
    return res.status(400).send("From, To, and CallStatus are required");
  }

  console.info(JSON.stringify({
    event: "voice_webhook_received",
    caller: validPhoneNumber(callerNumber) ? maskPhoneNumber(callerNumber) : "invalid",
    called: validPhoneNumber(calledNumber) ? maskPhoneNumber(calledNumber) : "invalid",
    status: callStatus,
    callSid: req.body.CallSid || null
  }));

  if (!validPhoneNumber(callerNumber) || !validPhoneNumber(calledNumber)) {
    console.warn(JSON.stringify({
      event: "invalid_voice_webhook_phone_number",
      callSid: req.body.CallSid || null
    }));
    return res.status(400).send("From and To must be valid E.164 phone numbers");
  }

  if (!missedCallStatuses.has(callStatus)) {
    console.info(JSON.stringify({
      event: "call_status_ignored",
      callSid: req.body.CallSid || null,
      status: callStatus
    }));
    return res.status(200).send("Call status received; no recovery needed");
  }

  if (config.twilioPhoneNumber && calledNumber !== config.twilioPhoneNumber) {
    console.warn(JSON.stringify({
      event: "missed_call_for_unconfigured_number",
      callSid: req.body.CallSid || null,
      calledNumber: calledNumber ? maskPhoneNumber(calledNumber) : null
    }));
    return res.status(200).send("Call received for an unconfigured number");
  }

  console.info(JSON.stringify({
    event: "missed_call_recovery_started",
    callSid: req.body.CallSid || null,
    caller: maskPhoneNumber(callerNumber),
    status: callStatus
  }));

  const lead = db.upsertMissedCall(callerNumber);
  console.info(JSON.stringify({
    event: "lead_upserted",
    leadId: lead.id,
    customer: maskPhoneNumber(lead.customer_phone),
    status: lead.status,
    updatedAt: lead.updated_at
  }));

  if (!twilioClient) {
    if (isProduction) {
      console.error("Cannot send recovery SMS: Twilio credentials and phone numbers are not fully configured.");
      return res.status(503).send("SMS delivery is not configured");
    }
    console.log(JSON.stringify({
      event: "missed_call_text_simulated",
      caller: maskPhoneNumber(callerNumber),
      company: config.companyName
    }));
    return res.status(200).send("Local test passed; SMS was simulated because Twilio is not configured");
  }

  const message = `Hi! This is Relay Automation on behalf of ${config.companyName}. We missed your call while out on a service job. Are you experiencing an urgent heating or cooling issue today? (Reply with your issue or ZIP) Reply STOP to opt out.`;

  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: config.twilioPhoneNumber,
      to: callerNumber
    });
    console.info(JSON.stringify({
      event: "missed_call_text_sent",
      callSid: req.body.CallSid || null,
      messageSid: result.sid,
      caller: maskPhoneNumber(callerNumber),
      status: callStatus
    }));
    return res.status(200).send("Missed-call recovery SMS sent");
  } catch (error) {
    logTwilioError("missed_call_text_failed", error);
    throw error;
  }
}));

/*
 * Set the Twilio number's incoming-message webhook to:
 *   https://<your-public-host>/sms-webhook
 * Twilio's signature check prevents arbitrary callers from triggering dispatcher texts.
 */
app.post("/sms-webhook", verifyTwilioRequest, asyncRoute(async (req, res) => {
  const customerNumber = req.body.From;
  const customerMessage = String(req.body.Body || "").trim();

  if (!customerNumber || !/^\+[1-9]\d{7,14}$/.test(customerNumber) || !customerMessage) {
    return res.status(400).send("Missing or invalid message details");
  }

  // Twilio supplies OptOutType when Advanced Opt-Out is configured on the number.
  if (req.body.OptOutType) {
    console.info(JSON.stringify({
      event: "customer_opt_out",
      type: req.body.OptOutType,
      customer: maskPhoneNumber(customerNumber)
    }));
    return res.type("text/xml").send(xmlAcknowledgement);
  }

  const safeLogText = customerMessage.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  console.info(JSON.stringify({
    event: "customer_sms_received",
    customer: maskPhoneNumber(customerNumber),
    message: safeLogText
  }));

  const leadUpdate = db.markLeadReplied(customerNumber, customerMessage);
  if (leadUpdate.changes > 0) {
    console.info(JSON.stringify({
      event: "lead_updated",
      customer: maskPhoneNumber(customerNumber),
      status: "replied",
      issueLength: customerMessage.length
    }));
  } else {
    console.warn(JSON.stringify({
      event: "reply_without_existing_lead",
      customer: maskPhoneNumber(customerNumber)
    }));
  }

  if (!twilioClient) {
    if (isProduction) {
      console.error("Cannot forward customer reply: Twilio credentials and phone numbers are not fully configured.");
      return res.status(503).send("SMS delivery is not configured");
    }
    console.log(JSON.stringify({
      event: "dispatcher_alert_simulated",
      customer: maskPhoneNumber(customerNumber),
      dispatcherConfigured: validPhoneNumber(config.dispatcherPhoneNumber)
    }));
    return res.type("text/xml").status(200).send(xmlAcknowledgement);
  }

  const forwardedMessage = customerMessage.slice(0, 1200);
  const alert = `🚨 New Missed-Call Lead! From: ${customerNumber}. Message: ${forwardedMessage}. Call them back immediately!`;

  try {
    const result = await twilioClient.messages.create({
      body: alert,
      from: config.twilioPhoneNumber,
      to: config.dispatcherPhoneNumber
    });
    console.info(JSON.stringify({
      event: "dispatcher_alert_sent",
      messageSid: result.sid,
      customer: maskPhoneNumber(customerNumber),
      dispatcher: maskPhoneNumber(config.dispatcherPhoneNumber)
    }));
    return res.type("text/xml").send(xmlAcknowledgement);
  } catch (error) {
    logTwilioError("dispatcher_alert_failed", error);
    throw error;
  }
}));

app.get("/leads", (req, res) => {
  const remoteAddress = req.socket.remoteAddress || "";
  const isLoopback = remoteAddress === "::1"
    || remoteAddress === "127.0.0.1"
    || remoteAddress.startsWith("::ffff:127.");
  const isLocalRequest = !isProduction
    && isLoopback
    && ["localhost", "127.0.0.1", "::1"].includes(req.hostname)
    && !req.get("CF-Ray");

  if (!isLocalRequest) {
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

app.get("/healthz", (_req, res) => {
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
  console.info(`Relay Automation webhook server listening on port ${config.port}.`);
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