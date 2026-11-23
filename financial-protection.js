"use strict";

const BURN_THRESHOLDS = [75, 90, 100];

function calculateBurn({ budgetType, budgetLimit, loggedMinutes, deliveryCost }) {
  const limit = Number(budgetLimit) || 0;
  if (limit <= 0 || !["fixed_hours", "fixed_fee"].includes(budgetType)) return null;
  const consumed = budgetType === "fixed_hours"
    ? (Number(loggedMinutes) || 0) / 60
    : Number(deliveryCost) || 0;
  return consumed / limit * 100;
}

function thresholdsCrossed(lastThresholdSent, burnPercent) {
  const burn = Number(burnPercent);
  if (!Number.isFinite(burn)) return [];
  const prior = Number(lastThresholdSent) || 0;
  const currentFloor = burn >= 100 ? 100 : burn >= 90 ? 90 : burn >= 75 ? 75 : 0;
  const effectivePrior = Math.min(prior, currentFloor);
  return BURN_THRESHOLDS.filter((threshold) => threshold > effectivePrior && burn >= threshold);
}

function calculateProjectFinancials(project, entries, approvedChangeOrderTotal = 0) {
  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    minutes: Number(entry.minutes) || 0,
    internalRate: Number(entry.internal_cost_rate_snapshot) || 0,
    billRate: Number(entry.client_bill_rate_snapshot) || 0,
    hasRateSnapshot: entry.rate_snapshot_present !== false,
    approvedChangeOrder: entry.change_order_approved === true || entry.change_order_approved === "t"
  }));
  const loggedMinutes = normalizedEntries.reduce((total, entry) => total + entry.minutes, 0);
  const deliveryCost = normalizedEntries.reduce(
    (total, entry) => total + (entry.hasRateSnapshot ? entry.minutes / 60 * entry.internalRate : 0), 0
  );
  const unpricedMinutes = normalizedEntries.reduce(
    (total, entry) => total + (entry.hasRateSnapshot ? 0 : entry.minutes), 0
  );
  const contractValue = (Number(project.base_onboarding_fee) || 0)
    + (Number(approvedChangeOrderTotal) || 0);
  const grossProfit = contractValue - deliveryCost;
  const marginPercent = contractValue > 0 ? grossProfit / contractValue * 100 : 0;
  const budgetType = project.budget_type || "fixed_hours";
  const budgetLimit = Number(project.budget_limit) || 0;
  const billableEntries = normalizedEntries
    .filter((entry) => !entry.approvedChangeOrder)
    .sort((left, right) => {
      const byLoggedAt = String(left.logged_at || "").localeCompare(String(right.logged_at || ""));
      return byLoggedAt || Number(left.id || 0) - Number(right.id || 0);
    });
  let overageLeakage = 0;
  if (budgetType === "fixed_hours" && budgetLimit > 0) {
    let consumedMinutes = 0;
    for (const entry of billableEntries) {
      const priorOverage = Math.max(0, consumedMinutes - budgetLimit * 60);
      consumedMinutes += entry.minutes;
      const currentOverage = Math.max(0, consumedMinutes - budgetLimit * 60);
      overageLeakage += (currentOverage - priorOverage) / 60 * entry.billRate;
    }
  } else if (budgetType === "fixed_fee" && budgetLimit > 0) {
    let consumedCost = 0;
    for (const entry of billableEntries) {
      const hours = entry.minutes / 60;
      const cost = entry.hasRateSnapshot ? hours * entry.internalRate : 0;
      const priorOverage = Math.max(0, consumedCost - budgetLimit);
      consumedCost += cost;
      const currentOverage = Math.max(0, consumedCost - budgetLimit);
      if (entry.hasRateSnapshot && entry.internalRate > 0) {
        overageLeakage += (currentOverage - priorOverage) / entry.internalRate * entry.billRate;
      }
    }
  }
  return {
    contract_value: contractValue,
    approved_change_orders_total: Number(approvedChangeOrderTotal) || 0,
    delivery_cost: deliveryCost,
    gross_profit: grossProfit,
    gross_margin_pct: marginPercent,
    logged_minutes: loggedMinutes,
    unpriced_minutes: unpricedMinutes,
    burn_pct: calculateBurn({ budgetType, budgetLimit, loggedMinutes, deliveryCost }),
    unbilled_overage_leakage: overageLeakage
  };
}

function summarizePortfolio(projects) {
  const eligible = projects.filter((project) => project.contract_value > 0);
  return {
    total_portfolio_revenue: projects.reduce((total, project) => total + project.contract_value, 0),
    total_delivery_cost: projects.reduce((total, project) => total + project.delivery_cost, 0),
    average_gross_margin_pct: eligible.length
      ? eligible.reduce((total, project) => total + project.gross_margin_pct, 0) / eligible.length
      : 0,
    unpriced_minutes: projects.reduce((total, project) => total + (Number(project.unpriced_minutes) || 0), 0),
    total_unbilled_overage_leakage: projects.reduce(
      (total, project) => total + project.unbilled_overage_leakage, 0
    )
  };
}

module.exports = {
  calculateBurn,
  thresholdsCrossed,
  calculateProjectFinancials,
  summarizePortfolio
};
