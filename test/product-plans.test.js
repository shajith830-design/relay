"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { getPlanDetails, isPlanCode, validateCustomLimits } = require("../product-plans");

test("Starter and Growth plan limits match the public offer", () => {
  const starter = getPlanDetails("starter");
  assert.equal(starter.memberLimit, 3);
  assert.equal(starter.activeImplementationLimit, 5);
  assert.equal(starter.templateLimit, 3);
  assert.equal(getPlanDetails("starter", { memberLimit: 99, templateLimit: 99 }).memberLimit, 3);
  assert.equal(starter.features.dependencies, true);
  assert.equal(starter.features.clientDelegation, true);
  assert.equal(starter.features.inputValidation, true);
  assert.equal(starter.features.stageGates, true);
  assert.equal(starter.features.clientReminders, true);
  assert.equal(starter.features.csvExports, true);
  assert.equal(starter.features.csvSchemaValidation, false);
  assert.equal(starter.features.credentialVerification, false);
  assert.equal(starter.features.criticalPath, false);
  assert.equal(starter.features.changeOrders, false);
  assert.equal(starter.features.portfolioFull, false);
  assert.equal(starter.features.hubspot, false);
  assert.equal(starter.features.financialProtection, false);
  assert.equal(starter.features.blockers, false);
  assert.equal(starter.features.templateHistory, false);

  const growth = getPlanDetails("growth");
  assert.equal(growth.memberLimit, 10);
  assert.equal(growth.activeImplementationLimit, 20);
  assert.equal(growth.templateLimit, null);
  assert.equal(growth.features.criticalPath, true);
  assert.equal(growth.features.changeOrders, true);
  assert.equal(growth.features.portfolioFull, true);
  assert.equal(growth.features.hubspot, true);
  assert.equal(growth.features.financialProtection, false);
  assert.equal(growth.features.csvSchemaValidation, false);
  assert.equal(growth.features.credentialVerification, false);
  assert.equal(getPlanDetails("custom").features.csvSchemaValidation, true);
  assert.equal(getPlanDetails("custom").features.credentialVerification, true);
});

test("pricing and workspace controls state the implemented plan boundaries", () => {
  const pricing = readFileSync(path.join(__dirname, "..", "public", "pricing.html"), "utf8");
  const product = readFileSync(path.join(__dirname, "..", "public", "product.html"), "utf8");
  const admin = readFileSync(path.join(__dirname, "..", "public", "relay-owner-console.html"), "utf8");

  assert.match(pricing, /Ordered tasks, owners, prerequisites, and stage gates<\/th><td>Included<\/td><td>Included<\/td><td>Included/);
  assert.match(pricing, /Critical-path shifts and change-order task locks<\/th><td>—<\/td><td>Included<\/td><td>Included/);
  assert.match(pricing, /Task-level time and financial controls<\/th><td>—<\/td><td>—<\/td><td>Included/);
  assert.match(pricing, /Template revision history and restore<\/th><td>—<\/td><td>Included<\/td><td>Included/);
  assert.match(pricing, /HubSpot handoff and Slack alerts<\/th><td>—<\/td><td>Included<\/td><td>Included/);
  assert.doesNotMatch(pricing, /after provider setup|requires? provider setup/i);
  assert.match(product, /data-plan-feature="financialProtection"/);
  assert.match(admin, /Custom: agreed member and implementation limits, unlimited templates/);
  assert.doesNotMatch(admin, /name="templateLimit"/);
});

test("Custom plan requires positive member and implementation limits and keeps templates unlimited", () => {
  const limits = { memberLimit: 12, activeImplementationLimit: 30 };
  assert.equal(validateCustomLimits(limits), true);
  assert.deepEqual(getPlanDetails("custom", limits), {
    code: "custom",
    name: "Custom",
    ...limits,
    templateLimit: null,
    features: {
      dependencies: true,
      blockers: true,
      templateHistory: true,
      criticalPath: true,
      changeOrders: true,
      portfolioFull: true,
      hubspot: true,
      financialProtection: true,
      clientDelegation: true,
      inputValidation: true,
      stageGates: true,
      clientReminders: true,
      csvExports: true,
      csvSchemaValidation: true,
      credentialVerification: true,
      slackAlerts: true,
      enterpriseIntegrations: true
    }
  });
  assert.equal(validateCustomLimits({ ...limits, memberLimit: 1.5 }), false);
});

test("Only supported Relay plan identifiers are accepted", () => {
  assert.equal(isPlanCode("starter"), true);
  assert.equal(isPlanCode("growth"), true);
  assert.equal(isPlanCode("custom"), true);
  assert.equal(isPlanCode("enterprise"), false);
  assert.throws(() => getPlanDetails("enterprise"), /Unknown Relay subscription plan/);
});

test("Slack alert access is limited to Growth and Custom plans", () => {
  assert.equal(getPlanDetails("starter").features.slackAlerts, false);
  assert.equal(getPlanDetails("growth").features.slackAlerts, true);
  assert.equal(getPlanDetails("custom").features.slackAlerts, true);
});

test("Salesforce SKU and engineering sync are limited to the Custom plan", () => {
  assert.equal(getPlanDetails("starter").features.enterpriseIntegrations, false);
  assert.equal(getPlanDetails("growth").features.enterpriseIntegrations, false);
  assert.equal(getPlanDetails("custom").features.enterpriseIntegrations, true);
});
