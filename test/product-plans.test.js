"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getPlanDetails, isPlanCode, validateCustomLimits } = require("../product-plans");

test("Starter and Growth plan limits match the public offer", () => {
  const starter = getPlanDetails("starter");
  assert.equal(starter.memberLimit, 3);
  assert.equal(starter.activeImplementationLimit, 5);
  assert.equal(starter.templateLimit, 3);
  assert.deepEqual(starter.features, {
    dependencies: false,
    blockers: false,
    templateHistory: false
  });

  const growth = getPlanDetails("growth");
  assert.equal(growth.memberLimit, 10);
  assert.equal(growth.activeImplementationLimit, 20);
  assert.equal(growth.templateLimit, null);
  assert.ok(Object.values(growth.features).every(Boolean));
});

test("Custom plan requires positive integer limits and enables current Growth features", () => {
  const limits = { memberLimit: 12, activeImplementationLimit: 30, templateLimit: 50 };
  assert.equal(validateCustomLimits(limits), true);
  assert.deepEqual(getPlanDetails("custom", limits), {
    code: "custom",
    name: "Custom",
    ...limits,
    features: { dependencies: true, blockers: true, templateHistory: true }
  });
  assert.equal(validateCustomLimits({ ...limits, templateLimit: 0 }), false);
  assert.equal(validateCustomLimits({ ...limits, memberLimit: 1.5 }), false);
});

test("Only supported Relay plan identifiers are accepted", () => {
  assert.equal(isPlanCode("starter"), true);
  assert.equal(isPlanCode("growth"), true);
  assert.equal(isPlanCode("custom"), true);
  assert.equal(isPlanCode("enterprise"), false);
  assert.throws(() => getPlanDetails("enterprise"), /Unknown Relay subscription plan/);
});
