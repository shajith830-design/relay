"use strict";

(() => {
  const relayDemo = document.getElementById("relay-physics-demo");
  if (relayDemo) {
    const toggle = document.getElementById("relay-coil-toggle");
    const status = document.getElementById("relay-demo-status");
    toggle.addEventListener("click", () => {
      const energized = relayDemo.dataset.energized !== "true";
      relayDemo.dataset.energized = String(energized);
      toggle.setAttribute("aria-pressed", String(energized));
      toggle.firstChild.textContent = energized ? "De-energize the coil " : "Energize the coil ";
      status.textContent = energized
        ? "Coil energized · magnetic field moves the armature · normally-open load contact closed · lamp on."
        : "Coil off · load contact open · lamp off.";
    });
  }

  const contactPromptStatus = document.getElementById("contact-signal-status");
  if (contactPromptStatus) {
    document.querySelectorAll("[data-contact-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        const details = document.getElementById("details");
        const prompt = button.dataset.contactPrompt;
        if (details.value.includes(prompt)) {
          contactPromptStatus.textContent = "That prompt is already in your draft. No duplicate connection added.";
          details.focus();
          return;
        }
        const draft = [details.value.trim(), prompt].filter(Boolean).join("\n\n");
        if (draft.length > Number(details.maxLength)) {
          contactPromptStatus.textContent = "Make room in your draft first; this prompt would exceed the message length limit.";
          details.focus();
          return;
        }
        details.value = draft;
        details.dispatchEvent(new Event("input", { bubbles: true }));
        contactPromptStatus.textContent = "Draft prompt added. Edit it to fit your situation; nothing has been sent.";
        details.focus();
      });
    });
  }

  const solutionCircuit = document.getElementById("solution-circuit");
  if (solutionCircuit) {
    const walkthrough = [
      {
        kicker: "Checkpoint 1 · Define the route",
        heading: "Map the process your team already follows.",
        copy: "Add the real tasks, owners, and prerequisites. Relay’s process check can flag missing instructions or roles before you save the workflow as a template."
      },
      {
        kicker: "Checkpoint 2 · Reuse the plan",
        heading: "Save the checked process as a template.",
        copy: "A template is a reusable snapshot for future customer work. Later process edits do not rewrite existing implementations."
      },
      {
        kicker: "Checkpoint 3 · Coordinate the handoff",
        heading: "Start a customer plan from that template.",
        copy: "The implementation gives the team one place to assign tasks, track due dates, and request the setup information that customer needs to provide."
      },
      {
        kicker: "Checkpoint 4 · Review readiness",
        heading: "See what is done and what still needs attention.",
        copy: "Review recorded progress, open tasks, missing information, and launch checks. Relay helps organize the review; it does not configure customer software or certify a safe launch."
      }
    ];
    const back = document.getElementById("solution-circuit-back");
    const next = document.getElementById("solution-circuit-next");
    const meter = solutionCircuit.querySelector('[role="progressbar"]');
    function showWalkthroughStep(index) {
      const stepIndex = Math.max(0, Math.min(walkthrough.length - 1, index));
      const step = walkthrough[stepIndex];
      solutionCircuit.dataset.step = String(stepIndex);
      solutionCircuit.querySelectorAll("[data-solution-step]").forEach((button) => {
        button.setAttribute("aria-pressed", String(Number(button.dataset.solutionStep) === stepIndex));
      });
      document.getElementById("solution-circuit-status").textContent = `Checkpoint ${stepIndex + 1} of ${walkthrough.length}`;
      document.getElementById("solution-circuit-kicker").textContent = step.kicker;
      document.getElementById("solution-circuit-heading").textContent = step.heading;
      document.getElementById("solution-circuit-copy").textContent = step.copy;
      meter.setAttribute("aria-valuenow", String(stepIndex + 1));
      document.getElementById("solution-circuit-meter-fill").style.width = `${((stepIndex + 1) / walkthrough.length) * 100}%`;
      back.disabled = stepIndex === 0;
      next.textContent = stepIndex === walkthrough.length - 1 ? "Start again ↺" : "Next checkpoint →";
      next.dataset.step = String(stepIndex);
    }
    solutionCircuit.addEventListener("click", (event) => {
      const stepButton = event.target.closest("[data-solution-step]");
      if (stepButton) showWalkthroughStep(Number(stepButton.dataset.solutionStep));
      if (event.target.closest("#solution-circuit-back")) showWalkthroughStep(Number(solutionCircuit.dataset.step) - 1);
      if (event.target.closest("#solution-circuit-next")) {
        const currentStep = Number(solutionCircuit.dataset.step);
        showWalkthroughStep(currentStep === walkthrough.length - 1 ? 0 : currentStep + 1);
      }
    });
  }

  const fitResult = document.getElementById("plan-fit-result");
  if (!fitResult) return;

  const fitInputs = [
    document.getElementById("fit-members"),
    document.getElementById("fit-implementations"),
    document.getElementById("fit-templates")
  ];
  const growthFeatures = document.getElementById("fit-growth-features");
  const customFeatures = document.getElementById("fit-custom-features");
  const fitName = document.getElementById("plan-fit-name");
  const fitReason = document.getElementById("plan-fit-reason");
  const fitLink = document.getElementById("plan-fit-link");
  const featureNames = {
    growth: "HubSpot handoff, Slack alerts, blocker and scope controls",
    custom: "financial controls, Salesforce/Jira/Linear integrations, or validated file uploads"
  };

  function updatePlanFit() {
    if (fitInputs.some((input) => !input.checkValidity())) {
      fitResult.dataset.plan = "invalid";
      fitName.textContent = "Check the numbers";
      fitReason.textContent = "Use whole numbers greater than zero. Even a switchboard needs sensible limits.";
      fitLink.hidden = true;
      return;
    }

    const [members, implementations, templates] = fitInputs.map((input) => input.valueAsNumber);
    const needsCustom = customFeatures.checked || members > 10 || implementations > 20;
    const needsGrowth = growthFeatures.checked || members > 3 || implementations > 5 || templates > 3;
    const plan = needsCustom ? "custom" : needsGrowth ? "growth" : "starter";
    const planNames = { starter: "Starter", growth: "Growth", custom: "Custom" };
    fitResult.dataset.plan = plan;
    fitName.textContent = planNames[plan];
    fitLink.href = `#${plan}-plan`;
    fitLink.textContent = `See ${planNames[plan]}`;
    fitLink.hidden = false;

    if (plan === "custom") {
      const reasons = [];
      if (members > 10 || implementations > 20) reasons.push("your team size or active implementation count exceeds Growth's published limits");
      if (customFeatures.checked) reasons.push(`you selected ${featureNames.custom}`);
      fitReason.textContent = `Custom is the closest published match because ${reasons.join(" and ")}. Exact capacity and scope are agreed in writing.`;
    } else if (plan === "growth") {
      const reasons = [];
      if (members > 3 || implementations > 5 || templates > 3) reasons.push("your selections exceed Starter's listed capacity");
      if (growthFeatures.checked) reasons.push(`you selected ${featureNames.growth}`);
      fitReason.textContent = `Growth lists up to 10 members, 20 active implementations, and unlimited templates. It covers this selection${reasons.length ? ` because ${reasons.join(" and ")}` : ""}.`;
    } else {
      fitReason.textContent = "Starter lists capacity for up to 3 members, 5 active implementations, and 3 templates. Your selections are within those published limits.";
    }
  }

  [...fitInputs, growthFeatures, customFeatures].forEach((input) => {
    input.addEventListener("input", updatePlanFit);
    input.addEventListener("change", updatePlanFit);
  });
  updatePlanFit();
})();
