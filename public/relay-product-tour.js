"use strict";

(() => {
  const views = {
    process: {
      nav: "Process maps",
      title: "New customer setup",
      eyebrow: "PROCESS MAP · EXAMPLE",
      badge: "Needs one owner",
      tip: "Start with the steps your team already follows.",
      detail: "A process map can capture tasks, owners, instructions, and prerequisites.",
      scene: `<div class="tour-scene-title"><div><span class="tour-scene-kicker">Process map <b>· illustrative</b></span><h3>New customer setup</h3></div><span class="tour-state-chip amber"><i></i> 1 loose connection</span></div>
        <div class="tour-process-route" aria-label="Example process steps">
          <article class="tour-process-node done"><span class="tour-node-number">01</span><div><small>TEAM TASK</small><strong>Confirm kickoff details</strong><span>Owner · Maya Chen</span></div><b aria-label="Complete">✓</b></article>
          <span class="tour-route-link connected" aria-hidden="true"><i>↳</i></span>
          <article class="tour-process-node waiting"><span class="tour-node-number">02</span><div><small>CUSTOMER TASK</small><strong>Share access details</strong><span>Owner · Customer IT</span></div><b aria-label="Waiting">…</b></article>
          <span class="tour-route-link" aria-hidden="true"><i>↳</i></span>
          <article class="tour-process-node next"><span class="tour-node-number">03</span><div><small>TEAM TASK</small><strong>Review setup information</strong><span>Next after access arrives</span></div><b aria-label="Next">03</b></article>
        </div>
        <div class="tour-screen-foot"><span><i class="tour-resistor" aria-hidden="true"></i> Dependencies show what needs to happen first.</span><span>Illustrative records</span></div>`
    },
    template: {
      nav: "Templates",
      title: "Your reusable starting points",
      eyebrow: "TEMPLATE LIBRARY · EXAMPLE",
      badge: "Ready to reuse",
      tip: "Check the process, then save a reusable starting point.",
      detail: "A template is a snapshot for future implementation work; later edits do not rewrite existing plans.",
      scene: `<div class="tour-scene-title"><div><span class="tour-scene-kicker">Templates <b>· illustrative</b></span><h3>Pick a starting point</h3></div><span class="tour-state-chip green"><i></i> Checked process</span></div>
        <div class="tour-template-grid">
          <article class="tour-template-card featured"><span class="tour-template-glyph" aria-hidden="true">⌘</span><span class="tour-template-category">B2B SAAS</span><h4>Customer onboarding</h4><p>Kickoff · setup · review · launch</p><div class="tour-template-meta"><span><i class="tour-mini-dot"></i> 8 steps</span><span>Updated for reuse</span></div></article>
          <article class="tour-template-card"><span class="tour-template-glyph violet" aria-hidden="true">⇄</span><span class="tour-template-category">DATA</span><h4>Data migration</h4><p>Access · mapping · validation</p><div class="tour-template-meta"><span><i class="tour-mini-dot muted"></i> 6 steps</span><span>Team process</span></div></article>
          <article class="tour-template-card tour-template-add"><span aria-hidden="true">＋</span><strong>Your next process</strong><small>Build from the work you do today.</small></article>
        </div>
        <div class="tour-screen-foot"><span><i class="tour-capacitor" aria-hidden="true"></i> Existing customer plans keep their own copied steps.</span><span>Illustrative records</span></div>`
    },
    customer: {
      nav: "Implementations",
      title: "Northstar Kitchens · onboarding",
      eyebrow: "CUSTOMER PLAN · FICTIONAL SAMPLE",
      badge: "Waiting on customer",
      tip: "Give both sides a clear place for their next task.",
      detail: "Assign team and customer tasks, request setup information, and track progress in one implementation.",
      scene: `<div class="tour-scene-title"><div><span class="tour-scene-kicker">Implementation <b>· fictional sample</b></span><h3>Northstar Kitchens</h3><p>Customer onboarding · target date is illustrative</p></div><span class="tour-state-chip amber"><i></i> In progress</span></div>
        <div class="tour-implementation-summary"><div class="tour-progress-ring" role="img" aria-label="Illustrative sample implementation, 3 of 5 tasks completed"><svg viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="22"></circle><circle class="tour-progress-arc" cx="27" cy="27" r="22"></circle></svg><strong>3<small>/5</small></strong></div><div><strong>3 of 5 tasks complete</strong><span>Example progress · not a live customer</span></div><span class="tour-preview-action" aria-hidden="true">Open plan <span>↗</span></span></div>
        <div class="tour-task-list"><div><span class="tour-task-check complete">✓</span><span><strong>Kickoff and success criteria</strong><small>Relay team · complete</small></span><span class="tour-task-state">Done</span></div><div><span class="tour-task-check waiting">↗</span><span><strong>Share DNS record</strong><small>Acme IT · requested</small></span><span class="tour-task-state waiting-text">Waiting</span></div><div><span class="tour-task-check">03</span><span><strong>Review connection test</strong><small>Relay team · next step</small></span><span class="tour-task-state">Next</span></div></div>
        <div class="tour-screen-foot"><span><i class="tour-diode" aria-hidden="true"></i> A blocked step can stay visible without becoming a mystery.</span><span>Fictional sample</span></div>`
    },
    readiness: {
      nav: "Readiness",
      title: "A launch review with context",
      eyebrow: "READINESS CHECK · EXAMPLE",
      badge: "Review still needed",
      tip: "Review the recorded checks before calling a launch ready.",
      detail: "Keep success criteria, test and training status, open tasks, and recorded risks in view for your team.",
      scene: `<div class="tour-scene-title"><div><span class="tour-scene-kicker">Launch review <b>· illustrative</b></span><h3>What still needs a look?</h3></div><span class="tour-state-chip blue"><i></i> Team review</span></div>
        <div class="tour-readiness-grid"><article class="tour-readiness-score"><div><span class="tour-readiness-label">CHECKS RECORDED</span><strong>3 <small>of 4</small></strong><p>One check needs a person to review it.</p></div><div class="tour-readiness-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div></article><article class="tour-readiness-checks"><div><span class="tour-check-icon good">✓</span><span><strong>Success criteria recorded</strong><small>Owner · Maya Chen</small></span><em>Ready</em></div><div><span class="tour-check-icon good">✓</span><span><strong>Customer training scheduled</strong><small>Owner · Relay team</small></span><em>Ready</em></div><div><span class="tour-check-icon needs">!</span><span><strong>Connection test reviewed</strong><small>Owner not assigned</small></span><em class="needs">Review</em></div></article></div>
        <div class="tour-screen-foot"><span><i class="tour-fuse" aria-hidden="true"></i> Relay organizes the review; your team makes the launch decision.</span><span>Illustrative records</span></div>`
    }
  };

  document.querySelectorAll("[data-relay-product-tour]").forEach((tour) => {
    const tabs = [...tour.querySelectorAll('[role="tab"][data-tour-view]')];
    const panel = tour.querySelector('[role="tabpanel"]');
    const screen = tour.querySelector(".relay-tour-screen");
    const tipTitle = tour.querySelector(".relay-tour-bottom strong");
    const tipCopy = tour.querySelector(".relay-tour-bottom small");
    if (!tabs.length || !panel || !screen || !tipTitle || !tipCopy) return;

    function selectView(name, focusTab = false) {
      const view = views[name];
      if (!view) return;
      tabs.forEach((tab) => {
        const selected = tab.dataset.tourView === name;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected) {
          panel.setAttribute("aria-labelledby", tab.id);
          if (focusTab) tab.focus();
        }
      });
      const changing = screen.dataset.view !== name;
      if (changing && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        screen.dataset.changing = "true";
        window.setTimeout(() => { screen.dataset.changing = "false"; }, 140);
      }
      screen.dataset.view = name;
      panel.dataset.view = name;
      screen.innerHTML = `<div class="tour-screen-heading"><span class="tour-screen-eyebrow">${view.eyebrow}</span><span class="tour-screen-current"><i aria-hidden="true"></i>${view.nav}</span></div><div class="tour-screen-content"><div class="tour-product-topline"><div><span class="tour-product-breadcrumb">Relay <span>›</span> ${view.nav}</span><h2>${view.title}</h2></div><span class="tour-state-chip ${name === "readiness" ? "blue" : "green"}"><i></i>${view.badge}</span></div>${view.scene}</div>`;
      tipTitle.textContent = view.tip;
      tipCopy.textContent = view.detail;
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectView(tab.dataset.tourView));
      tab.addEventListener("keydown", (event) => {
        const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length
          : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (nextIndex < 0) return;
        event.preventDefault();
        selectView(tabs[nextIndex].dataset.tourView, true);
      });
    });
    selectView("process");
  });
})();
