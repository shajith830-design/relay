"use strict";

const token = new URLSearchParams(window.location.search).get("token") || "";
const form = document.getElementById("customer-form");
const status = document.getElementById("customer-status");
const loading = document.getElementById("customer-loading");
let requirements = [];
let customerTasks = [];

function renderPortalProgress(data) {
  const progress = document.getElementById("customer-progress");
  progress.hidden = !customerTasks.length;
  document.getElementById("customer-progress-label").textContent =
    data.progress === null ? "Your implementation steps will appear here when the team shares them."
      : `${data.progress}% complete across the customer-facing work.`;
  document.getElementById("customer-progress-bar").value = data.progress || 0;
  document.getElementById("customer-milestones").innerHTML = (data.milestones || []).map((milestone) => `
    <div class="customer-milestone"><strong>${escapeHtml(milestone.name)}</strong>
      <span>${milestone.completed} of ${milestone.total} complete</span>
    </div>`).join("");
  const section = document.getElementById("customer-tasks-section");
  section.hidden = !customerTasks.length;
  document.getElementById("customer-tasks").innerHTML = customerTasks.map((task) => `
    <article class="customer-task">
      <div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.description || "")}</p>
        <small>${escapeHtml(task.stage)}${task.due_at ? ` · Due ${escapeHtml(task.due_at)}` : ""}</small>
        ${task.waiting ? '<small class="customer-waiting">Waiting for a prerequisite step.</small>' : ""}
      </div>
      ${task.status === "done"
        ? '<span class="badge ready">Complete</span>'
        : `<button class="button secondary" type="button" data-complete-customer-task="${task.id}" ${task.waiting ? "disabled" : ""}>Mark complete</button>`}
    </article>`).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function request(url, options) {
  if (window.relayWorkspaceDemo) return window.relayWorkspaceDemo.request(url, options);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch {
    throw new Error("Could not connect. Check your connection and try again.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || "The request could not be completed.");
  return result;
}

async function loadRequest() {
  const validToken = window.relayWorkspaceDemo
    ? /^local-demo-[A-Za-z0-9_-]+$/.test(token)
    : /^[A-Za-z0-9_-]{40,60}$/.test(token);
  if (!validToken) throw new Error("This customer link is missing or invalid.");
  const data = await request(`/api/product/customer/${encodeURIComponent(token)}`);
  requirements = data.requirements;
  customerTasks = data.tasks || [];
  document.getElementById("customer-title").textContent = `Setup information for ${data.customerName}`;
  renderPortalProgress(data);
  const fields = document.getElementById("customer-fields");
  if (!requirements.length) {
    fields.innerHTML = '<p class="empty-state">Your implementation team has not requested any information yet.</p>';
  } else {
    fields.innerHTML = requirements.map((requirement) => `
      <div class="field">
        <label for="customer-input-${requirement.id}">${escapeHtml(requirement.name)}${requirement.required ? " *" : " (optional)"}</label>
        ${requirement.input_type === "text"
          ? `<textarea id="customer-input-${requirement.id}" data-requirement="${requirement.id}" maxlength="2000" ${requirement.required ? "required" : ""} placeholder="Enter the requested information">${escapeHtml(requirement.value)}</textarea>`
          : `<input id="customer-input-${requirement.id}" data-requirement="${requirement.id}" type="${requirement.input_type === "url" ? "url" : requirement.input_type}" maxlength="2000" ${requirement.required ? "required" : ""} value="${escapeHtml(requirement.value)}" placeholder="Enter the requested information">`}
        ${requirement.description ? `<small>${escapeHtml(requirement.description)}</small>` : ""}
      </div>`).join("");
  }
  loading.hidden = true;
  form.hidden = false;
}

document.getElementById("customer-tasks").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-complete-customer-task]");
  if (!button) return;
  button.disabled = true;
  status.textContent = "";
  const currentValues = new Map(
    [...form.querySelectorAll("[data-requirement]")].map((field) => [field.dataset.requirement, field.value])
  );
  try {
    await request(`/api/product/customer/${encodeURIComponent(token)}`, {
      method: "POST",
      body: { inputs: [], completedStepIds: [Number(button.dataset.completeCustomerTask)] }
    });
    await loadRequest();
    for (const field of form.querySelectorAll("[data-requirement]")) {
      if (currentValues.has(field.dataset.requirement)) field.value = currentValues.get(field.dataset.requirement);
    }
    status.textContent = "Your task was marked complete.";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  const inputs = [...form.querySelectorAll("[data-requirement]")].map((field) => ({
    requirementId: Number(field.dataset.requirement),
    value: field.value
  }));
  const missing = requirements.find((requirement) => requirement.required
    && !inputs.find((input) => input.requirementId === requirement.id)?.value.trim());
  if (missing) {
    status.textContent = `Please complete “${missing.name}” before sending.`;
    document.getElementById(`customer-input-${missing.id}`).focus();
    return;
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await request(`/api/product/customer/${encodeURIComponent(token)}`, { method: "POST", body: { inputs } });
    form.hidden = true;
    document.getElementById("customer-success").hidden = false;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

loadRequest().catch((error) => {
  loading.textContent = error.message;
  loading.classList.add("error");
});
