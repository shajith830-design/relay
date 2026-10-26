"use strict";

const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");
const authForm = document.getElementById("auth-form");
const authTabs = {
  login: document.getElementById("login-tab"),
  signup: document.getElementById("signup-tab")
};
const authStatus = document.getElementById("auth-status");
const globalStatus = document.getElementById("global-status");
const toast = document.getElementById("toast");
const state = {
  authMode: "login",
  inviteToken: new URLSearchParams(window.location.search).get("invite") || "",
  resetToken: new URLSearchParams(window.location.search).get("reset") || "",
  inviteUrl: "",
  user: null,
  workspace: null,
  data: { processes: [], templates: [], implementations: [], requirements: [], members: [], invites: [], role: "member" },
  selectedProcessId: null,
  process: null,
  editingStepId: null,
  selectedImplementationId: null,
  customerTokens: new Map(),
  handoverGuide: ""
};

const titles = {
  overview: ["Your workspace", "Overview"],
  processes: ["Plan your work", "Process map"],
  templates: ["Reuse what works", "Templates"],
  implementations: ["Run customer work", "Implementations"],
  requirements: ["Get customer-ready", "Customer information"]
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch {
    throw new Error("Could not connect to Relay. Check your connection and try again.");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Relay returned an unexpected response. Please try again.");
  }
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function showToast(message, error = false) {
  toast.textContent = message;
  toast.style.background = error ? "#991b1b" : "";
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 3600);
}

function showAuth(message = "") {
  state.user = null;
  state.workspace = null;
  authScreen.hidden = false;
  appShell.hidden = true;
  authStatus.textContent = message;
}

function showProduct() {
  authScreen.hidden = true;
  appShell.hidden = false;
  document.getElementById("workspace-name-display").textContent = state.workspace.name;
  document.getElementById("user-email").textContent = state.user.email;
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.getElementById("password-reset-request").hidden = true;
  document.getElementById("password-reset-complete").hidden = true;
  document.getElementById("auth-form").hidden = false;
  document.getElementById("auth-tabs").hidden = false;
  document.getElementById("forgot-password").hidden = mode !== "login";
  const isSignup = mode === "signup";
  authTabs.login.classList.toggle("active", !isSignup);
  authTabs.signup.classList.toggle("active", isSignup);
  authTabs.login.setAttribute("aria-selected", String(!isSignup));
  authTabs.signup.setAttribute("aria-selected", String(isSignup));
  document.getElementById("workspace-field").hidden = !isSignup || Boolean(state.inviteToken);
  document.getElementById("workspace-name").required = isSignup && !state.inviteToken;
  document.getElementById("auth-password").autocomplete = isSignup ? "new-password" : "current-password";
  document.getElementById("password-hint").textContent = isSignup
    ? "Use at least 12 characters."
    : "Enter your workspace password.";
  authTabs.login.textContent = state.inviteToken ? "Existing account" : "Sign in";
  authTabs.signup.textContent = state.inviteToken ? "New account" : "Create workspace";
  document.getElementById("auth-submit").textContent = isSignup
    ? state.inviteToken ? "Join workspace" : "Create workspace"
    : state.inviteToken ? "Sign in & join" : "Sign in";
  document.getElementById("auth-title").textContent = isSignup
    ? state.inviteToken ? "Join your Relay workspace." : "Start your Relay workspace."
    : state.inviteToken ? "Sign in to join your Relay workspace." : "Make onboarding easier to run.";
  document.getElementById("auth-intro").textContent = state.inviteToken
    ? "Your invitation is ready. Use the invited email address to continue."
    : "Plan your process, guide each customer, and see what needs attention.";
  authStatus.textContent = "";
}

function showPasswordResetPanel(panelId) {
  document.getElementById("auth-tabs").hidden = true;
  document.getElementById("auth-form").hidden = true;
  document.getElementById("forgot-password").hidden = true;
  document.getElementById("password-reset-request").hidden = panelId !== "password-reset-request";
  document.getElementById("password-reset-complete").hidden = panelId !== "password-reset-complete";
}

async function loadWorkspace() {
  const data = await api("/api/product/workspace");
  state.data = data;
  renderWorkspace();
}

function setView(name) {
  if (!titles[name]) return;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  document.getElementById("view-eyebrow").textContent = titles[name][0];
  document.getElementById("view-title").textContent = titles[name][1];
  globalStatus.textContent = "";
  if (name === "processes" && state.selectedProcessId) loadProcess(state.selectedProcessId).catch(showError);
  window.relayRefreshMotion?.();
}

function showError(error) {
  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  globalStatus.textContent = message;
  showToast(message, true);
}

function blockerSummary(implementation) {
  const reasons = [];
  if (implementation.missing_inputs > 0) {
    reasons.push(`Missing or invalid information: ${implementation.missing_input_names}`);
  }
  if (implementation.unowned_steps > 0) {
    reasons.push(`Open tasks without an owner: ${implementation.unowned_step_names}`);
  }
  if (implementation.blocked_steps > 0) reasons.push(`Blocked tasks: ${implementation.blocked_step_names}`);
  if (implementation.overdue_steps > 0) reasons.push(`Overdue tasks: ${implementation.overdue_step_names}`);
  if (implementation.waiting_steps > 0) reasons.push(`Waiting on prerequisites: ${implementation.waiting_step_names}`);
  return reasons.length ? reasons.join(" · ") : "No configured readiness issues detected";
}

function renderOverview() {
  const { implementations, templates, processes } = state.data;
  const needsAttention = implementations.filter((item) => item.missing_inputs > 0 || item.unowned_steps > 0
    || item.blocked_steps > 0 || item.overdue_steps > 0 || item.waiting_steps > 0).length;
  document.getElementById("overview-metrics").innerHTML = [
    ["Implementations", implementations.length, "Customer journeys in progress"],
    ["Templates", templates.length, "Approved workflows ready to reuse"],
    ["Needs attention", needsAttention, "Missing information, blockers, overdue work, or dependencies"]
  ].map(([label, value, detail]) => `<article class="metric"><strong>${value}</strong><span>${escapeHtml(label)} · ${escapeHtml(detail)}</span></article>`).join("");
  document.getElementById("overview-implementations").innerHTML = implementations.length
    ? renderImplementationTable(implementations.slice(0, 6))
    : "";
  const emptyState = document.getElementById("overview-empty");
  emptyState.hidden = implementations.length > 0;
  emptyState.textContent = processes.length === 0
    ? "Start by mapping your onboarding process, then save it as a template."
    : templates.length === 0
      ? "Finish and test a process, then save it as a template to start an implementation."
      : "Choose a template to start your first customer implementation.";
}

function renderImplementationTable(implementations) {
  if (!implementations.length) return '<p class="empty-state">No customer implementations yet. Save a template, then start with your first customer.</p>';
  return `<table class="data-table"><thead><tr><th>Customer</th><th>Template</th><th>Open tasks</th><th>Readiness</th><th></th></tr></thead><tbody>${implementations.map((item) => {
    const attention = item.missing_inputs > 0 || item.unowned_steps > 0 || item.blocked_steps > 0
      || item.overdue_steps > 0 || item.waiting_steps > 0;
    return `<tr><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.template_name)}</td><td>${item.open_steps}</td><td><span class="badge ${attention ? "attention" : "ready"}">${escapeHtml(blockerSummary(item))}</span></td><td><button class="row-button" type="button" data-open-implementation="${item.id}">Open</button></td></tr>`;
  }).join("")}</tbody></table>`;
}

function renderProcesses() {
  const container = document.getElementById("process-list");
  if (!state.data.processes.length) {
    container.innerHTML = '<p class="empty-state">No process maps yet. Start with the steps your team already follows.</p>';
    return;
  }
  container.innerHTML = state.data.processes.map((process) => `
    <div class="list-row ${process.id === state.selectedProcessId ? "selected" : ""}">
      <div><strong>${escapeHtml(process.name)}</strong><small>${escapeHtml(process.description || "Onboarding process")}</small></div>
      <div><button type="button" class="text-button" data-select-process="${process.id}">Open</button> <button type="button" class="text-button" data-delete-process="${process.id}">Delete</button></div>
    </div>`).join("");
}

function renderTeam() {
  document.getElementById("team-member-list").innerHTML = state.data.members.length
    ? state.data.members.map((member) => `<div class="list-row"><strong>${escapeHtml(member.email)}</strong><span class="badge">${escapeHtml(member.role)}</span></div>`).join("")
    : '<p class="empty-state">No workspace members are available.</p>';
  document.getElementById("team-invite-list").innerHTML = state.data.invites.length
    ? state.data.invites.map((invite) => `<div class="list-row"><div><strong>${escapeHtml(invite.invited_email)}</strong><small>Expires ${escapeHtml(invite.expires_at)}</small></div><button class="text-button" type="button" data-revoke-invite="${invite.id}">Revoke</button></div>`).join("")
    : '<p class="empty-state">No pending invitations.</p>';
  const inviteForm = document.getElementById("team-invite-form");
  inviteForm.hidden = state.workspace.role !== "owner";
  const result = document.getElementById("invite-result");
  result.hidden = !state.inviteUrl;
  if (state.inviteUrl) {
    result.innerHTML = `<strong>One-time teammate invitation</strong><br><a href="${escapeHtml(state.inviteUrl)}">${escapeHtml(state.inviteUrl)}</a><br><button class="text-button" type="button" data-copy-invite="${escapeHtml(state.inviteUrl)}">Copy invitation link</button>`;
  }
  const assigneeOptions = state.data.members.map((member) => `<option value="${member.id}">${escapeHtml(member.email)} (${escapeHtml(member.role)})</option>`).join("");
  const processAssignee = document.getElementById("step-assignee");
  processAssignee.innerHTML = `<option value="">Choose a workspace member</option>${assigneeOptions}`;
  if (state.user?.id && state.data.members.some((member) => member.id === state.user.id)) {
    processAssignee.value = String(state.user.id);
  }
}

async function loadProcess(processId) {
  const { process } = await api(`/api/product/processes/${processId}`);
  state.process = process;
  state.selectedProcessId = process.id;
  renderProcesses();
  document.getElementById("process-editor-title").textContent = process.name;
  document.getElementById("process-meta-form").hidden = false;
  document.getElementById("process-edit-name").value = process.name;
  document.getElementById("process-edit-description").value = process.description || "";
  document.getElementById("step-form").hidden = false;
  document.getElementById("process-actions").hidden = false;
  const result = document.getElementById("process-test-result");
  result.hidden = true;
  document.getElementById("step-dependencies").innerHTML = process.steps.map((step) =>
    `<option value="${step.id}" ${step.id === state.editingStepId ? "disabled" : ""}>${escapeHtml(step.title)}</option>`
  ).join("");
  document.getElementById("step-assignee").value = state.user?.id ? String(state.user.id) : "";
  document.getElementById("process-step-list").classList.toggle("empty-state", process.steps.length === 0);
  document.getElementById("process-step-list").innerHTML = process.steps.length
    ? process.steps.map((step, index) => `<article class="step-card">
        <span class="step-number">${index + 1}</span>
        <div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p>
          <small>${escapeHtml(step.stage)} · Role: ${escapeHtml(step.owner || "Not assigned")} · Due ${step.due_offset_days} days after start</small>
          <small>Assigned to: ${escapeHtml(step.assignee_email || "No workspace member assigned")}</small>
          ${step.dependsOn.length ? `<small>Prerequisites: ${escapeHtml(step.dependsOn.map((id) => process.steps.find((item) => item.id === id)?.title || "").filter(Boolean).join(", "))}</small>` : ""}
        </div>
        <div class="button-row">
          <button class="text-button" type="button" data-edit-step="${step.id}">Edit</button>
          <button class="text-button" type="button" data-step-up="${step.id}" ${index === 0 ? "disabled" : ""}>↑</button>
          <button class="text-button" type="button" data-step-down="${step.id}" ${index === process.steps.length - 1 ? "disabled" : ""}>↓</button>
          <button class="text-button" type="button" data-delete-step="${step.id}">Delete</button>
        </div>
      </article>`).join("")
    : "Add the first step to start mapping this customer journey.";
  const templateScope = document.getElementById("requirement-template");
  const selectedScope = templateScope.value;
  templateScope.innerHTML = '<option value="">Every implementation</option>' + state.data.templates
    .map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  if ([...templateScope.options].some((option) => option.value === selectedScope)) templateScope.value = selectedScope;
  window.relayRefreshMotion?.();
}

function renderTemplates() {
  const container = document.getElementById("template-list");
  const select = document.getElementById("implementation-template");
  const requirementTemplate = document.getElementById("requirement-template");
  select.innerHTML = '<option value="">Choose a template</option>' + state.data.templates
    .map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  requirementTemplate.innerHTML = '<option value="">Every implementation</option>' + state.data.templates
    .map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  if (!state.data.templates.length) {
    container.innerHTML = '<p class="empty-state">Your reusable templates will appear here. First map and test a process.</p>';
    return;
  }
  container.innerHTML = state.data.templates.map((template) => `
    <article class="template-card">
      <span class="badge ready">Reusable workflow</span>
      <form data-edit-template="${template.id}">
        <label for="template-name-${template.id}">Template name</label>
        <input id="template-name-${template.id}" name="name" maxlength="100" value="${escapeHtml(template.name)}" required>
        <p>${template.step_count} process steps · Revision ${template.revision}</p>
        <p>Starting an implementation copies this version into an independent customer work plan.</p>
        <button class="button secondary" type="submit">Save name</button>
      </form>
      <button class="text-button" type="button" data-refresh-template="${template.id}">Refresh from tested process</button>
      <details data-template-history="${template.id}">
        <summary>Version history</summary>
        <button class="text-button" type="button" data-load-template-versions="${template.id}">Load versions</button>
        <ol data-template-version-list="${template.id}"></ol>
      </details>
      <button class="text-button" type="button" data-delete-template="${template.id}">Delete template</button>
      <button class="button secondary" type="button" data-start-template="${template.id}">Use template</button>
    </article>`).join("");
}

function renderImplementations() {
  document.getElementById("implementation-list").innerHTML = renderImplementationTable(state.data.implementations);
}

function renderRequirements() {
  const container = document.getElementById("requirement-list");
  if (!state.data.requirements.length) {
    container.innerHTML = '<p class="empty-state">Add the specific information needed to configure your product for a customer.</p>';
    return;
  }
  container.innerHTML = state.data.requirements.map((requirement) => `
    <form class="info-row" data-edit-requirement="${requirement.id}">
      <label for="requirement-name-${requirement.id}">Request name</label>
      <input id="requirement-name-${requirement.id}" name="name" maxlength="120" value="${escapeHtml(requirement.name)}" required>
      <label for="requirement-description-${requirement.id}">Instructions</label>
      <textarea id="requirement-description-${requirement.id}" name="description" maxlength="500">${escapeHtml(requirement.description || "")}</textarea>
      <label for="requirement-type-${requirement.id}">Response type</label>
      <select id="requirement-type-${requirement.id}" name="inputType">
        ${["text", "email", "url", "number", "date"].map((type) => `<option value="${type}" ${requirement.input_type === type ? "selected" : ""}>${type === "url" ? "Website URL" : type[0].toUpperCase() + type.slice(1)}</option>`).join("")}
      </select>
      <label class="check-field"><input type="checkbox" name="required" ${requirement.required ? "checked" : ""}> Required</label>
      <small>${requirement.template_id ? `Applies to ${escapeHtml(state.data.templates.find((template) => template.id === requirement.template_id)?.name || "selected template")}` : "Applies to every implementation"}</small>
      <div class="button-row"><button class="button secondary" type="submit">Save request</button><button class="text-button" type="button" data-delete-requirement="${requirement.id}">Delete</button></div>
    </form>`).join("");
}

function renderWorkspace() {
  renderOverview();
  renderProcesses();
  renderTemplates();
  renderImplementations();
  renderRequirements();
  renderTeam();
  window.relayRefreshMotion?.();
}

async function openImplementation(implementationId) {
  const { implementation } = await api(`/api/product/implementations/${implementationId}`);
  state.selectedImplementationId = implementation.id;
  const panel = document.getElementById("implementation-detail");
  panel.hidden = false;
  document.getElementById("implementation-detail-title").textContent = implementation.customer_name;
  document.getElementById("implementation-detail-subtitle").textContent = `Started from ${implementation.template_name}`;
  document.getElementById("implementation-step-list").innerHTML = implementation.steps.length
    ? implementation.steps.map((step, index) => `
      <article class="step-card">
        <span class="step-number">${index + 1}</span>
        <div class="task-main"><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p>
          <small>${escapeHtml(step.stage)} · Role: ${escapeHtml(step.owner || "Not assigned")} · Due ${escapeHtml(step.due_at || "not scheduled")}</small>
          <small>Assigned to: ${escapeHtml(step.assignee_email || "No workspace member assigned")}</small>
          ${step.waiting_on ? `<small>Waiting on: ${escapeHtml(step.waiting_on)}</small>` : ""}
          ${step.is_blocked ? `<p class="status warning"><strong>Blocked:</strong> ${escapeHtml(step.blocker_reason)}<br><strong>Next action:</strong> ${escapeHtml(step.blocker_next_action)}</p>` : ""}
        </div>
        <div class="task-controls">
          <label>Status
            <select class="status-select" data-step-status="${step.id}" aria-label="Status for ${escapeHtml(step.title)}">
              <option value="not_started" ${step.status === "not_started" ? "selected" : ""}>Not started</option>
              <option value="in_progress" ${step.status === "in_progress" ? "selected" : ""}>In progress</option>
              <option value="done" ${step.status === "done" ? "selected" : ""}>Done</option>
            </select>
          </label>
          <label>Responsible role<input data-task-owner="${step.id}" maxlength="120" value="${escapeHtml(step.owner)}"></label>
          <label>Assigned member
            <select data-task-assignee="${step.id}">
              <option value="">Unassigned</option>
              ${state.data.members.map((member) => `<option value="${member.id}" ${member.id === step.assignee_user_id ? "selected" : ""}>${escapeHtml(member.email)}</option>`).join("")}
            </select>
          </label>
          <label>Due date<input data-task-due="${step.id}" type="date" value="${escapeHtml(step.due_at)}"></label>
          <label class="check-field"><input data-task-blocked="${step.id}" type="checkbox" ${step.is_blocked ? "checked" : ""}> Blocked</label>
          <label>Blocker reason<textarea data-task-reason="${step.id}" maxlength="500">${escapeHtml(step.blocker_reason)}</textarea></label>
          <label>Next action<textarea data-task-action="${step.id}" maxlength="500">${escapeHtml(step.blocker_next_action)}</textarea></label>
          <button class="button secondary" type="button" data-save-task="${step.id}">Save task details</button>
        </div>
      </article>`).join("")
    : '<p class="empty-state">This implementation has no work steps. Start a new one from a template with steps.</p>';
  document.getElementById("implementation-requirements").innerHTML = implementation.requirements.length
    ? implementation.requirements.map((requirement) => `
      <article class="info-row"><strong>${escapeHtml(requirement.name)}</strong>
        <p>${escapeHtml(requirement.description || "No extra instructions.")}</p>
        <span class="badge ${requirement.value.trim() ? "ready" : requirement.required ? "attention" : ""}">${requirement.value.trim() ? "Received" : requirement.required ? "Required · not received" : "Optional · not received"}</span>
        ${requirement.value ? `<p>${escapeHtml(requirement.value)}</p>` : ""}
      </article>`).join("")
    : '<p class="empty-state">No customer information has been requested yet. Add requirements to share them with this customer.</p>';
  const token = state.customerTokens.get(implementation.id);
  const linkBox = document.getElementById("customer-link-box");
  linkBox.hidden = false;
  if (token) {
    const link = `${window.location.origin}/customer.html?token=${encodeURIComponent(token)}`;
    linkBox.innerHTML = `<strong>Private customer information link</strong><br><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a><br><button class="text-button" type="button" data-copy-link="${escapeHtml(link)}">Copy link</button> · <button class="text-button" type="button" data-create-customer-link>Rotate customer link</button><br>Anyone with this link can submit the requested setup information. Keep it private.`;
  } else if (implementation.has_customer_link) {
    linkBox.innerHTML = `<strong>Customer information link already created</strong><br>For security, Relay does not show the existing link again. Creating a replacement will invalidate the previous link.<br><button class="text-button" type="button" data-create-customer-link>Rotate customer link</button>`;
  } else {
    linkBox.innerHTML = `<strong>Customer information link</strong><br>Create a private link for this customer to submit the information you requested.<br><button class="text-button" type="button" data-create-customer-link>Create customer link</button>`;
  }
  window.relayRefreshMotion?.();
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function refreshWorkspace() {
  await loadWorkspace();
  if (state.selectedImplementationId && !document.getElementById("implementation-detail").hidden) {
    await openImplementation(state.selectedImplementationId);
  }
}

authTabs.login.addEventListener("click", () => setAuthMode("login"));
authTabs.signup.addEventListener("click", () => setAuthMode("signup"));
document.getElementById("forgot-password").addEventListener("click", () => {
  document.getElementById("reset-email").value = document.getElementById("auth-email").value;
  showPasswordResetPanel("password-reset-request");
});
document.getElementById("back-to-sign-in").addEventListener("click", () => setAuthMode("login"));

document.getElementById("password-reset-request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("password-reset-request-status");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  status.textContent = "Requesting recovery link...";
  try {
    const result = await api("/api/product/auth/password-reset/request", {
      method: "POST",
      body: { email: document.getElementById("reset-email").value }
    });
    status.textContent = result.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("password-reset-complete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("password-reset-complete-status");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const password = document.getElementById("reset-password").value;
  if (password !== document.getElementById("reset-password-confirm").value) {
    status.textContent = "The passwords do not match.";
    return;
  }
  button.disabled = true;
  status.textContent = "Updating password...";
  try {
    const result = await api("/api/product/auth/password-reset/complete", {
      method: "POST",
      body: {
        token: state.resetToken,
        password
      }
    });
    state.resetToken = "";
    window.history.replaceState(null, "", window.location.pathname);
    event.currentTarget.reset();
    setAuthMode("login");
    authStatus.textContent = result.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authStatus.textContent = "";
  const form = new FormData(authForm);
  const endpoint = state.authMode === "signup" ? "/api/product/auth/signup" : "/api/product/auth/login";
  const button = document.getElementById("auth-submit");
  button.disabled = true;
  try {
    const data = await api(endpoint, {
      method: "POST",
      body: {
        email: form.get("email"),
        password: form.get("password"),
        workspaceName: form.get("workspaceName"),
        inviteToken: state.inviteToken || undefined
      }
    });
    state.user = data.user;
    state.workspace = data.workspace;
    if (state.inviteToken) {
      state.inviteToken = "";
      window.history.replaceState(null, "", window.location.pathname);
    }
    showProduct();
    await loadWorkspace();
  } catch (error) {
    authStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("team-invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { invite } = await api("/api/product/invites", {
      method: "POST",
      body: { email: document.getElementById("invite-email").value }
    });
    state.inviteUrl = invite.inviteUrl;
    event.target.reset();
    await loadWorkspace();
    showToast("Invitation link created. Share it securely with the invited teammate.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("team-invite-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke-invite]");
  if (!button || !window.confirm("Revoke this pending invitation?")) return;
  try {
    await api(`/api/product/invites/${button.dataset.revokeInvite}`, { method: "DELETE" });
    state.inviteUrl = "";
    await loadWorkspace();
    showToast("Invitation revoked.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("invite-result").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-invite]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copyInvite);
    showToast("Invitation link copied.");
  } catch {
    showToast("Copy was blocked by the browser. Select and copy the invitation link.", true);
  }
});

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.go)));
document.getElementById("refresh-button").addEventListener("click", () => refreshWorkspace().catch(showError));
document.getElementById("signout-button").addEventListener("click", async () => {
  try {
    await api("/api/product/auth/logout", { method: "POST", body: {} });
    showAuth("You have signed out.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("process-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("process-name").value;
  const description = document.getElementById("process-description").value;
  try {
    const { process } = await api("/api/product/processes", { method: "POST", body: { name, description } });
    event.target.reset();
    await loadWorkspace();
    await loadProcess(process.id);
    showToast("Process map created.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("process-list").addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-select-process]");
  if (openButton) {
    state.editingStepId = null;
    loadProcess(openButton.dataset.selectProcess).catch(showError);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-process]");
  if (!deleteButton || !window.confirm("Delete this process map? Saved templates must be deleted first.")) return;
  api(`/api/product/processes/${deleteButton.dataset.deleteProcess}`, { method: "DELETE" })
    .then(async () => {
      if (state.selectedProcessId === Number(deleteButton.dataset.deleteProcess)) {
        state.selectedProcessId = null;
        state.process = null;
        document.getElementById("process-meta-form").hidden = true;
        document.getElementById("step-form").hidden = true;
        document.getElementById("process-actions").hidden = true;
        document.getElementById("process-editor-title").textContent = "Select a process";
        document.getElementById("process-step-list").textContent = "Choose a process map or create one to begin.";
      }
      await loadWorkspace();
      showToast("Process map deleted.");
    })
    .catch(showError);
});

document.getElementById("process-meta-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedProcessId) return;
  try {
    await api(`/api/product/processes/${state.selectedProcessId}`, {
      method: "PATCH",
      body: {
        name: document.getElementById("process-edit-name").value,
        description: document.getElementById("process-edit-description").value
      }
    });
    await loadWorkspace();
    await loadProcess(state.selectedProcessId);
    showToast("Process details saved.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("step-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedProcessId) return showError(new Error("Choose a process before adding a step."));
  try {
    await api(`/api/product/processes/${state.selectedProcessId}/steps${state.editingStepId ? `/${state.editingStepId}` : ""}`, {
      method: state.editingStepId ? "PATCH" : "POST",
      body: {
        title: document.getElementById("step-title").value,
        description: document.getElementById("step-description").value,
        owner: document.getElementById("step-owner").value,
        assigneeUserId: document.getElementById("step-assignee").value || null,
        stage: document.getElementById("step-stage").value,
        dueOffsetDays: Number(document.getElementById("step-due-offset").value),
        dependsOn: [...document.getElementById("step-dependencies").selectedOptions].map((option) => Number(option.value))
      }
    });
    state.editingStepId = null;
    event.target.reset();
    document.getElementById("step-stage").value = "Implementation";
    document.getElementById("step-due-offset").value = "0";
    document.getElementById("step-submit").textContent = "Add step";
    document.getElementById("cancel-step-edit").hidden = true;
    await loadProcess(state.selectedProcessId);
    await loadWorkspace();
    showToast("Process step saved.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("cancel-step-edit").addEventListener("click", () => {
  state.editingStepId = null;
  const form = document.getElementById("step-form");
  form.reset();
  document.getElementById("step-stage").value = "Implementation";
  document.getElementById("step-due-offset").value = "0";
  document.getElementById("step-submit").textContent = "Add step";
  document.getElementById("cancel-step-edit").hidden = true;
  if (state.selectedProcessId) loadProcess(state.selectedProcessId).catch(showError);
});

document.getElementById("process-step-list").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-step]");
  if (edit && state.process) {
    const step = state.process.steps.find((item) => item.id === Number(edit.dataset.editStep));
    if (!step) return;
    state.editingStepId = step.id;
    document.getElementById("step-title").value = step.title;
    document.getElementById("step-description").value = step.description;
    document.getElementById("step-owner").value = step.owner;
    document.getElementById("step-assignee").value = step.assignee_user_id ? String(step.assignee_user_id) : "";
    document.getElementById("step-stage").value = step.stage;
    document.getElementById("step-due-offset").value = step.due_offset_days;
    [...document.getElementById("step-dependencies").options].forEach((option) => {
      option.disabled = Number(option.value) === step.id;
      option.selected = step.dependsOn.includes(Number(option.value));
    });
    document.getElementById("step-submit").textContent = "Save step";
    document.getElementById("cancel-step-edit").hidden = false;
    document.getElementById("step-form").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const deleteStep = event.target.closest("[data-delete-step]");
  if (deleteStep) {
    if (!window.confirm("Delete this process step? Its prerequisite links will also be removed.")) return;
    try {
      await api(`/api/product/processes/${state.selectedProcessId}/steps/${deleteStep.dataset.deleteStep}`, { method: "DELETE" });
      state.editingStepId = null;
      await loadProcess(state.selectedProcessId);
      await loadWorkspace();
      showToast("Process step deleted.");
    } catch (error) {
      showError(error);
    }
    return;
  }
  const move = event.target.closest("[data-step-up], [data-step-down]");
  if (move && state.process) {
    const stepId = Number(move.dataset.stepUp || move.dataset.stepDown);
    const ordered = state.process.steps.map((step) => step.id);
    const index = ordered.indexOf(stepId);
    const nextIndex = move.hasAttribute("data-step-up") ? index - 1 : index + 1;
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    try {
      await api(`/api/product/processes/${state.selectedProcessId}/steps/order`, {
        method: "PUT",
        body: { stepIds: ordered }
      });
      await loadProcess(state.selectedProcessId);
      await loadWorkspace();
    } catch (error) {
      showError(error);
    }
  }
});

document.getElementById("delete-process").addEventListener("click", () => {
  const button = document.querySelector(`[data-delete-process="${state.selectedProcessId}"]`);
  button?.click();
});

document.getElementById("test-process").addEventListener("click", async () => {
  if (!state.selectedProcessId) return showError(new Error("Choose a process to test."));
  try {
    const { check, findings, stepsChecked, handover } = await api(`/api/product/processes/${state.selectedProcessId}/test`, {
      method: "POST",
      body: {}
    });
    const result = document.getElementById("process-test-result");
    result.hidden = false;
    result.classList.toggle("warning", check.result !== "ready");
    state.handoverGuide = check.result === "ready"
      ? `Relay team handover guide\n${document.getElementById("process-editor-title").textContent}\n\n${handover.map((step) => `${step.number}. ${step.title} [${step.stage}]\n   Responsible role: ${step.owner}\n   Due: ${step.dueOffsetDays} days after start\n   Prerequisites: ${step.dependsOn.join(", ") || "None"}\n   Instructions: ${step.description}`).join("\n\n")}`
      : "";
    result.innerHTML = check.result === "ready"
      ? `Workflow check passed: ${stepsChecked} steps have instructions, responsible roles, valid prerequisites, and an ordered schedule.<ol>${handover.map((step) => `<li><strong>${escapeHtml(step.title)}</strong> — ${escapeHtml(step.stage)} · ${escapeHtml(step.owner)} · due ${step.dueOffsetDays} days after start<br>${escapeHtml(step.description)}${step.dependsOn.length ? `<br>After: ${escapeHtml(step.dependsOn.join(", "))}` : ""}</li>`).join("")}</ol><button class="text-button" type="button" data-copy-handover>Copy handover guide</button>`
      : `<strong>Setup needs attention.</strong><ul>${findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul>`;
    showToast(check.result === "ready" ? "Setup check passed." : "Setup check found items to fix.", check.result !== "ready");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("save-template").addEventListener("click", async () => {
  if (!state.selectedProcessId) return showError(new Error("Choose a process to save."));
  const processName = document.getElementById("process-editor-title").textContent;
  try {
    await api("/api/product/templates", {
      method: "POST",
      body: { processId: state.selectedProcessId, name: `${processName} template` }
    });
    await loadWorkspace();
    setView("templates");
    showToast("Reusable template saved.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("template-list").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-edit-template]");
  if (!form) return;
  event.preventDefault();
  try {
    const data = new FormData(form);
    await api(`/api/product/templates/${form.dataset.editTemplate}`, {
      method: "PATCH",
      body: { name: data.get("name") }
    });
    await loadWorkspace();
    showToast("Template name saved.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("template-list").addEventListener("click", async (event) => {
  const startButton = event.target.closest("[data-start-template]");
  if (startButton) {
    setView("implementations");
    document.getElementById("implementation-template").value = startButton.dataset.startTemplate;
    document.getElementById("implementation-customer").focus();
    return;
  }
  const historyButton = event.target.closest("[data-load-template-versions]");
  if (historyButton) {
    try {
      const { versions } = await api(`/api/product/templates/${historyButton.dataset.loadTemplateVersions}/versions`);
      const versionList = document.querySelector(`[data-template-version-list="${historyButton.dataset.loadTemplateVersions}"]`);
      versionList.innerHTML = versions.map((version) => `
        <li>Revision ${version.revision}: ${escapeHtml(version.name)} — ${escapeHtml(version.steps.join(", "))}
          ${version.revision !== state.data.templates.find((item) => item.id === Number(historyButton.dataset.loadTemplateVersions))?.revision
            ? `<button class="text-button" type="button" data-restore-template="${historyButton.dataset.loadTemplateVersions}" data-revision="${version.revision}">Restore</button>`
            : "(current)"}
        </li>`).join("");
    } catch (error) {
      showError(error);
    }
    return;
  }
  const restoreButton = event.target.closest("[data-restore-template]");
  if (restoreButton) {
    if (!window.confirm(`Restore revision ${restoreButton.dataset.revision}? This creates a new current revision.`)) return;
    try {
      await api(`/api/product/templates/${restoreButton.dataset.restoreTemplate}/versions/${restoreButton.dataset.revision}/restore`, {
        method: "POST",
        body: {}
      });
      await loadWorkspace();
      showToast("Template version restored as a new revision.");
    } catch (error) {
      showError(error);
    }
    return;
  }
  const refreshButton = event.target.closest("[data-refresh-template]");
  if (refreshButton) {
    const template = state.data.templates.find((item) => item.id === Number(refreshButton.dataset.refreshTemplate));
    const name = refreshButton.closest(".template-card").querySelector(`[name="name"]`).value;
    try {
      await api(`/api/product/templates/${refreshButton.dataset.refreshTemplate}`, {
        method: "PATCH",
        body: { name, refreshFromProcess: true }
      });
      await loadWorkspace();
      showToast(`Template refreshed from its tested process. Existing customer work is unchanged.`);
    } catch (error) {
      showError(error);
    }
    return;
  }
  const deleteButton = event.target.closest("[data-delete-template]");
  if (deleteButton) {
    if (!window.confirm("Delete this template? Existing implementations cannot be deleted with it.")) return;
    try {
      await api(`/api/product/templates/${deleteButton.dataset.deleteTemplate}`, { method: "DELETE" });
      await loadWorkspace();
      showToast("Template deleted.");
    } catch (error) {
      showError(error);
    }
  }
});

document.getElementById("implementation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { implementation, customerPortalToken } = await api("/api/product/implementations", {
      method: "POST",
      body: {
        customerName: document.getElementById("implementation-customer").value,
        templateId: document.getElementById("implementation-template").value
      }
    });
    state.customerTokens.set(implementation.id, customerPortalToken);
    event.target.reset();
    await loadWorkspace();
    setView("implementations");
    await openImplementation(implementation.id);
    showToast("Implementation started. Copy its private customer link.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("implementation-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-implementation]");
  if (button) openImplementation(button.dataset.openImplementation).catch(showError);
});
document.getElementById("overview-implementations").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-implementation]");
  if (button) {
    setView("implementations");
    openImplementation(button.dataset.openImplementation).catch(showError);
  }
});
document.getElementById("close-implementation").addEventListener("click", () => {
  state.selectedImplementationId = null;
  document.getElementById("implementation-detail").hidden = true;
});
document.getElementById("implementation-step-list").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-step-status]");
  if (!select || !state.selectedImplementationId) return;
  select.disabled = true;
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/steps/${select.dataset.stepStatus}`, {
      method: "PATCH",
      body: { status: select.value }
    });
    await refreshWorkspace();
    showToast("Task status updated.");
  } catch (error) {
    showError(error);
    await openImplementation(state.selectedImplementationId).catch(showError);
  } finally {
    select.disabled = false;
  }
});

document.getElementById("implementation-step-list").addEventListener("click", async (event) => {
  const save = event.target.closest("[data-save-task]");
  if (!save || !state.selectedImplementationId) return;
  const stepId = save.dataset.saveTask;
  const root = save.closest(".step-card");
  save.disabled = true;
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/steps/${stepId}`, {
      method: "PATCH",
      body: {
        owner: root.querySelector(`[data-task-owner="${stepId}"]`).value,
        assigneeUserId: root.querySelector(`[data-task-assignee="${stepId}"]`).value || null,
        dueAt: root.querySelector(`[data-task-due="${stepId}"]`).value,
        isBlocked: root.querySelector(`[data-task-blocked="${stepId}"]`).checked,
        blockerReason: root.querySelector(`[data-task-reason="${stepId}"]`).value,
        blockerNextAction: root.querySelector(`[data-task-action="${stepId}"]`).value
      }
    });
    await refreshWorkspace();
    showToast("Task details saved.");
  } catch (error) {
    showError(error);
    await openImplementation(state.selectedImplementationId).catch(showError);
  } finally {
    save.disabled = false;
  }
});

document.getElementById("requirement-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/product/requirements", {
      method: "POST",
      body: {
        name: document.getElementById("requirement-name").value,
        description: document.getElementById("requirement-description").value,
        required: document.getElementById("requirement-required").checked,
        templateId: document.getElementById("requirement-template").value || null,
        inputType: document.getElementById("requirement-type").value
      }
    });
    event.target.reset();
    document.getElementById("requirement-required").checked = true;
    await loadWorkspace();
    showToast("Customer information request added.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("requirement-list").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-edit-requirement]");
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    await api(`/api/product/requirements/${form.dataset.editRequirement}`, {
      method: "PATCH",
      body: {
        name: data.get("name"),
        description: data.get("description"),
        inputType: data.get("inputType"),
        required: data.has("required")
      }
    });
    await refreshWorkspace();
    showToast("Customer information request saved.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("requirement-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-requirement]");
  if (!button || !window.confirm("Delete this request and its saved customer responses?")) return;
  try {
    await api(`/api/product/requirements/${button.dataset.deleteRequirement}`, { method: "DELETE" });
    await refreshWorkspace();
    showToast("Customer information request deleted.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("customer-link-box").addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy-link]");
  if (copyButton) {
    const link = copyButton.dataset.copyLink;
    try {
      await navigator.clipboard.writeText(link);
      showToast("Customer link copied.");
    } catch {
      showToast("Copy was blocked by the browser. Select and copy the link.", true);
    }
    return;
  }
  const createButton = event.target.closest("[data-create-customer-link]");
  if (!createButton || !state.selectedImplementationId) return;
  try {
    const result = await api(`/api/product/implementations/${state.selectedImplementationId}/customer-link`, {
      method: "POST",
      body: {}
    });
    state.customerTokens.set(state.selectedImplementationId, result.customerPortalToken);
    await openImplementation(state.selectedImplementationId);
    showToast("New private customer link created. The previous link is no longer valid.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("process-test-result").addEventListener("click", async (event) => {
  if (!event.target.closest("[data-copy-handover]") || !state.handoverGuide) return;
  try {
    await navigator.clipboard.writeText(state.handoverGuide);
    showToast("Handover guide copied.");
  } catch {
    showToast("Copy was blocked by the browser. Select and copy the handover guide.", true);
  }
});

async function initialize() {
  showAuth();
  if (state.resetToken) {
    window.history.replaceState(null, "", window.location.pathname);
    showPasswordResetPanel("password-reset-complete");
    return;
  }
  setAuthMode(state.inviteToken ? "signup" : "login");
  try {
    const session = await api("/api/product/me");
    state.user = session.user;
    state.workspace = session.workspace;
    showProduct();
    await loadWorkspace();
  } catch (error) {
    if (error.message !== "Sign in to continue." && !error.message.startsWith("Your session expired.")) {
      authStatus.textContent = error.message;
    }
  }
}

initialize();
