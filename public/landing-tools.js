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

  const circuitPreview = document.querySelector(".circuit-preview");
  if (circuitPreview) {
    const circuitMessage = document.getElementById("circuit-preview-message");
    const circuitToggle = document.getElementById("circuit-preview-toggle");
    const stepMessages = {
      closed: "The deal is marked closed in this fictional path. The signal is through; now the implementation handoff can begin.",
      request: "The access details have been requested. Next, the team needs a clear owner to keep this handoff moving.",
      handoff: "This fictional access request has no named owner. Relay lets the team assign a task owner and record the next step. One loose connection; no screwdriver needed.",
      launch: "Launch review is next in this example. It depends on the earlier setup work being completed and checked."
    };
    circuitPreview.addEventListener("click", (event) => {
      const stepButton = event.target.closest("[data-circuit-step]");
      if (stepButton) {
        circuitPreview.querySelectorAll("[data-circuit-step]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button === stepButton));
        });
        circuitMessage.textContent = stepMessages[stepButton.dataset.circuitStep];
      }
      if (event.target.closest("#circuit-preview-toggle")) {
        const connected = circuitPreview.dataset.connection !== "connected";
        circuitPreview.dataset.connection = connected ? "connected" : "open";
        const handoffButton = circuitPreview.querySelector('[data-circuit-step="handoff"]');
        handoffButton.querySelector("strong").textContent = connected ? "Owner assigned" : "Owner missing";
        handoffButton.querySelector("small").textContent = connected ? "Connected" : "Open connection";
        handoffButton.querySelector(".circuit-node").textContent = connected ? "3" : "!";
        circuitMessage.textContent = connected
          ? "Preview connected: Priya owns the access check, with launch review next. This is a sample illustration; no workspace data changed."
          : stepMessages.handoff;
        circuitToggle.textContent = connected ? "Remove sample owner" : "Assign a sample owner";
        handoffButton.setAttribute("aria-pressed", "true");
        circuitPreview.querySelectorAll("[data-circuit-step]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button === handoffButton));
        });
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
