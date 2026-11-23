"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
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
} = require("../enterprise-integrations");

test("enterprise integration migration persists mappings and internal issue links without plaintext token fields", () => {
  const migration = readFileSync(
    path.join(__dirname, "..", "migrations", "018_enterprise_integrations.sql"),
    "utf8"
  );
  assert.match(migration, /product_salesforce_sku_template_mappings/);
  assert.match(migration, /product_salesforce_imports/);
  assert.match(migration, /product_external_issue_links/);
  assert.match(migration, /provider IN \('jira', 'linear'\)/);
  assert.match(migration, /configuration_json JSONB NOT NULL/);
  assert.doesNotMatch(migration, /api_token TEXT|access_token TEXT/i);
});

test("Salesforce and Jira hosts are restricted to their trusted HTTPS domains", () => {
  assert.equal(normalizeSalesforceLoginUrl("https://test.salesforce.com"), "https://test.salesforce.com");
  assert.equal(normalizeSalesforceLoginUrl("https://evil.test.salesforce.com"), null);
  assert.equal(normalizeSalesforceLoginUrl("https://login.salesforce.com.attacker.test"), null);
  assert.equal(normalizeSalesforceInstanceUrl("https://tenant--sandbox.sandbox.my.salesforce.com"),
    "https://tenant--sandbox.sandbox.my.salesforce.com");
  assert.equal(normalizeSalesforceInstanceUrl("http://tenant.my.salesforce.com"), null);
  assert.equal(normalizeJiraBaseUrl("https://company.atlassian.net/"), "https://company.atlassian.net");
  assert.equal(normalizeJiraBaseUrl("https://company.atlassian.net.attacker.test"), null);
  assert.equal(normalizeJiraBaseUrl("http://company.atlassian.net"), null);
  assert.equal(normalizeJiraBaseUrl("https://company.atlassian.net/proxy"), null);
});

test("Salesforce SKU templates compose ordered tasks and remap prerequisites", () => {
  const composition = composeSalesforceTemplate(
    ["ONBOARD", "SECURITY", "ONBOARD"],
    [
      { sku: "ONBOARD", template_id: 3 },
      { sku: "SECURITY", template_id: 8 }
    ],
    [
      {
        id: 3,
        name: "Onboarding",
        steps_json: JSON.stringify([
          { title: "Kickoff", position: 1 },
          { title: "Configure", position: 2, dependsOnPositions: [1] }
        ])
      },
      {
        id: 8,
        name: "Security",
        steps_json: JSON.stringify([{ title: "Security review", position: 1 }])
      }
    ]
  );
  const tasks = JSON.parse(composition.template.steps_json);
  assert.deepEqual(composition.templateIds, [3, 8]);
  assert.deepEqual(tasks.map((step) => step.position), [1, 2, 3]);
  assert.deepEqual(tasks[1].dependsOnPositions, [1]);
  assert.deepEqual(tasks[2].dependsOnPositions, []);
  assert.throws(() => composeSalesforceTemplate(["UNKNOWN"], [], []), /No Relay template is mapped/);
  assert.throws(() => composeSalesforceTemplate(["BAD"], [{ sku: "BAD", template_id: 1 }], [
    { id: 1, name: "Bad template", steps_json: JSON.stringify([{ title: "Task", position: 1, dependsOnPositions: [2] }]) }
  ]), /invalid task prerequisite/);
});

test("Jira connection test uses only the configured Atlassian tenant without redirects", async () => {
  let requestUrl = "";
  let requestOptions;
  const result = await testJiraConnection({
    baseUrl: "https://relay-team.atlassian.net",
    email: "ops@example.com",
    projectKey: "OPS",
    token: "secret-token"
  }, async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return { ok: true, json: async () => ({ id: "10001", key: "OPS", name: "Operations" }) };
  });
  assert.equal(requestUrl, "https://relay-team.atlassian.net/rest/api/3/project/OPS");
  assert.equal(requestOptions.redirect, "error");
  assert.equal(requestOptions.headers.Authorization, `Basic ${Buffer.from("ops@example.com:secret-token").toString("base64")}`);
  assert.equal(result.projectName, "Operations");
  await assert.rejects(testJiraConnection({
    baseUrl: "https://127.0.0.1",
    email: "ops@example.com",
    projectKey: "OPS",
    token: "secret-token"
  }, async () => {
    throw new Error("Unsafe URL reached fetch.");
  }), /Enter a Jira Cloud site/);
});

test("Jira issue creation includes approved customer context but not financial data", async () => {
  let body;
  const issue = await createJiraIssue({
    config: {
      baseUrl: "https://relay-team.atlassian.net",
      email: "ops@example.com",
      projectKey: "OPS",
      issueType: "Task"
    },
    token: "secret-token",
    title: "Configure SSO",
    description: "Set up SAML metadata.",
    customerName: "Example Corp",
    goLiveDate: "2026-12-01",
    taskDueAt: "2026-11-25"
  }, async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: "20001", key: "OPS-45" }) };
  });
  assert.equal(issue.url, "https://relay-team.atlassian.net/browse/OPS-45");
  assert.match(JSON.stringify(body), /Example Corp/);
  assert.match(JSON.stringify(body), /2026-12-01/);
  assert.doesNotMatch(JSON.stringify(body), /cost rate|billable rate|budget|margin/i);
});

test("Jira status polling recognizes only Done-category issues", async () => {
  const result = await getJiraIssueStatus({
    config: { baseUrl: "https://relay-team.atlassian.net", email: "ops@example.com" },
    token: "secret-token",
    issueKey: "OPS-45"
  }, async () => ({
    ok: true,
    json: async () => ({ fields: { status: { statusCategory: { key: "done" } } } })
  }));
  assert.deepEqual(result, { status: "done", isDone: true });
});

test("Linear connection and issue synchronization use the fixed GraphQL API", async () => {
  const teamId = "11111111-2222-4333-8444-555555555555";
  const queries = [];
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), "https://api.linear.app/graphql");
    assert.equal(options.redirect, "error");
    queries.push(JSON.parse(options.body));
    if (queries.length === 1) {
      return { ok: true, json: async () => ({ data: { viewer: { id: "user-1" }, team: { id: teamId, name: "Eng" } } }) };
    }
    return {
      ok: true,
      json: async () => ({ data: { issueCreate: { success: true, issue: {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        identifier: "ENG-12",
        url: "https://linear.app/acme/issue/ENG-12"
      } } } })
    };
  };
  const verified = await testLinearConnection({ token: "secret-key", teamId }, fetchImpl);
  assert.equal(verified.teamName, "Eng");
  const issue = await createLinearIssue({
    config: { teamId },
    token: "secret-key",
    title: "Investigate launch blocker",
    description: "Client API returns 401.",
    customerName: "Example Corp",
    goLiveDate: "2026-12-01",
    taskDueAt: ""
  }, fetchImpl);
  assert.equal(issue.key, "ENG-12");
  assert.equal(issue.url, "https://linear.app/acme/issue/ENG-12");
  assert.match(JSON.stringify(queries[1]), /Example Corp/);
  assert.doesNotMatch(JSON.stringify(queries[1]), /internal_cost_rate|client_bill_rate|budget_limit/i);
  await assert.rejects(testLinearConnection({ token: "secret-key", teamId: "not-a-team" }), /valid team ID/);
});

test("Linear task completion requires a completed state", async () => {
  const result = await getLinearIssueStatus({
    token: "secret-key",
    issueId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  }, async () => ({
    ok: true,
    json: async () => ({ data: { issue: { state: { type: "completed" } } } })
  }));
  assert.deepEqual(result, { status: "completed", isDone: true });
});
