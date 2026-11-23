"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const {
  parseCsv,
  parseXlsx,
  normalizeSlackWebhookUrl,
  sendSlackWebhook,
  suggestCsvHeaderMapping,
  testCredentialConnection,
  validateCredentialProvider,
  validateCsvRows,
  validateCsvSchema
} = require("../phase-three-capabilities");

const schema = [
  { column_name: "Email", data_type: "email", required: true, regex: "" },
  { column_name: "Start Date", data_type: "iso_date", required: true, regex: "" },
  { column_name: "Amount", data_type: "currency", required: false, regex: "" }
];

test("CSV parser handles quoted commas, escaped quotes, and embedded newlines", () => {
  const parsed = parseCsv('Email,Start Date,Amount\r\n"person@example.com","2026-11-23","$1,200.00"\r\n"second@example.com","2026-11-24","say ""hello"""\r\n');
  assert.deepEqual(parsed.structureErrors, []);
  assert.deepEqual(parsed.headers, ["Email", "Start Date", "Amount"]);
  assert.deepEqual(parsed.rows[0].cells, ["person@example.com", "2026-11-23", "$1,200.00"]);
  assert.equal(parsed.rows[1].cells[2], 'say "hello"');
});

test("CSV parser reports malformed rows and unclosed quotes", () => {
  const malformedRows = parseCsv("Email,Date\nperson@example.com,2026-11-23,extra\n");
  assert.match(malformedRows.structureErrors[0].message, /Expected 2 columns/);
  const malformedQuotes = parseCsv('Email,Date\n"unfinished,2026-11-23');
  assert.match(malformedQuotes.structureErrors[0].message, /not closed/);
});

test("XLSX parser reads the first worksheet and rejects formula cells", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Data");
  worksheet.addRow(["Email", "Start Date", "Amount"]);
  worksheet.addRow(["person@example.com", "2026-11-23", 1200.5]);
  const parsed = await parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.deepEqual(parsed.structureErrors, []);
  assert.deepEqual(parsed.headers, ["Email", "Start Date", "Amount"]);
  assert.deepEqual(parsed.rows[0].cells, ["person@example.com", "2026-11-23", "1200.5"]);

  worksheet.getCell("A3").value = { formula: "1+1", result: 2 };
  const formulaFile = Buffer.from(await workbook.xlsx.writeBuffer());
  const rejected = await parseXlsx(formulaFile);
  assert.match(rejected.structureErrors[0].message, /Formula cells are not allowed/);
});

test("schema validation rejects duplicate columns and unsafe regular expressions", () => {
  assert.equal(validateCsvSchema([
    ...schema,
    { column_name: " email ", data_type: "string", required: false, regex: "" }
  ]), null);
  assert.equal(validateCsvSchema([
    { column_name: "Value", data_type: "string", required: false, regex: "^(a+)+$" }
  ]), null);
});

test("header mapping suggests unambiguous near matches and row validation reports exact cells", () => {
  const parsed = parseCsv("E-mail,StartDate,Amount\nnot-an-email,2026-02-30,$12\n");
  const mapping = suggestCsvHeaderMapping(parsed.headers, schema);
  assert.deepEqual(mapping, { Email: "E-mail", "Start Date": "StartDate", Amount: "Amount" });
  const result = validateCsvRows(parsed, schema, mapping);
  assert.equal(result.valid, false);
  assert.equal(result.errorCount, 2);
  assert.deepEqual(result.errors.map(({ row, column }) => ({ row, column })), [
    { row: 2, column: "Email" },
    { row: 2, column: "Start Date" }
  ]);
});

test("required fields need explicit mappings; optional fields may remain unmapped", () => {
  const parsed = parseCsv('Email,Start Date,Amount\nperson@example.com,2026-11-23,"$1,200.00"\n');
  const result = validateCsvRows(parsed, schema, { Email: "Email", "Start Date": "Start Date", Amount: "Amount" });
  assert.equal(result.valid, true);
  assert.equal(result.errorCount, 0);
});

test("CSV feature is registered in the database and Cloudflare migration bundles", () => {
  const { readFileSync } = require("node:fs");
  const path = require("node:path");
  const migration = readFileSync(path.join(__dirname, "..", "migrations", "016_phase3_csv_validation.sql"), "utf8");
  const worker = readFileSync(path.join(__dirname, "..", "cloudflare-worker.mjs"), "utf8");
  assert.match(migration, /csv_schema_json JSONB/);
  assert.match(migration, /validation_schema_hash/);
  assert.match(worker, /016_phase3_csv_validation\.sql/);
});

test("credential verification uses fixed provider URLs, never follows redirects, and rejects unknown providers", async () => {
  let calls = 0;
  const verified = await testCredentialConnection("slack", "xoxb-fake-token", async (url, options) => {
    calls += 1;
    assert.equal(url, "https://slack.com/api/auth.test");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer xoxb-fake-token");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(verified.success, true);
  assert.equal(verified.status, 200);
  assert.equal(calls, 1);
  assert.equal(validateCredentialProvider("https://example.com"), null);

  const redirected = await testCredentialConnection("hubspot", "fake-hubspot-token", async (url, options) => {
    assert.equal(url, "https://api.hubapi.com/crm/v3/objects/companies?limit=1");
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } });
  });
  assert.equal(redirected.success, false);
  assert.equal(redirected.status, 302);
  assert.doesNotMatch(JSON.stringify(redirected), /fake-hubspot-token/);
});

test("Slack webhooks are restricted to the fixed HTTPS endpoint and do not follow redirects", async () => {
  const webhook = "https://hooks.slack.com/services/T123/B456/dummyToken123";
  assert.equal(normalizeSlackWebhookUrl(webhook).href, webhook);
  assert.equal(normalizeSlackWebhookUrl("http://hooks.slack.com/services/T123/B456/dummy-token"), null);
  assert.equal(normalizeSlackWebhookUrl("https://hooks.slack.com.attacker.example/services/T123/B456/dummy-token"), null);
  assert.equal(normalizeSlackWebhookUrl(`${webhook}?next=https://example.com`), null);

  let calls = 0;
  const delivered = await sendSlackWebhook(webhook, "Relay test", async (url, options) => {
    calls += 1;
    assert.equal(url.href, webhook);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(JSON.parse(options.body), { text: "Relay test" });
    return new Response("ok", { status: 200 });
  });
  assert.deepEqual(delivered, { success: true, status: 200, message: "Slack message delivered." });
  assert.equal(calls, 1);

  const rejected = await sendSlackWebhook("https://example.com/webhook", "Relay test", async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.status, 400);
  assert.equal(calls, 1);
});

test("Slack webhook delivery treats redirects and provider failures as failures", async () => {
  const webhook = "https://hooks.slack.com/services/T123/B456/dummyToken123";
  const redirected = await sendSlackWebhook(webhook, "Relay test", async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 307, headers: { Location: "http://127.0.0.1/" } });
  });
  assert.equal(redirected.success, false);
  assert.equal(redirected.status, 307);

  const unavailable = await sendSlackWebhook(webhook, "Relay test", async () => {
    throw new Error("network failure");
  });
  assert.equal(unavailable.success, false);
  assert.equal(unavailable.status, 502);
  assert.doesNotMatch(JSON.stringify(unavailable), /dummyToken123/);
});
