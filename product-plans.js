"use strict";

const PLAN_DEFINITIONS = Object.freeze({
  starter: Object.freeze({
    code: "starter",
    name: "Starter",
    memberLimit: 3,
    activeImplementationLimit: 5,
    templateLimit: 3,
    features: Object.freeze({
      dependencies: false,
      blockers: false,
      templateHistory: false
    })
  }),
  growth: Object.freeze({
    code: "growth",
    name: "Growth",
    memberLimit: 10,
    activeImplementationLimit: 20,
    templateLimit: null,
    features: Object.freeze({
      dependencies: true,
      blockers: true,
      templateHistory: true
    })
  }),
  custom: Object.freeze({
    code: "custom",
    name: "Custom",
    memberLimit: null,
    activeImplementationLimit: null,
    templateLimit: null,
    features: Object.freeze({
      dependencies: true,
      blockers: true,
      templateHistory: true
    })
  })
});

function isPlanCode(value) {
  return typeof value === "string" && Object.hasOwn(PLAN_DEFINITIONS, value);
}

function getPlanDetails(code, customLimits = {}) {
  if (!isPlanCode(code)) {
    throw new Error(`Unknown Relay subscription plan: ${String(code)}.`);
  }
  const definition = PLAN_DEFINITIONS[code];
  if (code !== "custom") return { ...definition, features: { ...definition.features } };
  return {
    ...definition,
    memberLimit: customLimits.memberLimit ?? null,
    activeImplementationLimit: customLimits.activeImplementationLimit ?? null,
    templateLimit: customLimits.templateLimit ?? null,
    features: { ...definition.features }
  };
}

function validateCustomLimits(limits) {
  return ["memberLimit", "activeImplementationLimit", "templateLimit"].every((key) =>
    Number.isSafeInteger(limits[key]) && limits[key] > 0
  );
}

module.exports = { PLAN_DEFINITIONS, getPlanDetails, isPlanCode, validateCustomLimits };
