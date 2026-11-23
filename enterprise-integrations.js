"use strict";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const SALESFORCE_API_VERSION = "v61.0";

function normalizeSalesforceLoginUrl(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "https://login.salesforce.com";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !["login.salesforce.com", "test.salesforce.com"].includes(url.hostname)
      || url.port || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")
      || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeSalesforceInstanceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)+salesforce\.com$/i.test(url.hostname)
      || url.port || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")
      || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeJiraBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname)
      || url.port || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")
      || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function composeSalesforceTemplate(skus, mappings, templates) {
  if (!Array.isArray(skus) || !skus.length) {
    throw new Error("The Closed Won opportunity has no product SKUs to map.");
  }
  const mappingBySku = new Map(mappings.map((mapping) => [mapping.sku, Number(mapping.template_id)]));
  const templatesById = new Map(templates.map((template) => [Number(template.id), template]));
  const templateIds = [];
  for (const sku of new Set(skus)) {
    const templateId = mappingBySku.get(sku);
    if (!templateId) throw new Error(`No Relay template is mapped to Salesforce SKU ${sku}.`);
    if (!templatesById.has(templateId)) throw new Error(`The Relay template mapped to Salesforce SKU ${sku} is unavailable.`);
    if (!templateIds.includes(templateId)) templateIds.push(templateId);
  }

  const steps = [];
  for (const templateId of templateIds) {
    const template = templatesById.get(templateId);
    let sourceSteps;
    try {
      sourceSteps = JSON.parse(template.steps_json);
    } catch {
      throw new Error(`Relay template ${template.name} contains invalid task data.`);
    }
    if (!Array.isArray(sourceSteps) || !sourceSteps.length) {
      throw new Error(`Relay template ${template.name} has no saved tasks.`);
    }
    const positionOffset = steps.length;
    const sourcePositions = new Map();
    sourceSteps.forEach((step, index) => {
      const sourcePosition = Number.isSafeInteger(step.position) ? step.position : index + 1;
      if (sourcePositions.has(sourcePosition)) {
        throw new Error(`Relay template ${template.name} has duplicate task positions.`);
      }
      sourcePositions.set(sourcePosition, positionOffset + index + 1);
    });
    sourceSteps.forEach((step, index) => {
      const position = positionOffset + index + 1;
      const dependencies = step.dependsOnPositions || [];
      if (!Array.isArray(dependencies) || dependencies.some((dependency) => !sourcePositions.has(dependency))) {
        throw new Error(`Relay template ${template.name} has an invalid task prerequisite.`);
      }
      steps.push({
        ...step,
        position,
        dependsOnPositions: dependencies.map((dependency) => sourcePositions.get(dependency))
      });
    });
  }
  const primaryTemplate = templatesById.get(templateIds[0]);
  return {
    templateIds,
    template: {
      id: primaryTemplate.id,
      name: templateIds.map((id) => templatesById.get(id).name).join(" + "),
      steps_json: JSON.stringify(steps)
    }
  };
}

async function fetchJson(url, options, provider, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Error(`${provider} could not be reached. Check the connection and try again.`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}.`);
  return body;
}

function jiraAuthorization(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

async function testJiraConnection({ baseUrl, email, token, projectKey }, fetchImpl = fetch) {
  const normalizedBaseUrl = normalizeJiraBaseUrl(baseUrl);
  if (!normalizedBaseUrl || !email || !token) throw new Error("Enter a Jira Cloud site, account email, and API token.");
  const normalizedProjectKey = typeof projectKey === "string" ? projectKey.trim() : "";
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(normalizedProjectKey)) throw new Error("Enter a valid Jira project key.");
  const result = await fetchJson(`${normalizedBaseUrl}/rest/api/3/project/${encodeURIComponent(normalizedProjectKey)}`, {
    headers: { Authorization: jiraAuthorization(email, token), Accept: "application/json" }
  }, "Jira", fetchImpl);
  if (typeof result.key !== "string" || result.key.toUpperCase() !== normalizedProjectKey.toUpperCase()) {
    throw new Error("Jira did not return the configured project.");
  }
  return {
    baseUrl: normalizedBaseUrl,
    projectId: String(result.id),
    projectKey: result.key,
    projectName: String(result.name || result.key)
  };
}

async function createJiraIssue({ config, token, title, description, customerName, goLiveDate, taskDueAt }, fetchImpl = fetch) {
  const baseUrl = normalizeJiraBaseUrl(config.baseUrl);
  if (!baseUrl) throw new Error("The saved Jira site URL is invalid.");
  const context = [
    `Customer implementation: ${customerName}`,
    `Projected go-live date: ${goLiveDate || "Not set"}`,
    `Task due date: ${taskDueAt || "Not set"}`,
    "",
    description || "No task description provided."
  ].join("\n").slice(0, 12000);
  const response = await fetchJson(`${baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: jiraAuthorization(config.email, token),
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fields: {
        project: { key: config.projectKey },
        issuetype: { name: config.issueType },
        summary: title.slice(0, 250),
        description: {
          type: "doc",
          version: 1,
          content: context.split("\n").map((text) => ({
            type: "paragraph",
            content: text ? [{ type: "text", text }] : []
          }))
        }
      }
    })
  }, "Jira", fetchImpl);
  if (!response.key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(response.key)) {
    throw new Error("Jira did not return a valid issue key.");
  }
  return {
    id: String(response.id || response.key),
    key: response.key,
    url: `${baseUrl}/browse/${encodeURIComponent(response.key)}`
  };
}

async function getJiraIssueStatus({ config, token, issueKey }, fetchImpl = fetch) {
  const baseUrl = normalizeJiraBaseUrl(config.baseUrl);
  if (!baseUrl || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) throw new Error("The saved Jira issue link is invalid.");
  const result = await fetchJson(
    `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`,
    { headers: { Authorization: jiraAuthorization(config.email, token), Accept: "application/json" } },
    "Jira",
    fetchImpl
  );
  return {
    status: String(result.fields?.status?.statusCategory?.key || "unknown"),
    isDone: result.fields?.status?.statusCategory?.key === "done"
  };
}

async function linearRequest(token, query, variables, fetchImpl = fetch) {
  const result = await fetchJson(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  }, "Linear", fetchImpl);
  if (Array.isArray(result.errors) && result.errors.length) {
    throw new Error("Linear rejected the request. Check the saved token and team access.");
  }
  return result.data || {};
}

async function testLinearConnection({ token, teamId }, fetchImpl = fetch) {
  if (!token || typeof teamId !== "string" || !/^[0-9a-f-]{36}$/i.test(teamId)) {
    throw new Error("Enter a Linear API key and a valid team ID.");
  }
  const data = await linearRequest(token,
    "query RelayTeamCheck($teamId: String!) { viewer { id name } team(id: $teamId) { id name } }",
    { teamId }, fetchImpl);
  if (!data.viewer?.id || !data.team?.id) throw new Error("The Linear key cannot access that team.");
  return { externalAccountId: String(data.viewer.id), teamId: String(data.team.id), teamName: String(data.team.name || "") };
}

async function createLinearIssue({ config, token, title, description, customerName, goLiveDate, taskDueAt }, fetchImpl = fetch) {
  const context = [
    `Customer implementation: ${customerName}`,
    `Projected go-live date: ${goLiveDate || "Not set"}`,
    `Task due date: ${taskDueAt || "Not set"}`,
    "",
    description || "No task description provided."
  ].join("\n").slice(0, 12000);
  const data = await linearRequest(token,
    "mutation RelayCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
    { input: { teamId: config.teamId, title: title.slice(0, 250), description: context } }, fetchImpl);
  const issue = data.issueCreate?.issue;
  if (!data.issueCreate?.success || !issue?.id || !/^[A-Z0-9]+-\d+$/.test(issue.identifier || "")) {
    throw new Error("Linear did not create an issue.");
  }
  let url;
  try {
    const parsedUrl = new URL(issue.url);
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "linear.app") throw new Error();
    url = parsedUrl.toString();
  } catch {
    throw new Error("Linear returned an invalid issue URL.");
  }
  return { id: String(issue.id), key: issue.identifier, url };
}

async function getLinearIssueStatus({ token, issueId }, fetchImpl = fetch) {
  if (!/^[0-9a-f-]{36}$/i.test(issueId)) throw new Error("The saved Linear issue link is invalid.");
  const data = await linearRequest(token,
    "query RelayIssueStatus($issueId: String!) { issue(id: $issueId) { id state { type } } }",
    { issueId }, fetchImpl);
  const status = String(data.issue?.state?.type || "unknown");
  return { status, isDone: status === "completed" };
}

module.exports = {
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
};
