"use strict";

(function attachRelayEstimate(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.RelayEstimate = api;
})(typeof globalThis === "undefined" ? this : globalThis, () => {
  const LIMITS = {
    customersPerMonth: [0, 200],
    annualContractValue: [20000, 10000000],
    actualDays: [1, 365],
    bestCaseDays: [1, 365],
    chaseHoursPerWeek: [0, 168],
    hourlyCost: [0, 100000]
  };

  function boundedNumber(value, name) {
    const number = Number(value);
    const [minimum, maximum] = LIMITS[name] || [];
    if (!Number.isFinite(number) || minimum === undefined || number < minimum || number > maximum) {
      throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
    }
    return number;
  }

  function calculateDelayEstimate(input) {
    const customersPerMonth = boundedNumber(input.customersPerMonth, "customersPerMonth");
    const annualContractValue = boundedNumber(input.annualContractValue, "annualContractValue");
    const actualDays = boundedNumber(input.actualDays, "actualDays");
    const bestCaseDays = boundedNumber(input.bestCaseDays, "bestCaseDays");
    const chaseHoursPerWeek = boundedNumber(input.chaseHoursPerWeek, "chaseHoursPerWeek");
    const hourlyCost = boundedNumber(input.hourlyCost, "hourlyCost");
    const delayedDays = Math.max(0, actualDays - bestCaseDays);
    const contractValueTimingPerCustomer = annualContractValue / 365 * delayedDays;
    const annualizedContractValueTiming = contractValueTimingPerCustomer * customersPerMonth * 12;
    const annualChaseHours = chaseHoursPerWeek * 52;
    const annualChaseLaborEstimate = annualChaseHours * hourlyCost;

    return {
      customersPerMonth,
      annualContractValue,
      actualDays,
      bestCaseDays,
      delayedDays,
      contractValueTimingPerCustomer,
      annualizedContractValueTiming,
      annualChaseHours,
      annualChaseLaborEstimate
    };
  }

  function estimateEarlierTiming(input, daysEarlier) {
    const estimate = calculateDelayEstimate(input);
    const days = Number(daysEarlier);
    if (!Number.isFinite(days) || days < 0 || days > estimate.delayedDays) {
      throw new RangeError(`daysEarlier must be between 0 and ${estimate.delayedDays}.`);
    }
    return estimate.annualizedContractValueTiming
      ? estimate.annualizedContractValueTiming * days / estimate.delayedDays
      : 0;
  }

  return { calculateDelayEstimate, estimateEarlierTiming };
});
