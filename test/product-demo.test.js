"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const adapterSource = readFileSync(path.join(__dirname, "..", "public", "product-demo.js"), "utf8");

function makeDemoAdapter(storage = new Map(), { search = "?demo=workspace", hostname = "127.0.0.1" } = {}) {
  const window = {
    location: {
      search,
      hostname,
      origin: `https://${hostname}`
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    }
  };
  runInNewContext(adapterSource, { window, URLSearchParams, URL });
  return { adapter: window.relayWorkspaceDemo, storage };
}

test("public sample workspace requires an explicit demo query and uses only the local adapter", async () => {
  const regularPage = makeDemoAdapter(new Map(), { search: "", hostname: "relayautomation.tech" });
  assert.equal(regularPage.adapter, undefined);

  const publicDemo = makeDemoAdapter(new Map(), { hostname: "relayautomation.tech" });
  assert.ok(publicDemo.adapter);
  const response = await publicDemo.adapter.request("/api/product/me");
  assert.equal(response.workspace.name, "Northstar Demo Workspace");
});

test("sample workspace previews portfolio health, notification settings, and integration connections locally", async () => {
  const { adapter } = makeDemoAdapter();
  const workspace = await adapter.request("/api/product/workspace");
  const implementation = workspace.implementations.find((item) => item.id === 9040);

  assert.equal(implementation.blocked_steps, 1);
  assert.equal(implementation.overdue_steps, 1);
  assert.match(implementation.projected_completion, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(workspace.notificationSettings.email_enabled, false);

  const savedSettings = await adapter.request("/api/product/notifications", {
    method: "PATCH",
    body: { emailEnabled: true, reminderDaysBefore: 5 }
  });
  assert.deepEqual({ ...savedSettings }, { emailEnabled: true, reminderDaysBefore: 5 });
  assert.deepEqual(
    { ...((await adapter.request("/api/product/workspace")).notificationSettings) },
    { email_enabled: true, reminder_days_before: 5 }
  );
  await assert.rejects(adapter.request("/api/product/notifications", {
    method: "PATCH",
    body: { emailEnabled: true, reminderDaysBefore: 31 }
  }), /between 0 and 30/);

  const connection = await adapter.request("/api/product/integrations/hubspot/connect", {
    method: "POST",
    body: {}
  });
  assert.equal(connection.demoConnected, true);
  let integrations = (await adapter.request("/api/product/workspace")).integrations;
  assert.equal(integrations.length, 1);
  assert.equal(integrations[0].demo, true);
  await adapter.request("/api/product/integrations/hubspot", { method: "DELETE" });
  integrations = (await adapter.request("/api/product/workspace")).integrations;
  assert.equal(integrations.length, 0);
});

test("marketing pages expose the sample demo and disclose current product boundaries", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const homePage = readFileSync(path.join(publicDir, "index.html"), "utf8");
  const demoPage = readFileSync(path.join(publicDir, "demo.html"), "utf8");
  const solutionsPage = readFileSync(path.join(publicDir, "features-services.html"), "utf8");
  const aboutPage = readFileSync(path.join(publicDir, "about.html"), "utf8");
  const pricingPage = readFileSync(path.join(publicDir, "pricing.html"), "utf8");
  const sitemapXml = readFileSync(path.join(publicDir, "sitemap.xml"), "utf8");
  const favicon = readFileSync(path.join(publicDir, "relayautomation-favicon.png"));

  assert.match(homePage, /<link rel="icon" type="image\/png" href="\/relayautomation-favicon\.png">/);
  assert.doesNotMatch(homePage, /href="\/favicon\.(?:ico|png)/);
  assert.equal(favicon.readUInt32BE(16), 96);
  assert.equal(favicon.readUInt32BE(20), 96);
  assert.equal(favicon[25], 6);
  assert.match(sitemapXml, /<loc>https:\/\/relayautomation\.tech\/<\/loc>/);
  assert.match(sitemapXml, /<loc>https:\/\/relayautomation\.tech\/pricing\.html<\/loc>/);
  assert.doesNotMatch(sitemapXml, /dashboard\.html|customer\.html|relay-owner-console\.html/);
  assert.match(homePage, /product\.html\?demo=workspace/);
  assert.match(homePage, /Try the Sample Workspace/);
  assert.doesNotMatch(homePage, /No Login Required/i);
  assert.match(homePage, /<video controls playsinline/);
  assert.match(homePage, /relay-home-overview\.mp4/);
  assert.match(homePage, /relay-home-video-poster\.png/);
  assert.match(homePage, /Open the video directly/);
  assert.match(homePage, /relay-home-(?:readiness|ownership|customer|process)\.svg/);
  assert.doesNotMatch(homePage, /relay-preview-|sample workspace overview|real screens from Relay/i);
  for (const obsolete of [
    "relay-60-second-overview.mp4",
    "relay-preview-overview.png",
    "relay-preview-portfolio.png",
    "relay-preview-customer-portal.png",
    "relay-preview-process-map.png"
  ]) {
    assert.equal(existsSync(path.join(publicDir, "assets", obsolete)), false);
  }
  assert.match(homePage, /HubSpot/);
  assert.match(homePage, /Slack/);
  assert.match(homePage, /Built by the founder/);
  assert.match(homePage, /three months of Relay access/i);
  assert.ok(existsSync(path.join(publicDir, "assets", "relay-home-overview.mp4")));
  assert.ok(existsSync(path.join(publicDir, "assets", "relay-home-video-poster.png")));
  for (const illustration of ["readiness", "ownership", "customer", "process"]) {
    assert.ok(existsSync(path.join(publicDir, "assets", `relay-home-${illustration}.svg`)));
  }
  assert.doesNotMatch(homePage, /Plans from ₹2,999 per month/);
  assert.doesNotMatch(homePage, /Built for B2B SaaS implementation teams and the customers they guide from kickoff to launch/);
  assert.match(demoPage, /fictional data/i);
  assert.match(demoPage, /does not connect to your Relay account or backend/i);
  assert.match(solutionsPage, /Allow integrations for your workspace/i);
  assert.doesNotMatch([aboutPage, solutionsPage, pricingPage].join("\n"), /Salesforce|Microsoft Teams|Jira|Linear|Asana/i);
  assert.match([homePage, solutionsPage].join("\n"), /portfolio health/i);
  assert.match([homePage, solutionsPage].join("\n"), /CSV/i);
  assert.match([homePage, solutionsPage].join("\n"), /daily reminders/i);
  assert.match(solutionsPage, /private portal/i);
  assert.match(pricingPage, /Integration connections/i);
  assert.match(aboutPage, /does not currently publish customer case studies/i);
  assert.match(pricingPage, /₹2,999/);
  assert.match(pricingPage, /₹3,999/);
  assert.match(pricingPage, /5 active implementations/);
  assert.match(pricingPage, /template revision history and restore/);
  assert.match(pricingPage, /before applicable taxes/i);
  assert.match(pricingPage, /class="plan-grid"/);
  assert.match(readFileSync(path.join(publicDir, "relay-motion.js"), "utf8"), /\.plan-card/);
});

test("workspace views are siblings so each navigation target can render independently", () => {
  const productHtml = readFileSync(path.join(__dirname, "..", "public", "product.html"), "utf8");
  const sectionTags = [...productHtml.matchAll(/<\/?section\b[^>]*>/g)];
  const sections = [];

  for (const [tag] of sectionTags) {
    if (tag.startsWith("</")) {
      sections.pop();
      continue;
    }
    const viewId = tag.match(/id="(view-[^"]+)"/)?.[1];
    if (viewId) {
      assert.equal(sections.some(Boolean), false, `${viewId} must not be nested inside another workspace view`);
    }
    sections.push(viewId || null);
  }
});

test("local customer links work across tabs, validate submissions, and rotate", async () => {
  const { adapter, storage } = makeDemoAdapter();
  const { customerPortalToken: firstToken } = await adapter.request(
    "/api/product/implementations/9040/customer-link",
    { method: "POST" }
  );
  const firstPage = makeDemoAdapter(storage).adapter;
  const portal = await firstPage.request(`/api/product/customer/${firstToken}`);

  assert.equal(portal.customerName, "Acme Example Co.");
  assert.equal(portal.requirements.find((item) => item.name === "Project contact email").required, true);
  assert.equal(portal.tasks.length, 2);
  assert.equal(portal.tasks[1].waiting, false);
  await assert.rejects(
    firstPage.request(`/api/product/customer/${firstToken}`, { method: "POST", body: { inputs: [] } }),
    /Required information is missing: Project contact email/
  );
  await assert.rejects(
    firstPage.request(`/api/product/customer/${firstToken}`, {
      method: "POST",
      body: { inputs: [{ requirementId: 9030, value: "not-an-email" }] }
    }),
    /Enter a valid email address/
  );
  await firstPage.request(`/api/product/customer/${firstToken}`, {
    method: "POST",
    body: { inputs: [{ requirementId: 9030, value: "client@example.test" }] }
  });
  await firstPage.request(`/api/product/customer/${firstToken}`, {
    method: "POST",
    body: { inputs: [], completedStepIds: [9042] }
  });

  const refreshedPortal = await makeDemoAdapter(storage).adapter.request(
    `/api/product/customer/${firstToken}`
  );
  assert.equal(refreshedPortal.requirements.find((item) => item.id === 9030).value, "client@example.test");
  assert.equal(refreshedPortal.tasks.find((item) => item.id === 9042).status, "done");
  assert.equal(refreshedPortal.progress, 100);
  await assert.rejects(
    firstPage.request(`/api/product/customer/${firstToken}`, {
      method: "POST",
      body: { inputs: [], completedStepIds: [9043] }
    }),
    /unavailable/
  );

  const { customerPortalToken: replacementToken } = await adapter.request(
    "/api/product/implementations/9040/customer-link",
    { method: "POST" }
  );
  assert.notEqual(replacementToken, firstToken);
  await assert.rejects(
    makeDemoAdapter(storage).adapter.request(`/api/product/customer/${firstToken}`),
    /no longer available/
  );
  assert.equal(
    (await makeDemoAdapter(storage).adapter.request(`/api/product/customer/${replacementToken}`)).customerName,
    "Acme Example Co."
  );
});

test("customer-visible tasks stay blocked until their prerequisite is complete", async () => {
  const { adapter } = makeDemoAdapter();
  const { customerPortalToken } = await adapter.request(
    "/api/product/implementations/9040/customer-link",
    { method: "POST" }
  );
  await adapter.request("/api/product/implementations/9040/steps/9043", {
    method: "PATCH",
    body: {
      status: "not_started",
      owner: "Implementation lead",
      assigneeUserId: 9001,
      customerVisible: true,
      dueAt: "",
      isBlocked: false
    }
  });

  let portal = await adapter.request(`/api/product/customer/${customerPortalToken}`);
  assert.equal(portal.tasks.find((task) => task.id === 9043).waiting, true);
  await assert.rejects(
    adapter.request(`/api/product/customer/${customerPortalToken}`, {
      method: "POST",
      body: { inputs: [], completedStepIds: [9043] }
    }),
    /prerequisite/
  );

  await adapter.request(`/api/product/customer/${customerPortalToken}`, {
    method: "POST",
    body: { inputs: [], completedStepIds: [9042] }
  });
  portal = await adapter.request(`/api/product/customer/${customerPortalToken}`);
  assert.equal(portal.tasks.find((task) => task.id === 9043).waiting, false);
  await adapter.request(`/api/product/customer/${customerPortalToken}`, {
    method: "POST",
    body: { inputs: [], completedStepIds: [9043] }
  });
  portal = await adapter.request(`/api/product/customer/${customerPortalToken}`);
  assert.equal(portal.tasks.find((task) => task.id === 9043).status, "done");
});

test("local process steps preserve customer visibility", async () => {
  const { adapter } = makeDemoAdapter();
  const { step } = await adapter.request("/api/product/processes/9010/steps", {
    method: "POST",
    body: {
      title: "Share launch checklist",
      description: "Review launch tasks with the customer.",
      owner: "Implementation lead",
      assigneeUserId: 9001,
      stage: "Launch",
      dueOffsetDays: 2,
      customerVisible: true,
      dependsOn: [9011]
    }
  });

  assert.equal(step.customer_visible, true);
  const { process } = await adapter.request("/api/product/processes/9010");
  assert.equal(process.steps.at(-1).customer_visible, true);
});
