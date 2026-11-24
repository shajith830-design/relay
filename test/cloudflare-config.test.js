"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { validateCloudflareConfig } = require("../scripts/validate-cloudflare-config");

const configPath = path.join(__dirname, "..", "wrangler.jsonc");
const configuration = readFileSync(configPath, "utf8");

function withHyperdriveId(config, id) {
  return config.replace(
    /("binding"\s*:\s*"HYPERDRIVE"\s*,\s*"id"\s*:\s*")[^"]+(")/,
    `$1${id}$2`
  );
}

test("Cloudflare configuration routes production and backend requests through Relay", () => {
  assert.doesNotThrow(() => validateCloudflareConfig(configuration));
  assert.match(configuration, /"crons"\s*:\s*\[\s*"\*\/5 \* \* \* \*"\s*,\s*"0 0 \* \* \*"\s*\]/);
  const worker = readFileSync(path.join(__dirname, "..", "cloudflare-worker.mjs"), "utf8");
  assert.match(worker, /006_customer_portal_notifications_integrations\.sql/);
  assert.match(worker, /007_customer_contact_escalation\.sql/);
  assert.match(worker, /008_client_onboarding_collaboration\.sql/);
  assert.match(worker, /009_launch_readiness\.sql/);
  assert.match(worker, /010_onboarding_gap_resolution\.sql/);
  assert.match(worker, /015_enterprise_roles\.sql/);
  assert.match(worker, /"INQUIRY_NOTIFICATION_EMAIL"/);
  assert.match(worker, /016_phase3_csv_validation\.sql/);
  assert.match(worker, /017_enterprise_operations\.sql/);
  assert.match(worker, /018_enterprise_integrations\.sql/);
  assert.match(worker, /019_stage_gated_approvals\.sql/);
  assert.match(worker, /"SALESFORCE_CLIENT_SECRET"/);
  assert.match(worker, /salesforceImportsCreated/);
  assert.match(worker, /scheduled_job_completed/);
  assert.match(worker, /scheduled_job_execution_failed/);
});

test("Cloudflare deployment validation rejects the Hyperdrive placeholder", () => {
  const withPlaceholder = withHyperdriveId(configuration, "REPLACE_WITH_CLOUDFLARE_HYPERDRIVE_ID");
  assert.throws(
    () => validateCloudflareConfig(withPlaceholder),
    /real 32-character Cloudflare Hyperdrive configuration ID/
  );
});

test("Cloudflare deployment validation rejects a missing production route", () => {
  const withoutRoute = configuration
    .replace('"pattern": "relayautomation.tech/*",', '"pattern": "example.com/*",');

  assert.throws(
    () => validateCloudflareConfig(withoutRoute),
    /relayautomation\.tech\/\* production route/
  );
});

test("Cloudflare deployment validation requires backend routes to run worker-first", () => {
  const withoutApi = configuration
    .replace(/^\s*"\/api\/\*",\s*\r?\n/m, "");

  assert.throws(
    () => validateCloudflareConfig(withoutApi),
    /Configure \/api\/\* to run through the Worker/
  );
});

test("static HTML product alias is not intercepted by the Worker", () => {
  const workerFirst = configuration.match(/"run_worker_first"\s*:\s*\[([^\]]*)\]/s)?.[1] || "";
  assert.doesNotMatch(workerFirst, /"\/product"/);
});
