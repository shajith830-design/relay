"use strict";

(() => {
  const estimateForm = document.getElementById("delay-estimator-form");
  if (!estimateForm || !window.RelayEstimate) return;

  const currency = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  });
  const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const contractValueRange = document.getElementById("contract-value");
  contractValueRange.addEventListener("input", () => {
    document.getElementById("contract-value-display").textContent = currency.format(Number(contractValueRange.value));
  });
  const value = (name) => Number(estimateForm.elements.namedItem(name).value);
  const estimatorInputs = () => ({
    customersPerMonth: value("customersPerMonth"),
    annualContractValue: value("annualContractValue"),
    actualDays: value("actualDays"),
    bestCaseDays: value("bestCaseDays"),
    chaseHoursPerWeek: value("chaseHoursPerWeek"),
    hourlyCost: value("hourlyCost")
  });

  function updateEstimate() {
    if (!estimateForm.checkValidity()) {
      document.getElementById("estimate-assumption").textContent = "Enter values within the shown ranges to refresh this estimate.";
      return null;
    }
    const estimate = window.RelayEstimate.calculateDelayEstimate(estimatorInputs());
    const billingAtGoLive = estimateForm.elements.namedItem("billingStart").value === "go-live";
    document.getElementById("estimate-delay-label").textContent = billingAtGoLive
      ? "Estimated contract value billed after go-live"
      : "Estimated contract value for pre-go-live service";
    document.getElementById("estimate-delay-value").textContent = currency.format(estimate.annualizedContractValueTiming);
    document.getElementById("estimate-labor-hours").textContent = `${number.format(estimate.annualChaseHours)} hours`;
    document.getElementById("estimate-labor-value").textContent = currency.format(estimate.annualChaseLaborEstimate);
    document.getElementById("estimate-delay-days").textContent = number.format(estimate.delayedDays);
    document.getElementById("estimate-assumption").textContent = billingAtGoLive
      ? "Timing estimate only—not revenue lost. It assumes first-year contract value accrues evenly across 365 days; payment terms and churn are not included."
      : "This estimates contract value associated with the pre-go-live service period. Refund and churn risks are not calculated.";
    updateRelief(estimate);
    return estimate;
  }

  function updateRelief(estimate) {
    if (!estimate) return;
    const slider = document.getElementById("days-shaved");
    const days = Math.min(Number(slider.value), estimate.delayedDays);
    slider.max = String(estimate.delayedDays);
    if (Number(slider.value) !== days) slider.value = String(days);
    document.getElementById("days-shaved-value").textContent = number.format(days);
    document.getElementById("relief-per-customer").textContent =
      currency.format(estimate.annualContractValue / 365 * days);
    document.getElementById("relief-annual-cohort").textContent =
      currency.format(window.RelayEstimate.estimateEarlierTiming(estimatorInputs(), days));
  }

  estimateForm.addEventListener("input", updateEstimate);
  estimateForm.addEventListener("change", updateEstimate);
  document.getElementById("days-shaved").addEventListener("input", () => {
    if (!estimateForm.checkValidity()) return;
    updateRelief(window.RelayEstimate.calculateDelayEstimate(estimatorInputs()));
  });

  const count = document.getElementById("stuck-customer-count");
  const decrement = document.getElementById("stuck-count-decrease");
  const increment = document.getElementById("stuck-count-increase");
  const copyCount = (next) => {
    count.value = String(Math.max(0, Math.min(99, next)));
    count.dispatchEvent(new Event("input", { bubbles: true }));
  };
  decrement.addEventListener("click", () => copyCount(Number(count.value) - 1));
  increment.addEventListener("click", () => copyCount(Number(count.value) + 1));
  document.getElementById("show-estimate").addEventListener("click", () => {
    if (!estimateForm.reportValidity()) return;
    const customers = Number(count.value);
    if (!Number.isInteger(customers) || customers < 0 || customers > 99) {
      count.setCustomValidity("Enter a whole number from 0 to 99.");
      count.reportValidity();
      return;
    }
    count.setCustomValidity("");
    const monthlyCustomers = estimateForm.elements.namedItem("customersPerMonth");
    monthlyCustomers.value = String(customers);
    monthlyCustomers.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("delay-estimator-form").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("customers-per-month").focus({ preventScroll: true });
  });
  count.addEventListener("input", () => count.setCustomValidity(""));

  const calmRange = document.getElementById("calm-range");
  const calmStatus = document.getElementById("calm-status");
  const calmDemo = document.getElementById("calm-demo");
  const updateCalm = () => {
    const calm = Number(calmRange.value) >= 50;
    calmDemo.dataset.state = calm ? "calm" : "busy";
    calmRange.setAttribute("aria-valuetext", calm ? "Sample status view" : "Sample inbox view");
    document.getElementById("calm-state-label").textContent = calm ? "A clearer next step" : "Tuesday, 4:47 pm";
    calmStatus.textContent = calm
      ? "Sample status · Acme Logistics is 85% ready. Waiting on one DNS record from Acme IT."
      : "Sample inbox · DNS setup, a forwarded email, a customer follow-up, and a status request.";
  };
  calmRange.addEventListener("input", updateCalm);
  updateCalm();

  const heroSwitchboard = document.getElementById("hero-switchboard");
  if (heroSwitchboard) {
    const switchboardDetails = {
      deal: "The sample deal is signed. Signal received; now the implementation handoff can start.",
      request: "Setup information has been requested. The next connection is a named person to keep it moving.",
      owner: "The access request has no named owner. A loose connection, not a mystery novel.",
      launch: "Launch review is next in this fictional path. It depends on the earlier setup work being completed and checked."
    };
    const detail = document.getElementById("hero-switchboard-detail");
    const toggle = document.getElementById("hero-switchboard-toggle");
    const status = document.getElementById("hero-switchboard-status");
    heroSwitchboard.addEventListener("click", (event) => {
      const step = event.target.closest("[data-hero-signal]");
      if (step) {
        heroSwitchboard.querySelectorAll("[data-hero-signal]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button === step));
        });
        detail.textContent = heroSwitchboard.dataset.connection === "closed" && step.dataset.heroSignal === "owner"
          ? "Maya owns this sample access check. The handoff has an owner; no real workspace data was changed."
          : switchboardDetails[step.dataset.heroSignal];
      }
      if (event.target.closest("#hero-switchboard-toggle")) {
        const connected = heroSwitchboard.dataset.connection !== "closed";
        heroSwitchboard.dataset.connection = connected ? "closed" : "open";
        const ownerStep = heroSwitchboard.querySelector('[data-hero-signal="owner"]');
        ownerStep.querySelector("strong").textContent = connected ? "Maya assigned" : "Owner missing";
        ownerStep.querySelector("small").textContent = connected ? "Signal connected" : "Open connection";
        ownerStep.querySelector(".hero-signal-node").textContent = connected ? "03" : "!";
        ownerStep.setAttribute("aria-pressed", "true");
        heroSwitchboard.querySelectorAll("[data-hero-signal]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button === ownerStep));
        });
        status.textContent = connected ? "Circuit closed" : "Open circuit";
        detail.textContent = connected
          ? "Connected for this preview: Maya owns the access check, with launch review next. The tiny switch has done its entire job."
          : switchboardDetails.owner;
        toggle.innerHTML = connected
          ? 'Remove sample owner <span aria-hidden="true">⏻</span>'
          : 'Assign a sample owner <span aria-hidden="true">⏻</span>';
      }
    });
  }

  const nudgeForm = document.getElementById("nudge-writer-form");
  const nudgeOutput = document.getElementById("nudge-messages");
  const blockerNames = {
    logo: "the logo file",
    access: "the required access details",
    dns: "the DNS record",
    paperwork: "the signed paperwork",
    contact: "the name of the right project contact",
    test_data: "the test data",
    legal: "the legal approval"
  };
  const waitPhrases = {
    "3-days": "a few days",
    "1-week": "about a week",
    "2-weeks": "more than two weeks"
  };
  const relationshipPhrases = {
    friendly: "Hope your week is going well.",
    quiet: "I know things get busy, so I wanted to check in.",
    manager: "I’ve included the project context below so it’s easy to forward to the right owner."
  };

  function makeNudgeMessages() {
    const fields = new FormData(nudgeForm);
    const contact = String(fields.get("contact") || "").trim() || "[Name]";
    const customer = String(fields.get("company") || "").trim() || "your team";
    const blocker = blockerNames[fields.get("blocker")];
    const wait = waitPhrases[fields.get("wait")];
    const relation = relationshipPhrases[fields.get("relationship")];
    return [
      {
        title: "Kindly revert · Soft",
        text: `Hi ${contact}, ${relation} We’re waiting on ${blocker} to continue ${customer}’s onboarding. It has been ${wait}. Could you share an update when you have a moment? Happy to clarify anything that would help.`
      },
      {
        title: "Per my last email · Firm",
        text: `Hi ${contact}, to keep ${customer}’s onboarding moving, we need ${blocker}. It has been ${wait}; please let us know by [date] whether you can provide it or if another owner should help.`
      },
      {
        title: "A status with context · Escalation",
        text: `Hi ${contact}, ${customer}’s onboarding is waiting on ${blocker} (${wait}). The next planned step is paused until we have it. If someone else owns this, please forward this note or share their name. We can then agree on a realistic updated timeline.`
      }
    ];
  }

  nudgeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    nudgeOutput.replaceChildren();
    for (const message of makeNudgeMessages()) {
      const card = document.createElement("article");
      card.className = "nudge-message-card";
      const heading = document.createElement("h3");
      heading.textContent = message.title;
      const content = document.createElement("p");
      content.textContent = message.text;
      const button = document.createElement("button");
      button.className = "button light";
      button.type = "button";
      button.textContent = "Copy message";
      const status = document.createElement("p");
      status.className = "nudge-copy-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(message.text);
          status.textContent = "Copied. No message was sent.";
        } catch {
          status.textContent = "Copy unavailable. Select the message and copy it manually.";
        }
      });
      card.append(heading, content, button, status);
      nudgeOutput.append(card);
    }
    nudgeOutput.focus();
  });

  updateEstimate();
})();
