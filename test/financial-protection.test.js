"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  calculateBurn,
  calculateProjectFinancials,
  summarizePortfolio,
  thresholdsCrossed
} = require("../financial-protection");

test("burn alerts cross 75, 90, and 100 once and can restart after usage drops below a threshold", () => {
  assert.deepEqual(thresholdsCrossed(0, 75), [75]);
  assert.deepEqual(thresholdsCrossed(75, 90), [90]);
  assert.deepEqual(thresholdsCrossed(90, 100), [100]);
  assert.deepEqual(thresholdsCrossed(100, 110), []);
  assert.deepEqual(thresholdsCrossed(100, 80), []);
  assert.deepEqual(thresholdsCrossed(75, 74), []);
  assert.deepEqual(thresholdsCrossed(0, 74), []);
});

test("fixed-hour and fixed-fee burn use time and snapshotted labor cost respectively", () => {
  assert.equal(calculateBurn({
    budgetType: "fixed_hours", budgetLimit: 10, loggedMinutes: 450, deliveryCost: 500
  }), 75);
  assert.equal(calculateBurn({
    budgetType: "fixed_fee", budgetLimit: 500, loggedMinutes: 10, deliveryCost: 450
  }), 90);
  assert.equal(calculateBurn({
    budgetType: "time_and_materials", budgetLimit: 100, loggedMinutes: 60, deliveryCost: 100
  }), null);
});

test("project margin includes approved change orders and excludes their covered work from leakage", () => {
  const project = calculateProjectFinancials({
    base_onboarding_fee: 1000,
    budget_type: "fixed_hours",
    budget_limit: 10
  }, [
    { id: 1, minutes: 480, internal_cost_rate_snapshot: 50, client_bill_rate_snapshot: 100, logged_at: "2025-01-01" },
    { id: 2, minutes: 240, internal_cost_rate_snapshot: 60, client_bill_rate_snapshot: 120, logged_at: "2025-01-02" },
    { id: 3, minutes: 120, internal_cost_rate_snapshot: 40, client_bill_rate_snapshot: 100, logged_at: "2025-01-03", change_order_approved: true }
  ], 250);
  assert.equal(project.contract_value, 1250);
  assert.equal(project.delivery_cost, 720);
  assert.equal(project.gross_profit, 530);
  assert.equal(project.gross_margin_pct, 42.4);
  assert.equal(project.unbilled_overage_leakage, 240);
});

test("fixed-fee leakage converts excess delivery cost to unbilled client-rate value", () => {
  const project = calculateProjectFinancials({
    base_onboarding_fee: 1000,
    budget_type: "fixed_fee",
    budget_limit: 500
  }, [
    { id: 1, minutes: 480, internal_cost_rate_snapshot: 50, client_bill_rate_snapshot: 100, logged_at: "2025-01-01" },
    { id: 2, minutes: 240, internal_cost_rate_snapshot: 60, client_bill_rate_snapshot: 120, logged_at: "2025-01-02" }
  ]);
  assert.equal(project.unbilled_overage_leakage, 280);
});

test("legacy entries without rate snapshots do not silently skew margin", () => {
  const project = calculateProjectFinancials({
    base_onboarding_fee: 1000,
    budget_type: "fixed_hours",
    budget_limit: 10
  }, [
    { id: 1, minutes: 120, internal_cost_rate_snapshot: 0, client_bill_rate_snapshot: 100, rate_snapshot_present: false }
  ]);
  assert.equal(project.logged_minutes, 120);
  assert.equal(project.delivery_cost, 0);
  assert.equal(project.unpriced_minutes, 120);
  assert.equal(project.unbilled_overage_leakage, 0);

  const zeroRateSnapshot = calculateProjectFinancials({ base_onboarding_fee: 1000 }, [
    { minutes: 60, internal_cost_rate_snapshot: 0, rate_snapshot_present: true }
  ]);
  assert.equal(zeroRateSnapshot.unpriced_minutes, 0);
});

test("portfolio KPIs total costs and revenue and average only projects with revenue", () => {
  assert.deepEqual(summarizePortfolio([
    { contract_value: 1000, delivery_cost: 400, gross_margin_pct: 60, unbilled_overage_leakage: 10 },
    { contract_value: 500, delivery_cost: 300, gross_margin_pct: 40, unpriced_minutes: 60, unbilled_overage_leakage: 20 },
    { contract_value: 0, delivery_cost: 50, gross_margin_pct: 0, unpriced_minutes: 120, unbilled_overage_leakage: 0 }
  ]), {
    total_portfolio_revenue: 1500,
    total_delivery_cost: 750,
    average_gross_margin_pct: 50,
    unpriced_minutes: 180,
    total_unbilled_overage_leakage: 30
  });
});
