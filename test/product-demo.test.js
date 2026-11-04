"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
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

test("marketing pages expose the sample demo and disclose current product boundaries", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const homePage = readFileSync(path.join(publicDir, "index.html"), "utf8");
  const demoPage = readFileSync(path.join(publicDir, "demo.html"), "utf8");
  const solutionsPage = readFileSync(path.join(publicDir, "features-services.html"), "utf8");
  const aboutPage = readFileSync(path.join(publicDir, "about.html"), "utf8");
  const pricingPage = readFileSync(path.join(publicDir, "pricing.html"), "utf8");

  assert.match(homePage, /product\.html\?demo=workspace/);
  assert.match(homePage, /Plans from ₹2,999 per month/);
  assert.match(demoPage, /fictional data/i);
  assert.match(demoPage, /does not connect to your Relay account or backend/i);
  assert.match(solutionsPage, /not connected integrations today/i);
  assert.match(aboutPage, /does not currently publish customer case studies/i);
  assert.match(pricingPage, /₹2,999/);
  assert.match(pricingPage, /₹3,999/);
  assert.match(pricingPage, /5 active implementations/);
  assert.match(pricingPage, /template revision history and restore/);
  assert.match(pricingPage, /before applicable taxes/i);
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

  const refreshedPortal = await makeDemoAdapter(storage).adapter.request(
    `/api/product/customer/${firstToken}`
  );
  assert.equal(refreshedPortal.requirements.find((item) => item.id === 9030).value, "client@example.test");

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
