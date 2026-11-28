"use strict";

(() => {
  const components = {
    relay: {
      number: "01",
      name: "Electromechanical relay",
      fact: "Current through a coil creates a magnetic field that moves an armature and changes contacts. A relay can use one circuit to switch another; designs differ.",
      translation: "Relay gives a handoff a visible next step and an owner. The app passes no current and moves no electrical contact.",
      status: "Relay selected · a coil moves contacts between circuits.",
      position: "12.5%",
      progress: "162"
    },
    switch: {
      number: "02",
      name: "Switch",
      fact: "A switch changes the continuity of a path: depending on its design, it opens or closes the path when operated.",
      translation: "Task statuses show what people recorded as open, in progress, or complete. They change workflow records, not an electrical path.",
      status: "Switch selected · it opens or closes a circuit path.",
      position: "37.5%",
      progress: "324"
    },
    led: {
      number: "03",
      name: "Light-emitting diode",
      fact: "An LED emits light when current flows in its forward direction. A real circuit must limit current appropriately for the LED and its supply.",
      translation: "Relay’s visual status indicators reflect workspace information. They are not sensors and do not monitor a customer's external systems.",
      status: "LED selected · light is visible output, with proper current limiting.",
      position: "62.5%",
      progress: "486"
    },
    fuse: {
      number: "04",
      name: "Fuse",
      fact: "A conventional fuse is designed to interrupt a circuit when current exceeds its rating for long enough. Select it for the specific circuit; after it operates, it generally needs replacement.",
      translation: "A blocker flag is a cue for a person to review the work. Relay does not cut power, shut down software, or certify an external system as safe.",
      status: "Fuse selected · overcurrent protection depends on the specific circuit.",
      position: "87.5%",
      progress: "648"
    }
  };

  document.querySelectorAll("[data-component-lab]").forEach((lab) => {
    const tabs = [...lab.querySelectorAll('[role="tab"][data-component-part]')];
    const panel = lab.querySelector('[role="tabpanel"]');
    const title = lab.querySelector("#component-explainer-title");
    const fact = lab.querySelector("#component-explainer-fact");
    const translation = lab.querySelector("#component-explainer-translation");
    const kicker = lab.querySelector("#component-explainer-kicker");
    const status = lab.querySelector("#component-board-status");
    if (!tabs.length || !panel || !title || !fact || !translation || !kicker || !status) return;

    function selectPart(key, focusTab = false) {
      const part = components[key];
      if (!part) return;
      lab.dataset.part = key;
      lab.style.setProperty("--component-run", part.position);
      lab.style.setProperty("--component-progress", part.progress);
      tabs.forEach((tab) => {
        const selected = tab.dataset.componentPart === key;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focusTab) tab.focus();
      });
      const activeTab = tabs.find((tab) => tab.dataset.componentPart === key);
      panel.setAttribute("aria-labelledby", activeTab.id);
      kicker.textContent = `COMPONENT ${part.number} · ELECTRICAL REFERENCE`;
      title.textContent = part.name;
      fact.textContent = part.fact;
      translation.textContent = part.translation;
      status.textContent = part.status;
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectPart(tab.dataset.componentPart));
      tab.addEventListener("keydown", (event) => {
        const target = event.key === "ArrowRight" ? (index + 1) % tabs.length
          : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (target < 0) return;
        event.preventDefault();
        selectPart(tabs[target].dataset.componentPart, true);
      });
    });
    selectPart("relay");
  });
})();
