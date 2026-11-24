"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const adapterSource = readFileSync(path.join(__dirname, "..", "public", "product-demo.js"), "utf8");
const productRoutesSource = readFileSync(path.join(__dirname, "..", "product-routes.js"), "utf8");

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

test("financial read routes require a session without requiring an Origin header", () => {
  for (const routePath of [
    "/api/product/analytics/portfolio-margins",
    "/api/product/implementations/:implementationId/time-entries"
  ]) {
    const start = productRoutesSource.indexOf(`app.get("${routePath}"`);
    assert.notEqual(start, -1, `${routePath} should be registered`);
    const nextRoute = productRoutesSource.indexOf("\n  app.", start + 1);
    const registration = productRoutesSource.slice(start, nextRoute === -1 ? undefined : nextRoute);
    assert.match(registration.split("\n", 1)[0], /, requireSession,/);
    assert.doesNotMatch(registration, /\bsameOrigin\b/);
  }
});

test("sample workspace previews portfolio health, notification settings, and integration connections locally", async () => {
  const { adapter } = makeDemoAdapter();
  const workspace = await adapter.request("/api/product/workspace");
  const implementation = workspace.implementations.find((item) => item.id === 9040);
  assert.equal(implementation.blocked_steps, 1);
  assert.equal(implementation.overdue_steps, 1);
  assert.equal(implementation.quiet_customer, true);
  assert.equal(implementation.quiet_customer_days >= 3, true);
  assert.equal(implementation.escalation_email, "");
  assert.equal(implementation.escalation_delay_days, 5);
  assert.match(implementation.projected_completion, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(workspace.notificationSettings.email_enabled, false);

  const savedEscalation = await adapter.request("/api/product/implementations/9040/customer-escalation", {
    method: "PATCH",
    body: { escalationEmail: "  backup@acme.example ", escalationDelayDays: 7 }
  });

  test("sample workspace previews internal financials, budget controls, and task-level time locally", async () => {
    const { adapter } = makeDemoAdapter();
    const dashboard = await adapter.request("/api/product/analytics/portfolio-margins");
    assert.equal(dashboard.projects[0].contract_value, 13500);
    assert.equal(dashboard.projects[0].delivery_cost, 4200);
    assert.equal(dashboard.projects[0].gross_profit, 9300);
    assert.equal(dashboard.projects[0].gross_margin_pct, 9300 / 13500 * 100);

    const implementation = (await adapter.request("/api/product/implementations/9040")).implementation;
    const taskId = implementation.steps[0].id;
    const taskEntry = await adapter.request(`/api/product/implementations/9040/steps/${taskId}/time-entries`, {
      method: "POST",
      body: { minutes: 30, workDate: "2027-01-10", note: "Sample task time" }
    });
    assert.equal(taskEntry.entry.task_id, taskId);
    assert.equal(taskEntry.entry.billable, false);
    assert.equal(taskEntry.entry.internal_cost_rate_snapshot, 70);
    assert.equal(taskEntry.entry.client_bill_rate_snapshot, 150);
    assert.equal(taskEntry.burn.logged_minutes, 3630);

    const savedBudget = await adapter.request("/api/product/implementations/9040/budget", {
      method: "PATCH",
      body: { baseOnboardingFee: 14000, budgetType: "fixed_hours", budgetLimit: 40, hardLockOnExceed: true }
    });
    assert.equal(savedBudget.burn.burn_pct, 151.25);
    const listedEntries = await adapter.request("/api/product/implementations/9040/time-entries");
    assert.equal(listedEntries.entries.length, 2);
    const removed = await adapter.request(`/api/product/time-entries/${taskEntry.entry.id}`, { method: "DELETE" });
    assert.equal(removed.success, true);
  });
  assert.equal(savedEscalation.escalationEmail, "backup@acme.example");
  assert.equal(savedEscalation.escalationDelayDays, 7);
  assert.equal(
    (await adapter.request("/api/product/implementations/9040")).implementation.escalation_email,
    "backup@acme.example"
  );
  assert.equal(
    (await adapter.request("/api/product/implementations/9040")).implementation.escalation_delay_days,
    7
  );
  await assert.rejects(adapter.request("/api/product/implementations/9040/customer-escalation", {
    method: "PATCH",
    body: { escalationEmail: "not-an-email", escalationDelayDays: 7 }
  }), /valid backup contact email/);
  await assert.rejects(adapter.request("/api/product/implementations/9040/customer-escalation", {
    method: "PATCH",
    body: { escalationEmail: "", escalationDelayDays: 2 }
  }), /delay from 3 to 30 days/);

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
  const salesforceConnection = await adapter.request("/api/product/integrations/salesforce/connect", {
    method: "POST",
    body: {}
  });
  assert.equal(salesforceConnection.demoConnected, true);
  integrations = (await adapter.request("/api/product/workspace")).integrations;
  assert.deepEqual(Array.from(integrations, (integration) => integration.provider).sort(), ["hubspot", "salesforce"]);
  await adapter.request("/api/product/integrations/salesforce", { method: "DELETE" });
  await adapter.request("/api/product/integrations/hubspot", { method: "DELETE" });
  integrations = (await adapter.request("/api/product/workspace")).integrations;
  assert.equal(integrations.length, 0);
});

test("sample workspace can archive, restore, and permanently delete implementations", async () => {
  const { adapter } = makeDemoAdapter();
  const implementationId = 9040;
  const customerLink = await adapter.request(`/api/product/implementations/${implementationId}/customer-link`, {
    method: "POST",
    body: {}
  });
  assert.ok(customerLink.customerPortalToken);

  await adapter.request(`/api/product/implementations/${implementationId}/archive`, { method: "PATCH" });
  let workspace = await adapter.request("/api/product/workspace");
  assert.equal(workspace.implementations.some((item) => item.id === implementationId), false);
  assert.equal(workspace.archivedImplementations[0].id, implementationId);
  await assert.rejects(adapter.request(`/api/product/implementations/${implementationId}`), /not found/);

  await adapter.request(`/api/product/implementations/${implementationId}/restore`, { method: "PATCH" });
  workspace = await adapter.request("/api/product/workspace");
  assert.equal(workspace.implementations.some((item) => item.id === implementationId), true);
  assert.equal(workspace.archivedImplementations.length, 0);

  await adapter.request(`/api/product/implementations/${implementationId}/archive`, { method: "PATCH" });
  await adapter.request(`/api/product/implementations/${implementationId}`, { method: "DELETE" });
  workspace = await adapter.request("/api/product/workspace");
  assert.equal(workspace.implementations.some((item) => item.id === implementationId), false);
  assert.equal(workspace.archivedImplementations.length, 0);
});

test("sample template deletion explains when existing implementation history requires keeping it", async () => {
  const { adapter } = makeDemoAdapter();
  const workspace = await adapter.request("/api/product/workspace");
  const template = workspace.templates[0];
  assert.ok(workspace.implementations.some((implementation) => implementation.template_id === template.id));
  const { template: unusedTemplate } = await adapter.request("/api/product/templates", {
    method: "POST",
    body: { processId: workspace.processes[0].id, name: "Unused deletion test" }
  });

  await adapter.request(`/api/product/templates/${unusedTemplate.id}`, { method: "DELETE" });
  assert.equal((await adapter.request("/api/product/workspace")).templates.some((item) => item.id === unusedTemplate.id), false);
  await assert.rejects(
    adapter.request(`/api/product/templates/${template.id}`, { method: "DELETE" }),
    /template is used by customer implementations/
  );

  const productScript = readFileSync(path.join(__dirname, "..", "public", "product.js"), "utf8");
  assert.match(productScript, /const implementationCount = state\.data\.implementations\.filter/);
  assert.match(productScript, /selectedForHubSpot/);
  assert.match(productScript, /Delete unavailable/);
  assert.match(productScript, /template-delete-note-/);
  assert.match(productScript, /class="button primary" type="button" data-start-template=/);
  assert.match(productScript, /class="template-management"/);
});

test("implementation archive and deletion are workspace-admin-only and permanently remove linked records", () => {
  const routes = readFileSync(path.join(__dirname, "..", "product-routes.js"), "utf8");
  const archiveMigration = readFileSync(path.join(__dirname, "..", "migrations", "012_implementation_archive.sql"), "utf8");
  const productScript = readFileSync(path.join(__dirname, "..", "public", "product.js"), "utf8");
  const productHtml = readFileSync(path.join(__dirname, "..", "public", "product.html"), "utf8");

  assert.match(archiveMigration, /ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
  assert.match(routes, /Only a workspace admin can archive implementations/);
  assert.match(routes, /Only a workspace admin can restore implementations/);
  assert.match(routes, /Only a workspace admin can permanently delete implementations/);
  assert.match(routes, /WHERE i\.workspace_id = \$1 AND i\.archived_at IS NULL/);
  assert.match(routes, /AND i\.archived_at IS NULL/);
  assert.match(productScript, /data-restore-implementation/);
  assert.match(productScript, /Permanently delete/);
  assert.match(productHtml, /id="archived-implementations-panel"/);
  assert.match(productHtml, /id="archive-implementation"/);
});

test("starting an implementation requires only its company and template", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const productHtml = readFileSync(path.join(publicDir, "product.html"), "utf8");
  const productScript = readFileSync(path.join(publicDir, "product.js"), "utf8");
  const startForm = productHtml.match(/<form id="implementation-form"[\s\S]*?<\/form>/)?.[0];

  assert.ok(startForm);
  assert.match(startForm, /id="implementation-customer"[^>]*required/);
  assert.match(startForm, /id="implementation-template"[^>]*required/);
  assert.match(startForm, /<details class="implementation-start-optional">/);
  assert.match(startForm, /id="implementation-contact-email"[^>]*placeholder="client@example\.com">/);
  assert.doesNotMatch(startForm, /id="implementation-contact-email"[^>]*required/);
  assert.match(productScript, /querySelector\("\.implementation-start-optional"\)\.open = false/);
});

test("marketing pages expose the sample demo and disclose current product boundaries", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const homePage = readFileSync(path.join(publicDir, "index.html"), "utf8");
  const demoPage = readFileSync(path.join(publicDir, "demo.html"), "utf8");
  const solutionsPage = readFileSync(path.join(publicDir, "features-services.html"), "utf8");
  const aboutPage = readFileSync(path.join(publicDir, "about.html"), "utf8");
  const founderPage = readFileSync(path.join(publicDir, "founder.html"), "utf8");
  const contactPage = readFileSync(path.join(publicDir, "contact.html"), "utf8");
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
  assert.match(sitemapXml, /<loc>https:\/\/relayautomation\.tech\/founder\.html<\/loc>/);
  assert.doesNotMatch(sitemapXml, /dashboard\.html|customer\.html|relay-owner-console\.html/);
  assert.match(homePage, /product\.html\?demo=workspace/);
  assert.match(homePage, /Explore the sample workspace/i);
  assert.match(homePage, /B2B SaaS customer onboarding/i);
  assert.match(aboutPage, /B2B SaaS customer onboarding teams/i);
  assert.match(homePage, /Take every customer from kickoff to go-live/i);
  assert.match(aboutPage, /Mohamed Shajith is the founder of Relay Automation/);
  assert.match(founderPage, /Mohamed Shajith, Founder of Relay Automation/);
  assert.match(founderPage, /B2B SaaS customer onboarding workspace/i);
  assert.match(founderPage, /building technology that addresses real-world challenges/i);
  assert.match(founderPage, /business strategy, product innovation/i);
  assert.match(founderPage, /Personal Philosophy/);
  assert.match(founderPage, /Try through failure, chase through fatigue, endure past effort, and rest only in triumph/);
  assert.match(solutionsPage, /B2B SaaS customer onboarding/i);
  assert.match(demoPage, /B2B SaaS customer onboarding/i);
  assert.match(contactPage, /B2B SaaS customer onboarding/i);
  assert.doesNotMatch([homePage, aboutPage, solutionsPage, demoPage, contactPage, pricingPage].join("\n"), /lead recovery/i);
  for (const generator of ["create_relay_marketing_video_2.py", "create_relay_campaign_2.py"]) {
    const source = readFileSync(path.join(__dirname, "..", "scripts", generator), "utf8");
    assert.match(source, /B2B SAAS CUSTOMER ONBOARDING/);
    assert.doesNotMatch(source, /CUSTOMER OPS/i);
  }
  assert.doesNotMatch(homePage, /No Login Required/i);
  assert.doesNotMatch(homePage, /<video\b/i);
  assert.doesNotMatch(homePage, /relay-home-overview\.mp4/);
  assert.match(homePage, /class="hero-project-photo"/);
  assert.match(homePage, /relay-home-hero\.svg/);
  assert.match(homePage, /Relay onboarding workspace showing launch readiness, next actions, and customer setup progress/);
  assert.match(homePage, /class="hero-logo" src="assets\/Futuristic%20RA%20Tech%20Monogram%20Logo\.png"/);
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
  assert.match(homePage, /separate HubSpot onboarding deal/i);
  assert.match(homePage, /one HubSpot pipeline, its Closed Won stage, and a Relay template/i);
  assert.match(homePage, /does not modify the original sales deal or import unrelated CRM records/i);
  assert.match(homePage, /customers use Relay’s secure portal and do not need HubSpot/i);
  assert.doesNotMatch(homePage, /href="founder\.html"|class="founder-grid"|design partner/i);
  assert.match(aboutPage, /href="founder\.html"/);
  assert.match(founderPage, /Mohamed Shajith/);
  assert.match(founderPage, /<a[^>]*href="https:\/\/www\.linkedin\.com\/in\/mohamed-shajith-relay\/"[^>]*>LinkedIn<\/a>/);
  assert.ok(existsSync(path.join(publicDir, "assets", "relay-home-overview.mp4")));
  const heroImage = readFileSync(path.join(publicDir, "assets", "relay-home-hero.svg"), "utf8");
  assert.ok(existsSync(path.join(publicDir, "assets", "relay-home-hero.svg")));
  assert.doesNotMatch(heroImage, /LIVE WORKSPACE/i);
  for (const illustration of ["readiness", "ownership", "customer", "process"]) {
    assert.ok(existsSync(path.join(publicDir, "assets", `relay-home-${illustration}.svg`)));
  }
  assert.doesNotMatch(homePage, /Plans from ₹2,999 per month/);
  assert.doesNotMatch(homePage, /Built for B2B SaaS implementation teams and the customers they guide from kickoff to launch/);
  assert.match(demoPage, /fictional data/i);
  assert.match(demoPage, /does not connect to your Relay account or backend/i);
  assert.match(solutionsPage, /newly matching deals start one implementation/i);
  assert.match(solutionsPage, /revocable, expiring links/i);
  assert.doesNotMatch([aboutPage, solutionsPage, pricingPage].join("\n"), /Salesforce|Microsoft Teams|Jira|Linear|Asana/i);
  assert.match([homePage, solutionsPage].join("\n"), /portfolio health/i);
  assert.match([homePage, solutionsPage].join("\n"), /CSV/i);
  assert.match([homePage, solutionsPage].join("\n"), /daily reminders/i);
  assert.match(solutionsPage, /private portal/i);
  assert.match(solutionsPage, /newly matching deals start one implementation/i);
  assert.match(pricingPage, /Only scoped CSV\/XLSX uploads for tasks configured with a validation schema are supported/i);
  assert.doesNotMatch(pricingPage, /PDF, PNG, or JPG files/i);
  assert.match(aboutPage, /does not currently publish customer case studies/i);
  assert.match(pricingPage, /₹2,999/);
  assert.match(pricingPage, /₹3,999/);
  assert.match(pricingPage, /5 active implementations/);
  assert.match(pricingPage, /template revision history and restore/i);
  assert.match(pricingPage, /before applicable taxes/i);
  assert.match(pricingPage, /class="plan-grid"/);
  assert.match(readFileSync(path.join(publicDir, "relay-motion.js"), "utf8"), /\.plan-card/);
});

test("public marketing pages expose canonical SEO metadata and factual GEO content", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const canonicalPages = [
    ["/", "index.html"],
    ["/about.html", "about.html"],
    ["/founder.html", "founder.html"],
    ["/features-services.html", "features-services.html"],
    ["/pricing.html", "pricing.html"],
    ["/demo.html", "demo.html"],
    ["/contact.html", "contact.html"],
    ["/privacy.html", "privacy.html"],
    ["/terms.html", "terms.html"]
  ];

  for (const [urlPath, file] of canonicalPages) {
    const html = readFileSync(path.join(publicDir, file), "utf8");
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/);
    assert.equal(canonical?.[1], `https://relayautomation.tech${urlPath}`, `${file} canonical URL`);
    assert.match(html, /<meta name="description" content="[^"]+">/, `${file} description`);
  }

  const socialPages = ["index.html", "about.html", "founder.html", "features-services.html", "pricing.html", "demo.html", "contact.html"];
  for (const file of socialPages) {
    const html = readFileSync(path.join(publicDir, file), "utf8");
    assert.match(html, /<meta property="og:title" content="[^"]+">/, `${file} Open Graph title`);
    assert.match(html, /<meta property="og:description" content="[^"]+">/, `${file} Open Graph description`);
    assert.match(html, /<meta property="og:image" content="https:\/\/relayautomation\.tech\/assets\/relay-home-video-poster\.png">/, `${file} share image`);
    assert.match(html, /<meta property="og:image:alt" content="[^"]+">/, `${file} share image alt`);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, `${file} Twitter card`);
  }

  const homePage = readFileSync(path.join(publicDir, "index.html"), "utf8");
  const homeSchema = homePage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(homeSchema, "home page JSON-LD");
  const homeGraph = JSON.parse(homeSchema[1])["@graph"];
  assert.deepEqual(homeGraph.map(({ "@type": type }) => type), ["Organization", "WebSite", "SoftwareApplication", "Person"]);
  assert.match(homeSchema[1], /Mohamed Shajith/);
  assert.match(homeSchema[1], /linkedin\.com\/in\/mohamed-shajith-relay/);
  assert.match(homeSchema[1], /"name": "Relay Automation"/);
  assert.match(homeSchema[1], /"name": "Relay"/);

  const founderPage = readFileSync(path.join(publicDir, "founder.html"), "utf8");
  const founderSchema = founderPage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(founderSchema, "founder page profile JSON-LD");
  const profile = JSON.parse(founderSchema[1]);
  assert.equal(profile["@type"], "ProfilePage");
  assert.equal(profile.mainEntity["@type"], "Person");
  assert.equal(profile.mainEntity.name, "Mohamed Shajith");
  assert.equal(profile.mainEntity.sameAs, "https://www.linkedin.com/in/mohamed-shajith-relay/");

  const solutionsPage = readFileSync(path.join(publicDir, "features-services.html"), "utf8");
  const faqSchema = solutionsPage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(faqSchema, "solutions page FAQ JSON-LD");
  const faq = JSON.parse(faqSchema[1]);
  assert.equal(faq["@type"], "FAQPage");
  assert.equal(faq.mainEntity.length, 5);
  for (const { name, acceptedAnswer } of faq.mainEntity) {
    assert.ok(solutionsPage.includes(name), `visible FAQ question: ${name}`);
    assert.ok(solutionsPage.includes(acceptedAnswer.text), `visible FAQ answer: ${name}`);
  }

  const pricingPage = readFileSync(path.join(publicDir, "pricing.html"), "utf8");
  const pricingFaqSchema = pricingPage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(pricingFaqSchema, "pricing page FAQ JSON-LD");
  const pricingFaq = JSON.parse(pricingFaqSchema[1]);
  assert.equal(pricingFaq["@type"], "FAQPage");
  for (const { name, acceptedAnswer } of pricingFaq.mainEntity) {
    assert.ok(pricingPage.includes(name), `visible pricing FAQ question: ${name}`);
    assert.ok(pricingPage.includes(acceptedAnswer.text), `visible pricing FAQ answer: ${name}`);
  }

  const robots = readFileSync(path.join(publicDir, "robots.txt"), "utf8");
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Sitemap: https:\/\/relayautomation\.tech\/sitemap\.xml/);
  assert.match(readFileSync(path.join(publicDir, "llms.txt"), "utf8"), /Verified product boundaries/);
  assert.match(readFileSync(path.join(publicDir, "product.html"), "utf8"), /<meta name="robots" content="noindex, nofollow">/);
  assert.match(readFileSync(path.join(publicDir, "customer.html"), "utf8"), /<meta name="robots" content="noindex, nofollow">/);
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
    if (tag.includes('id="team-panel"')) {
      assert.equal(sections.at(-1), "view-settings", "the workspace team panel must only appear in Settings");
    }
    sections.push(viewId || null);
  }
});

test("process map builder separates creation, saving, checking, and template creation", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const productHtml = readFileSync(path.join(publicDir, "product.html"), "utf8");
  const productScript = readFileSync(path.join(publicDir, "product.js"), "utf8");

  for (const id of [
    "process-progress", "process-list", "process-form", "process-editor-subtitle",
    "process-create-details", "step-options", "process-step-count", "step-form-heading",
    "process-action-help", "test-process", "save-template"
  ]) {
    assert.match(productHtml, new RegExp(`id="${id}"`), `${id} must be present in the process builder`);
  }
  assert.match(productHtml, /class="process-workspace"/);
  assert.match(productHtml, /type="submit">Create process map/);
  assert.match(productHtml, /type="submit">Save process/);
  assert.match(productHtml, /id="step-submit" type="submit">Save step/);
  assert.match(productHtml, /id="test-process" type="button">Check process/);
  assert.match(productHtml, /id="save-template" type="button">Create template/);
  assert.match(productHtml, /<details id="process-create-details" class="process-create-details">/);
  assert.match(productHtml, /<details id="step-options" class="process-step-options">/);
  assert.match(productHtml, /Assign to a teammate <span class="optional">Optional<\/span><\/label><select id="step-assignee">/);
  assert.match(productHtml, /More options <span>Timing, prerequisites and customer visibility<\/span>/);
  assert.doesNotMatch(productHtml, /<details class="process-details">/);
  assert.match(productScript, /function renderProcessProgress\(\)/);
  assert.match(productScript, /class="process-progress-action" type="button" data-process-stage=/);
  assert.match(productScript, /const stage = Number\(button\.dataset\.processStage\);[\s\S]*?focusProcessStage\(stage\)\.catch\(showError\)/);
  assert.match(productScript, /async function showProcessWorkspace\(\)/);
  assert.match(productScript, /function focusProcessCreation\(\)/);
  assert.match(productScript, /aria-current="\$\{selected \? "true" : "false"\}" \$\{selected \? "disabled" : ""\}>\$\{selected \? "Selected" : "Open"\}/);
  assert.match(productScript, /document\.getElementById\("process-create-details"\)\.open = false/);
  assert.match(productScript, /document\.getElementById\("step-options"\)\.open = false/);
  assert.match(productScript, /if \(button\.dataset\.view === "processes"\) showProcessWorkspace\(\)\.catch\(showError\)/);
  assert.match(productScript, /steps_count \?\? process\.steps\?\.length/);
  assert.match(productScript, /function hasTemplateForProcess\(processId\)/);
  assert.match(productScript, /saveTemplate\.textContent = hasTemplate \? "Create another template" : "Create template"/);
  const stepSubmitStart = productScript.indexOf('document.getElementById("step-form").addEventListener("submit"');
  const stepSubmitEnd = productScript.indexOf('document.getElementById("cancel-step-edit")', stepSubmitStart);
  const stepSubmitHandler = productScript.slice(stepSubmitStart, stepSubmitEnd);
  const successfulSavePosition = stepSubmitHandler.indexOf("clearDirtyScope(form);");
  assert.ok(successfulSavePosition > stepSubmitHandler.indexOf("await api("), "a successful step save must clear its dirty state");
  assert.ok(successfulSavePosition < stepSubmitHandler.indexOf("form.reset();"), "clear the dirty state before reloading the saved process");
  const saveProcessDetailsPosition = stepSubmitHandler.indexOf('finishForm(processMetaForm, "Saved.");');
  const saveStepPosition = stepSubmitHandler.indexOf("const result = await api(`/api/product/processes/");
  assert.ok(saveProcessDetailsPosition > -1 && saveProcessDetailsPosition < saveStepPosition, "save pending process details before reloading the saved step");
  assert.match(productScript, /step-form-heading"\)\.textContent = "Edit a step"/);
});

test("workspace navigation is grouped and the overview routes to one next action", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const productHtml = readFileSync(path.join(publicDir, "product.html"), "utf8");
  const productScript = readFileSync(path.join(publicDir, "product.js"), "utf8");

  const navItems = [...productHtml.matchAll(/<button class="nav-item[^"]*" data-view="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(navItems, [
    "overview",
    "processes",
    "templates",
    "implementations",
    "requirements",
    "portfolio",
    "financials",
    "integrations",
    "settings",
    "guide"
  ]);
  assert.match(productHtml, /class="nav-group-label">Workspace/);
  assert.match(productHtml, /class="nav-group-label">Run onboarding/);
  assert.match(productHtml, /class="nav-group-label">Manage workspace/);
  assert.match(productHtml, /class="nav-group-label">Help/);
  assert.match(productHtml, /class="nav-item active" data-view="overview" aria-current="page"/);
  assert.match(productScript, /if \(isActive\) item\.setAttribute\("aria-current", "page"\);[\s\S]*?else item\.removeAttribute\("aria-current"\);/);
  assert.match(productHtml, /id="mobile-nav-toggle"/);
  assert.match(productHtml, /id="sidebar-backdrop"/);
  assert.match(productHtml, /id="overview-primary-action"[^>]*data-workflow-action=/);
  assert.match(productScript, /primaryAction\.dataset\.workflowAction = next\.action/);
  assert.match(productScript, /if \(!setView\("implementations"\)\) return;\s*document\.getElementById\("implementation-template"\)\.value/);
  assert.match(productScript, /Use the main action above to continue/);
});

test("implementation details provide quick navigation to customer workflow sections", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const productHtml = readFileSync(path.join(publicDir, "product.html"), "utf8");
  const productScript = readFileSync(path.join(publicDir, "product.js"), "utf8");
  const productCss = readFileSync(path.join(publicDir, "product.css"), "utf8");
  const sectionIds = [
    "implementation-work-section",
    "implementation-information-section",
    "customer-access-section",
    "communication-section",
    "delivery-section",
    "launch-readiness-section",
    "collaboration-section"
  ];

  assert.match(productHtml, /<nav id="implementation-section-nav"[^>]*aria-label="Implementation sections">/);
  for (const id of sectionIds) {
    assert.match(productHtml, new RegExp(`data-implementation-jump="${id}"[^>]*aria-controls="${id}"`));
    assert.match(productHtml, new RegExp(`id="${id}"`));
  }
  assert.match(productScript, /implementation-section-nav"\)\.addEventListener\("click"/);
  assert.match(productScript, /if \(target\.matches\("details"\)\) target\.open = true/);
  assert.match(productScript, /target\.scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.match(productCss, /\.implementation-section-nav button\[aria-current="location"\]/);
});

test("opening an implementation immediately shows its loading state", () => {
  const productScript = readFileSync(path.join(__dirname, "..", "public", "product.js"), "utf8");
  assert.match(productScript, /function openImplementationFromButton\(button\) \{[\s\S]*button\.disabled = true;[\s\S]*button\.setAttribute\("aria-busy", "true"\);[\s\S]*button\.textContent = "Opening\.\.\.";/);
  assert.match(productScript, /button\.removeAttribute\("aria-busy"\);[\s\S]*button\.textContent = label;/);
});

test("named customer resends rotate links and customer access resolves implementation IDs", () => {
  const productScript = readFileSync(path.join(__dirname, "..", "public", "product.js"), "utf8");
  const productRoutes = readFileSync(path.join(__dirname, "..", "product-routes.js"), "utf8");
  assert.match(productScript, /Fresh portal invitation sent/);
  assert.match(productScript, /method: "POST"/);
  assert.match(productRoutes, /c\.implementation_id, c\.expires_at, i\.id, i\.workspace_id, i\.template_id/);
});

test("workspace refresh validates customer inputs in one batch instead of per implementation", () => {
  const routes = readFileSync(path.join(__dirname, "..", "product-routes.js"), "utf8");
  const start = routes.indexOf('app.get("/api/product/workspace"');
  const end = routes.indexOf('app.patch("/api/product/notifications"', start);
  assert.ok(start >= 0 && end > start, "workspace endpoint boundaries must exist");
  const workspaceRoute = routes.slice(start, end);

  assert.match(workspaceRoute, /const requirementsByImplementation = new Map\(\)/);
  assert.match(workspaceRoute, /FROM product_implementations i[\s\S]*?JOIN product_requirements r[\s\S]*?LEFT JOIN product_customer_inputs c/);
  assert.match(workspaceRoute, /requirementsByImplementation\.get\(implementation\.id\) \|\| \[\]/);
  assert.doesNotMatch(workspaceRoute, /for \(const implementation of implementations\) \{\s*const scopedRequirements = await implementationRequirements/);
});

test("implementation detail loads independent sections concurrently", () => {
  const routes = readFileSync(path.join(__dirname, "..", "product-routes.js"), "utf8");
  const start = routes.indexOf('app.get("/api/product/implementations/:implementationId"');
  const end = routes.indexOf('app.patch("/api/product/implementations/:implementationId/launch-plan"', start);
  assert.ok(start >= 0 && end > start, "implementation detail endpoint boundaries must exist");
  const detailRoute = routes.slice(start, end);

  assert.match(detailRoute, /const \[\s*steps,[\s\S]*?calendarEvents\s*\] = await Promise\.all\(\[/);
  assert.match(detailRoute, /implementationRequirements\(implementationId, req\.product\.workspaceId, implementation\.template_id\)/);
});

test("workspace exposes delivery operations and competitive capability controls", () => {
  const productHtml = readFileSync(path.join(__dirname, "..", "public", "product.html"), "utf8");
  const productScript = readFileSync(path.join(__dirname, "..", "public", "product.js"), "utf8");
  for (const id of [
    "delivery-operations-heading", "implementation-sow-form", "implementation-financial-form",
    "budget-cap-form", "budget-override-form", "approval-form", "implementation-onboarding-gap-plan"
  ]) {
    assert.match(productHtml, new RegExp(`id="${id}"`), `${id} must be present`);
  }
  assert.match(productScript, /data-time-preset="15"/);
  assert.match(productScript, /data-time-start=/);
  assert.match(productScript, /data-time-stop=/);
});

test("implementation planning forms are grouped into accessible collapsed sections", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const productHtml = readFileSync(path.join(publicDir, "product.html"), "utf8");
  const productCss = readFileSync(path.join(publicDir, "product.css"), "utf8");
  const productScript = readFileSync(path.join(publicDir, "product.js"), "utf8");
  const sections = [...productHtml.matchAll(/<details class="panel implementation-collapsible"[^>]*data-implementation-section="([^"]+)"[^>]*>([\s\S]*?)<\/details>/g)];
  const subsections = [...productHtml.matchAll(/<details class="implementation-subsection"[^>]*>/g)];
  const implementationDetail = productHtml.slice(
    productHtml.indexOf('<div class="panel" id="implementation-detail"'),
    productHtml.indexOf('<section class="view" id="view-requirements">')
  );

  assert.deepEqual(sections.map((section) => section[1]), [
    "customer-access",
    "communication",
    "delivery",
    "launch-readiness",
    "customer-collaboration"
  ]);
  assert.ok(implementationDetail.indexOf('id="implementation-step-list"') < implementationDetail.indexOf('data-implementation-section="customer-access"'));
  assert.ok(implementationDetail.indexOf('id="implementation-requirements"') < implementationDetail.indexOf('data-implementation-section="communication"'));
  assert.match(productHtml, /id="customer-access-summary"/);
  for (const section of sections) {
    assert.doesNotMatch(section[0], /\sopen(?:\s|>)/);
    assert.match(section[2], /<summary class="implementation-collapsible-summary">/);
    assert.match(section[2], /<h3 id="[^"]+">/);
  }
  assert.equal(subsections.length, 13, "optional delivery forms should be grouped into focused, collapsed subsections");
  assert.ok(subsections.every((section) => !/\sopen(?:\s|>)/.test(section[0])));
  assert.match(productHtml, /id="implementation-onboarding-gap-plan"/);
  assert.match(productCss, /\.implementation-field-grid\s*\{[^}]*display: grid/);
  assert.match(productCss, /\.implementation-field-grid input,[\s\S]*?\{[^}]*min-height: 44px/);
  assert.match(productCss, /\.implementation-subsection\s*\{[^}]*overflow: hidden/);
  assert.match(productCss, /\.communication-form-layout, \.implementation-field-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(productHtml, /id="implementation-step-summary"/);
  assert.match(productScript, /<details class="task-edit-details">\s*<summary aria-label="Edit task:/);
  assert.match(productScript, /class="badge task-status-badge \$\{taskStatus\.className\}"/);
  assert.match(productScript, /implementation-step-summary"\)\.textContent = implementation\.steps\.length/);
});

test("public pages describe only verified product capabilities", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const home = readFileSync(path.join(publicDir, "index.html"), "utf8");
  const about = readFileSync(path.join(publicDir, "about.html"), "utf8");
  const solutions = readFileSync(path.join(publicDir, "features-services.html"), "utf8");
  const pricing = readFileSync(path.join(publicDir, "pricing.html"), "utf8");
  const publicCopy = [home, about, solutions, pricing].join("\n");

  for (const supported of [
    "Process maps", "named customer contacts.*revocable", "HubSpot", "email notifications",
    "SOW scope", "team capacity", "invoice status", "Customer questions"
  ]) {
    assert.match(publicCopy, new RegExp(supported, "i"));
  }
  assert.doesNotMatch(publicCopy, /<li[^>]*>[^<]*(?:Slack|Salesforce|Jira|Zapier|Workato|native (?:iOS|Android|mobile)|SSO|SCIM|SOC 2|ISO certification)[^<]*<\/li>|generate invoices on the platform|automatically process payments/i);
});

test("password reset can reveal passwords and resets the form after submission", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const productHtml = readFileSync(path.join(publicDir, "product.html"), "utf8");
  const productScript = readFileSync(path.join(publicDir, "product.js"), "utf8");
  const resetSubmit = productScript.match(
    /document\.getElementById\("password-reset-complete-form"\)\.addEventListener\("submit", async \(event\) => \{[\s\S]*?\n\}\);/
  )?.[0];

  assert.match(productHtml, /data-password-toggle="reset-password"/);
  assert.match(productHtml, /data-password-toggle="reset-password-confirm"/);
  assert.ok(resetSubmit);
  assert.match(resetSubmit, /const form = event\.currentTarget;/);
  assert.match(resetSubmit, /document\.getElementById\("reset-password"\)\.value = "";/);
  assert.match(resetSubmit, /document\.getElementById\("reset-password-confirm"\)\.value = "";/);
  assert.doesNotMatch(resetSubmit, /\.reset\(/);
  assert.doesNotMatch(resetSubmit, /event\.currentTarget\.reset\(\)/);
  assert.match(productScript, /button\.setAttribute\("aria-pressed", String\(isVisible\)\)/);
  const productCss = readFileSync(path.join(publicDir, "product.css"), "utf8");
  assert.match(productCss, /\.toast \{[^}]*bottom: 82px;/);
  assert.match(productCss, /\.toast \{ right: 12px; bottom: 72px;/);
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

test("customer portal wizard keeps Relay launch details and prevents lost or misleading actions", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const customerHtml = readFileSync(path.join(publicDir, "customer.html"), "utf8");
  const customerScript = readFileSync(path.join(publicDir, "customer.js"), "utf8");
  const routes = readFileSync(path.join(__dirname, "..", "product-routes.js"), "utf8");

  assert.match(customerHtml, /id="wizard-steps"/);
  assert.match(customerHtml, /id="wizard-body"/);
  assert.match(customerHtml, /id="customer-conversation-section"/);
  assert.match(customerScript, /sessionStorage\.setItem\(draftKey, JSON\.stringify\(store\.drafts\)\)/);
  assert.match(customerScript, /Rollback plan/);
  assert.match(customerScript, /Adoption and change management/);
  assert.match(customerScript, /Early validation/);
  assert.match(customerScript, /blocked \? '<span class="badge attention">Blocked<\/span>'/);
  assert.match(customerScript, /el\.body\.querySelectorAll\("button, input, select, textarea"\)/);
  assert.match(customerScript, /el\.steps\.querySelectorAll\("button"\)/);
  assert.match(routes, /const implementationId = implementation\.implementation_id \|\| implementation\.id/);
  assert.match(routes, /access\.kind !== "delegate"/);
  assert.match(routes, /product_customer_task_delegation_steps/);
  assert.match(routes, /locked_pending_co/);
});

test("sample customer contacts can use launch plans, questions, and file sharing without sending email", async () => {
  const { adapter } = makeDemoAdapter();
  const launchPlan = await adapter.request("/api/product/implementations/9040/launch-plan", {
    method: "PATCH",
    body: {
      customerOwnerName: "Morgan Demo",
      customerOwnerEmail: "morgan@example.test",
      targetLaunchDate: "2027-05-20"
    }
  });
  assert.equal(launchPlan.targetLaunchDate, "2027-05-20");

  const invitation = await adapter.request("/api/product/implementations/9040/customer-contacts", {
    method: "POST",
    body: { email: "morgan@example.test", displayName: "Morgan Demo" }
  });
  assert.equal(invitation.invitationSent, false);
  assert.match(invitation.message, /No email was sent/);
  const token = new URL(invitation.customerPortalUrl).searchParams.get("token");
  assert.ok(token);
  const portal = await adapter.request(`/api/product/customer/${token}`);
  assert.equal(portal.contact.name, "Morgan Demo");
  assert.equal(portal.targetLaunchDate, "2027-05-20");

  await adapter.request(`/api/product/customer/${token}/messages`, {
    method: "POST",
    body: { body: "Can we review the launch date?" }
  });
  const upload = await adapter.request(`/api/product/customer/${token}/files`, {
    method: "POST",
    body: { filename: "plan.pdf", contentType: "application/pdf", size: 1200 }
  });
  assert.equal(upload.file.filename, "plan.pdf");
  const implementation = (await adapter.request("/api/product/implementations/9040")).implementation;
  assert.equal(implementation.customerMessages.at(-1).body, "Can we review the launch date?");
  assert.equal(implementation.customerFiles[0].filename, "plan.pdf");

  await adapter.request(`/api/product/implementations/9040/customer-contacts/${invitation.contact.id}`, {
    method: "DELETE"
  });
  await assert.rejects(adapter.request(`/api/product/customer/${token}`), /no longer available/);
});

test("sample implementation tracks launch readiness, stakeholders, and risks", async () => {
  const { adapter } = makeDemoAdapter();
  await adapter.request("/api/product/implementations/9040/launch-readiness", {
    method: "PATCH",
    body: {
      successCriteria: "Customer team completes acceptance testing.",
      acceptanceStatus: "accepted",
      testPlan: "Run end-to-end acceptance tests.",
      trainingStatus: "complete",
      supportOwnerName: "Alex Support",
      supportOwnerEmail: "alex@example.test",
      rollbackPlan: "Restore the previous configuration.",
      goLiveStatus: "ready"
    }
  });
  const stakeholder = await adapter.request("/api/product/implementations/9040/launch-stakeholders", {
    method: "POST",
    body: { displayName: "Finance Approver", email: "finance@example.test", role: "Finance", approvalStatus: "approved", nextAction: "" }
  });
  assert.equal(stakeholder.stakeholder.approval_status, "approved");
  const risk = await adapter.request("/api/product/implementations/9040/launch-risks", {
    method: "POST",
    body: { title: "IT approval is pending", category: "Approval", severity: "high", ownerName: "IT Lead", ownerEmail: "it@example.test", status: "open", nextAction: "Schedule approval review", dueAt: "2027-01-15" }
  });
  assert.equal(risk.risk.severity, "high");
  const implementation = (await adapter.request("/api/product/implementations/9040")).implementation;
  assert.equal(implementation.go_live_status, "ready");
  assert.equal(implementation.launchStakeholders.length, 1);
  assert.equal(implementation.launchRisks.length, 1);
});

test("sample implementation tracks communication, approval, security, integration, adoption, validation, and support gaps", async () => {
  const { adapter } = makeDemoAdapter();
  await adapter.request("/api/product/implementations/9040/onboarding-gap-plan", {
    method: "PATCH",
    body: {
      communicationChannel: "Weekly customer call",
      communicationCadence: "Every Tuesday",
      communicationOwnerName: "Jordan Lee",
      communicationOwnerEmail: "jordan@example.test",
      procurementStatus: "approved",
      securityStatus: "in_progress",
      securityNotes: "Data handling and access review",
      integrationInventory: "API and third-party service inventory",
      integrationStatus: "tested",
      technicalSetupStatus: "ready",
      technicalSetupNotes: "DNS, email authentication, sandbox, and user imports verified",
      changeManagementStatus: "planned",
      adoptionNotes: "Role-based training planned",
      earlyValidationStatus: "passed",
      earlyValidationNotes: "Configuration and data tests passed",
      postLaunchSupportPlan: "Support owner and escalation route defined",
      duplicateRequestControl: "Reuse the portal request record"
    }
  });
  const implementation = (await adapter.request("/api/product/implementations/9040")).implementation;
  assert.equal(implementation.procurement_status, "approved");
  assert.equal(implementation.security_status, "in_progress");
  assert.equal(implementation.integration_status, "tested");
  assert.equal(implementation.technical_setup_status, "ready");
  assert.equal(implementation.change_management_status, "planned");
  assert.equal(implementation.early_validation_status, "passed");
});

test("sample delivery operations track SOW, financial plans, time, approvals, and stage gates", async () => {
  const { adapter } = makeDemoAdapter();
  await adapter.request("/api/product/implementations/9040/sow", {
    method: "PATCH",
    body: { sowScope: "Configure onboarding", sowMilestones: "Configure, test, launch", sowExclusions: "Custom development", stageGateStatus: "testing" }
  });
  await adapter.request("/api/product/implementations/9040/financial-plan", {
    method: "PATCH",
    body: { budgetAmount: 15000, forecastAmount: 14000, actualCost: 7000, invoiceStatus: "draft", invoiceReference: "INV-100", marginNote: "Margin healthy" }
  });
  const timeEntry = await adapter.request("/api/product/implementations/9040/time-entries", {
    method: "POST",
    body: { workDate: "2027-01-10", minutes: 90, hourlyRate: 100, billable: true, note: "Acceptance testing" }
  });
  assert.equal(timeEntry.entry.minutes, 90);
  const approval = await adapter.request("/api/product/implementations/9040/approvals", {
    method: "POST",
    body: { title: "Security approval", stageGate: "testing", approvalType: "security", approverName: "Security Lead", approverEmail: "security@example.test", dueAt: "2027-01-12" }
  });
  assert.equal(approval.approval.stage_gate, "testing");
  await assert.rejects(adapter.request("/api/product/implementations/9040/sow", {
    method: "PATCH",
    body: { stageGateStatus: "launch" }
  }), /Approve all required testing approvals/);
  await adapter.request(`/api/product/implementations/9040/approvals/${approval.approval.id}`, {
    method: "PATCH",
    body: { status: "approved" }
  });
  await adapter.request("/api/product/implementations/9040/sow", {
    method: "PATCH",
    body: { stageGateStatus: "launch" }
  });
  await adapter.request("/api/product/implementations/9040/sow", {
    method: "PATCH",
    body: { stageGateStatus: "testing" }
  });
  const implementation = (await adapter.request("/api/product/implementations/9040")).implementation;
  assert.equal(implementation.stage_gate_status, "testing");
  assert.equal(implementation.financialPlan.invoice_status, "draft");
  assert.equal(implementation.timeEntries[0].minutes, 90);
  assert.equal(implementation.approvals[0].status, "approved");
});

test("sample customer uploads enforce per-file count and total storage limits", async () => {
  const { adapter } = makeDemoAdapter();
  const invitation = await adapter.request("/api/product/implementations/9040/customer-contacts", {
    method: "POST",
    body: { email: "file-limit@example.test", displayName: "File Limit" }
  });
  const token = new URL(invitation.customerPortalUrl).searchParams.get("token");

  for (let index = 0; index < 20; index += 1) {
    await adapter.request(`/api/product/customer/${token}/files`, {
      method: "POST",
      body: { filename: `file-${index}.pdf`, contentType: "application/pdf", size: 1 }
    });
  }
  await assert.rejects(
    adapter.request(`/api/product/customer/${token}/files`, {
      method: "POST",
      body: { filename: "too-many.pdf", contentType: "application/pdf", size: 1 }
    }),
    /up to 20 files and 25 MB total/
  );

  const secondAdapter = makeDemoAdapter().adapter;
  const secondInvitation = await secondAdapter.request("/api/product/implementations/9040/customer-contacts", {
    method: "POST",
    body: { email: "size-limit@example.test", displayName: "Size Limit" }
  });
  const secondToken = new URL(secondInvitation.customerPortalUrl).searchParams.get("token");
  for (let index = 0; index < 5; index += 1) {
    await secondAdapter.request(`/api/product/customer/${secondToken}/files`, {
      method: "POST",
      body: { filename: `large-${index}.pdf`, contentType: "application/pdf", size: 5 * 1024 * 1024 }
    });
  }
  await assert.rejects(
    secondAdapter.request(`/api/product/customer/${secondToken}/files`, {
      method: "POST",
      body: { filename: "over-limit.pdf", contentType: "application/pdf", size: 1 }
    }),
    /up to 20 files and 25 MB total/
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
  const workspace = await adapter.request("/api/product/workspace");
  assert.equal(
    workspace.processes.find((item) => item.id === process.id).steps_count,
    process.steps.length
  );
});
