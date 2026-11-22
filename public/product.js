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
const isRayDemo = new URLSearchParams(window.location.search).get("demo") === "ray";
const isWorkspaceDemo = Boolean(window.relayWorkspaceDemo);
let appearanceSaveQueue = Promise.resolve();
let subscriptionExpiryTimer;
let processLoadRequestId = 0;
const state = {
  authMode: "login",
  inviteToken: new URLSearchParams(window.location.search).get("invite") || "",
  resetToken: new URLSearchParams(window.location.search).get("reset") || "",
  inviteUrl: "",
  user: null,
  workspace: null,
  data: { processes: [], templates: [], implementations: [], requirements: [], members: [], invites: [], teamWorkload: [], integrations: [], notificationSettings: null, role: "member", usage: null, plan: null },
  selectedProcessId: null,
  process: null,
  editingStepId: null,
  selectedImplementationId: null,
  customerTokens: new Map(),
  handoverGuide: "",
  helpMessages: [],
  onboardingDismissed: false,
  preferences: { theme: "light", accent: "blue" },
  implementationFilters: { search: "", status: "all", owner: "all", attention: "all" }
};
const dirtyScopes = new Map();
let hubspotPipelineCache = [];
let hubspotConfigurationLoaded = false;
let hubspotConfigurationLoading = false;
const dirtyScopeBaselines = new WeakMap();
const pendingFormButtons = new WeakMap();
let activeSubmissionForm = null;
let nextFieldErrorId = 0;

const titles = {
  overview: ["Your workspace", "Overview"],
  portfolio: ["See delivery health", "Portfolio"],
  processes: ["Plan your work", "Process map"],
  templates: ["Reuse what works", "Templates"],
  implementations: ["Run customer work", "Implementations"],
  requirements: ["Get customer-ready", "Customer information"],
  guide: ["Learn Relay", "How to use Relay"],
  integrations: ["Connect your tools", "Integrations"],
  settings: ["Personalize your workspace", "Settings"]
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
  if (isWorkspaceDemo) {
    const result = await window.relayWorkspaceDemo.request(url, options);
    if (activeSubmissionForm) {
      finishForm(activeSubmissionForm, "Saved.");
      activeSubmissionForm = null;
    }
    return result;
  }
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
  if (!response.ok) {
    const error = new Error(result.error || "The request could not be completed.");
    if (result.code === "subscription_expired") {
      resetJustOneCXIdentity();
      showAuth(error.message);
    }
    throw error;
  }
  if (activeSubmissionForm) {
    finishForm(activeSubmissionForm, "Saved.");
    activeSubmissionForm = null;
  }
  return result;
}

function resetJustOneCXIdentity() {
  const integration = window.RelayJustOneCX;
  if (!integration) return;
  integration.reset().catch((error) => {
    console.warn("[Relay] JustOneCX identity reset failed.", error);
  });
}

async function syncJustOneCXIdentity(session) {
  const integration = window.RelayJustOneCX;
  const identity = session?.justonecx;
  const plan = session?.workspace?.plan?.code;
  if (!integration || !identity?.userHash || !identity?.accountHash || !plan) return;
  if (state.user?.id !== session.user?.id || state.workspace?.id !== session.workspace?.id) return;

  try {
    await integration.identify({
      userId: session.user.id,
      userHash: identity.userHash,
      userTraits: { role: session.workspace.role, plan },
      accountId: session.workspace.id,
      accountHash: identity.accountHash,
      accountTraits: { plan }
    });
  } catch (error) {
    console.warn("[Relay] JustOneCX identity synchronization failed.", error);
  }
}

async function loadJustOneCXIdentity() {
  const userId = state.user?.id;
  const workspaceId = state.workspace?.id;
  if (!userId || !workspaceId || !window.RelayJustOneCX) return;

  try {
    const session = await api("/api/product/me");
    if (state.user?.id !== userId || state.workspace?.id !== workspaceId) return;
    await syncJustOneCXIdentity(session);
  } catch (error) {
    console.warn("[Relay] JustOneCX identity could not be loaded.", error);
  }
}

function showToast(message, error = false) {
  if (!error && activeSubmissionForm?.isConnected) {
    finishForm(activeSubmissionForm, "Saved.");
    activeSubmissionForm = null;
  }
  window.clearTimeout(showToast.timeout);
  toast.textContent = message;
  toast.style.background = error ? "#991b1b" : "";
  toast.setAttribute("role", error ? "alert" : "status");
  toast.setAttribute("aria-live", error ? "assertive" : "polite");
  toast.classList.add("show");
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 3600);
}

function formStatus(form) {
  let status = form.querySelector(":scope > .form-status");
  if (!status) {
    status = document.createElement("p");
    status.className = "form-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    form.append(status);
  }
  return status;
}

function setFormBusy(form, label = "Saving...", snapshot = scopeValues(form)) {
  const button = form.querySelector('button[type="submit"], button[data-save-task], button:not([type])');
  if (!button || pendingFormButtons.has(form)) return;
  const controls = form instanceof HTMLFormElement
    ? [...form.elements]
    : [...form.querySelectorAll("button, input, select, textarea")];
  pendingFormButtons.set(form, {
    button,
    text: button.textContent,
    controls: controls.map((control) => ({ control, disabled: control.disabled })),
    snapshot
  });
  controls.forEach((control) => { control.disabled = true; });
  button.textContent = label;
  form.setAttribute("aria-busy", "true");
  formStatus(form).textContent = label;
}

function finishForm(form, message = "") {
  const pending = pendingFormButtons.get(form);
  if (pending) {
    pending.button.textContent = pending.text;
    pending.controls.forEach(({ control, disabled }) => { control.disabled = disabled; });
    pendingFormButtons.delete(form);
  }
  form.removeAttribute("aria-busy");
  if (message === "Saved.") formStatus(form).setAttribute("role", "status");
  let statusMessage = message;
  if (message === "Saved." && pending?.snapshot && scopeValues(form) !== pending.snapshot) {
    dirtyScopeBaselines.set(form, pending.snapshot);
    dirtyScopes.set(form, true);
    statusMessage = "Saved. Changes made while saving are still unsaved.";
  } else if (message === "Saved.") {
    clearDirtyScope(form);
  }
  formStatus(form).textContent = statusMessage;
}

function failForm(form, error) {
  window.clearTimeout(showToast.timeout);
  toast.classList.remove("show");
  toast.textContent = "";
  toast.style.background = "";
  const message = error instanceof Error ? error.message : "The request could not be completed. Please try again.";
  finishForm(form, message);
  const messageText = message.toLocaleLowerCase();
  formStatus(form).setAttribute("role", "alert");
  const fields = form instanceof HTMLFormElement ? [...form.elements] : [...form.querySelectorAll("input, select, textarea")];
  const labelled = fields.find((element) => {
    const label = element.labels?.[0]?.textContent?.toLocaleLowerCase() || "";
    const name = `${element.name || ""} ${element.id || ""}`.toLocaleLowerCase();
    const terms = `${label} ${name}`.split(/[^a-z]+/).filter((term) => term.length > 3);
    return terms.some((term) => messageText.includes(term));
  });
  const blockerField = messageText.includes("blocker details")
    ? form.querySelector('[data-task-reason], [data-task-action]')
    : null;
  const invalid = blockerField || labelled || fields.find((element) => element.willValidate && !element.checkValidity());
  if (invalid) {
    invalid.setAttribute("aria-invalid", "true");
    let errorId = invalid.getAttribute("aria-describedby");
    let fieldError = errorId && document.getElementById(errorId);
    if (!fieldError || !form.contains(fieldError)) {
      errorId = `relay-field-error-${++nextFieldErrorId}`;
      fieldError = document.createElement("small");
      fieldError.id = errorId;
      fieldError.className = "field-error";
      invalid.insertAdjacentElement("afterend", fieldError);
    }
    fieldError.textContent = message;
    invalid.setAttribute("aria-describedby", errorId);
    invalid.focus();
  }
}

function scopeValues(scope) {
  const controls = scope instanceof HTMLFormElement ? [...scope.elements] : [...scope.querySelectorAll("input, select, textarea")];
  return JSON.stringify(controls.map((control) => ({
    key: control.name || control.id || control.dataset.stepStatus || control.dataset.taskOwner || "",
    value: control.value,
    checked: "checked" in control ? control.checked : undefined,
    selected: control instanceof HTMLSelectElement && control.multiple
      ? [...control.selectedOptions].map((option) => option.value)
      : undefined
  })));
}

function clearDirtyScope(scope) {
  dirtyScopes.delete(scope);
  dirtyScopeBaselines.delete(scope);
  if (scope.id === "process-meta-form" || scope.id === "step-form") {
    updateProcessActionButtons();
  }
}

function confirmDiscardChanges() {
  if (!dirtyScopes.size) return true;
  if (!window.confirm("You have unsaved changes. Discard them and continue?")) return false;
  for (const scope of dirtyScopes.keys()) {
    const baseline = JSON.parse(dirtyScopeBaselines.get(scope) || "[]");
    const controls = scope instanceof HTMLFormElement ? [...scope.elements] : [...scope.querySelectorAll("input, select, textarea")];
    controls.forEach((control, index) => {
      const saved = baseline[index];
      if (!saved) return;
      control.value = saved.value;
      if (saved.checked !== undefined) control.checked = saved.checked;
      if (saved.selected && control instanceof HTMLSelectElement) {
        [...control.options].forEach((option) => { option.selected = saved.selected.includes(option.value); });
      }
      control.removeAttribute("aria-invalid");
      const errorId = control.getAttribute("aria-describedby");
      const fieldError = errorId && document.getElementById(errorId);
      if (fieldError) fieldError.remove();
      if (errorId) control.removeAttribute("aria-describedby");
    });
    const status = scope.querySelector(":scope > .form-status");
    if (status) {
      status.textContent = "";
      status.setAttribute("role", "status");
    }
    dirtyScopeBaselines.delete(scope);
  }
  dirtyScopes.clear();
  updateProcessActionButtons();
  return true;
}

appShell.addEventListener("focusin", (event) => {
  if (isRayDemo || !event.target.matches("input, select, textarea")) return;
  const scope = event.target.closest("form, .step-card");
  if (scope && !dirtyScopeBaselines.has(scope)) dirtyScopeBaselines.set(scope, scopeValues(scope));
});
appShell.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.closest(".main-content")) return;
  if (form.id === "account-deletion-form") return;
  if (pendingFormButtons.has(form)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  activeSubmissionForm = form;
  setFormBusy(form);
}, true);
function clearFieldFeedback(event) {
  const target = event.target;
  target.removeAttribute("aria-invalid");
  const errorId = target.getAttribute("aria-describedby");
  const fieldError = errorId && document.getElementById(errorId);
  if (fieldError) fieldError.remove();
  if (errorId) target.removeAttribute("aria-describedby");
  const scope = target.closest("form, .step-card");
  const status = scope?.querySelector(":scope > .form-status");
  if (status?.getAttribute("role") === "alert") {
    status.textContent = "";
    status.setAttribute("role", "status");
  }
}
appShell.addEventListener("input", clearFieldFeedback);
appShell.addEventListener("change", clearFieldFeedback);
appShell.addEventListener("input", (event) => updateDirtyScope(event.target));
appShell.addEventListener("change", (event) => updateDirtyScope(event.target));

function updateDirtyScope(target) {
  if (isRayDemo || !target.matches("input, select, textarea")) return;
  const scope = target.closest("form, .step-card");
  if (!scope) return;
  if (!dirtyScopeBaselines.has(scope)) dirtyScopeBaselines.set(scope, scopeValues(scope));
  if (dirtyScopeBaselines.get(scope) === scopeValues(scope)) {
    dirtyScopes.delete(scope);
    const status = scope.querySelector(":scope > .form-status");
    if (status?.textContent === "Unsaved changes.") status.textContent = "";
  } else {
    dirtyScopes.set(scope, true);
    const status = formStatus(scope);
    status.setAttribute("role", "status");
    status.textContent = scope.id === "step-form"
      ? "Unsaved changes. Save this step before testing the process."
      : scope.id === "process-meta-form"
        ? "Unsaved changes. Save process details before testing the process."
        : "Unsaved changes.";
  }
  if (scope.id === "process-meta-form" || scope.id === "step-form") {
    updateProcessActionButtons();
  }
}

window.addEventListener("beforeunload", (event) => {
  if (!dirtyScopes.size) return;
  event.preventDefault();
  event.returnValue = "";
});

document.getElementById("export-portfolio").addEventListener("click", () => {
  const rows = [
    ["Customer", "Template", "Started", "Total tasks", "Completed tasks", "Overdue tasks", "Blocked tasks"],
    ...(state.data.implementations || []).map((item) => [
      item.customer_name, item.template_name, item.created_at, item.total_steps,
      item.completed_steps, item.overdue_steps, item.blocked_steps
    ])
  ];
  const csv = rows.map((row) => row.map((value) => {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "relay-implementation-portfolio.csv";
  link.click();
  URL.revokeObjectURL(url);
});

function showAuth(message = "") {
  window.clearTimeout(subscriptionExpiryTimer);
  state.user = null;
  state.workspace = null;
  state.onboardingDismissed = false;
  state.preferences = { theme: "light", accent: "blue" };
  applyAppearance();
  authScreen.hidden = false;
  appShell.hidden = true;
  authStatus.textContent = message;
}

function scheduleSubscriptionExpiry(expiresAt) {
  window.clearTimeout(subscriptionExpiryTimer);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    showAuth("Relay could not verify your subscription. Please sign in again.");
    return;
  }
  const untilExpiry = expiresAtMs - Date.now();
  const remaining = untilExpiry <= 0 ? 30_000 : untilExpiry;
  subscriptionExpiryTimer = window.setTimeout(async () => {
    if (Date.now() < expiresAtMs) {
      scheduleSubscriptionExpiry(expiresAt);
      return;
    }
    try {
      const session = await api("/api/product/me");
      state.workspace = session.workspace;
      scheduleSubscriptionExpiry(session.workspace.subscriptionExpiresAt);
    } catch (error) {
      resetJustOneCXIdentity();
      showAuth(error.message);
    }
  }, Math.min(remaining, 2147000000));
}

function showProduct() {
  authScreen.hidden = true;
  appShell.hidden = false;
  document.getElementById("workspace-name-display").textContent = state.workspace.name;
  document.getElementById("user-email").textContent = state.user.email;
  scheduleSubscriptionExpiry(state.workspace.subscriptionExpiresAt);
}

function applyAppearance() {
  document.documentElement.dataset.theme = state.preferences.theme;
  document.documentElement.dataset.accent = state.preferences.accent;
  const mode = document.getElementById("theme-mode");
  const accent = document.getElementById("theme-accent");
  if (mode) mode.value = state.preferences.theme;
  if (accent) accent.value = state.preferences.accent;
}

async function loadPreferences() {
  state.preferences = await api("/api/product/preferences");
  applyAppearance();
}

async function loadAccountDeletionChoices() {
  const summary = document.getElementById("account-deletion-summary");
  const form = document.getElementById("account-deletion-form");
  if (isWorkspaceDemo) {
    summary.textContent = "Account deletion is disabled in this local demo. No live Relay account or data will be changed.";
    form.hidden = true;
    return;
  }
  summary.textContent = "Loading your workspace ownership details…";
  form.hidden = true;
  const { workspaces } = await api("/api/product/account-deletion/workspaces");
  if (!workspaces.length) {
    summary.textContent = "No workspaces are linked to your account. Deleting your account will remove your account data.";
    form.hidden = false;
    return;
  }
  const workspaceRows = workspaces.map((workspace) => {
    let impact;
    if (workspace.member_count === 1) {
      impact = `<p>As the only member, deleting your account will also permanently delete this workspace and its customer implementation data.</p>`;
    } else if (workspace.role === "owner") {
      const options = workspace.members.map((member) =>
        `<option value="${member.userId}">${escapeHtml(member.email)}</option>`).join("");
      impact = `<p>Choose a new owner. The workspace and its data will remain available to its members.</p>
        <div class="field"><label for="account-delete-owner-${workspace.id}">New owner for ${escapeHtml(workspace.name)}</label>
        <select id="account-delete-owner-${workspace.id}" data-account-delete-transfer="${workspace.id}" required>
          <option value="">Choose a workspace member</option>${options}
        </select></div>`;
    } else {
      impact = "<p>Your membership will be removed. The shared workspace and its data will remain available to its members.</p>";
    }
    return `<article class="account-deletion-workspace"><strong>${escapeHtml(workspace.name)}</strong>${impact}</article>`;
  }).join("");
  summary.innerHTML = `<p>Review the effect on each workspace before continuing:</p>${workspaceRows}
    <p>Deletion removes your personal account data from the live Relay database and signs you out on all devices. Backup copies may persist until they expire under the service’s backup-retention policy.</p>`;
  form.hidden = false;
}

async function savePreference(key, value) {
  const previous = state.preferences[key];
  state.preferences[key] = value;
  applyAppearance();
  const status = document.getElementById("appearance-status");
  status.textContent = "Saving your appearance...";
  appearanceSaveQueue = appearanceSaveQueue.catch(() => {}).then(async () => {
    try {
      state.preferences = await api("/api/product/preferences", {
        method: "PATCH",
        body: { [key]: value }
      });
      applyAppearance();
      status.textContent = "Your appearance is saved to your account.";
    } catch (error) {
      state.preferences[key] = previous;
      applyAppearance();
      status.textContent = error.message;
    }
  });
  return appearanceSaveQueue;
}

function renderHelpMessages() {
  const container = document.getElementById("help-messages");
  container.replaceChildren();
  if (!state.helpMessages.length) {
    const empty = document.createElement("p");
    empty.className = "help-empty";
    empty.textContent = "Hi! I’m Ray. I can explain Relay’s features and guide you through using them. What would you like help with?";
    container.append(empty);
    return;
  }
  for (const message of state.helpMessages) {
    const article = document.createElement("article");
    article.className = `help-message ${message.role === "assistant" ? "assistant" : "user"}`;
    const label = document.createElement("strong");
    label.textContent = message.role === "assistant" ? "Ray" : "You";
    if (message.role === "assistant") {
      const logo = document.createElement("img");
      logo.className = "ray-message-logo";
      logo.src = "assets/Ray%20Robot%20Mascot%20Logo%20%281%29.png";
      logo.alt = "";
      article.append(logo);
    }
    const text = document.createElement("p");
    text.textContent = message.content;
    article.append(label, text);
    container.append(article);
  }
  container.scrollTop = container.scrollHeight;
}

function rayDemoReply(message) {
  return window.relayHelpReply(message);
}

window.relayDemoReply = rayDemoReply;

async function loadHelpHistory() {
  const result = await api("/api/product/help-chat");
  state.helpMessages = result.messages;
  renderHelpMessages();
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.getElementById("password-reset-request").hidden = true;
  document.getElementById("password-reset-complete").hidden = true;
  document.getElementById("auth-form").hidden = false;
  document.getElementById("auth-tabs").hidden = !state.inviteToken;
  document.getElementById("forgot-password").hidden = mode !== "login";
  const isSignup = mode === "signup";
  authTabs.login.classList.toggle("active", !isSignup);
  authTabs.signup.classList.toggle("active", isSignup);
  authTabs.login.setAttribute("aria-selected", String(!isSignup));
  authTabs.signup.setAttribute("aria-selected", String(isSignup));
  document.getElementById("auth-password").autocomplete = isSignup ? "new-password" : "current-password";
  document.getElementById("password-hint").textContent = isSignup
    ? "Use at least 12 characters."
    : "Enter your workspace password.";
  authTabs.login.textContent = state.inviteToken ? "Existing account" : "Sign in";
  authTabs.signup.textContent = "Create invited account";
  document.getElementById("auth-submit").textContent = isSignup
    ? "Create account & join"
    : state.inviteToken ? "Sign in & join" : "Sign in";
  document.getElementById("auth-title").textContent = isSignup
    ? "Join your Relay workspace."
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
  if (dirtyScopes.size && !confirmDiscardChanges()) return false;
  const data = await api("/api/product/workspace");
  state.data = data;
  renderWorkspace();
  const integrationResult = new URLSearchParams(window.location.search).get("integration");
  if (integrationResult) {
    const messages = {
      hubspot_connected: "HubSpot connected. New and updated implementations will sync during event processing.",
      connect_failed: "The integration could not be connected. Check its OAuth app settings and try again."
    };
    document.getElementById("integration-status").textContent = messages[integrationResult] || "Integration connection completed.";
    setView("integrations");
    window.history.replaceState(null, "", window.location.pathname);
  }
  return true;
}

async function loadOnboarding() {
  const result = await api("/api/product/onboarding");
  state.onboardingDismissed = result.dismissed;
}

function emptyStateMarkup(title, description, actionLabel, action) {
  return `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p><button class="button secondary" type="button" data-workflow-action="${escapeHtml(action)}">${escapeHtml(actionLabel)}</button>`;
}

function getNextWorkflowAction() {
  if (!state.data.processes.length) return { action: "map-process", label: "Create a process map" };
  if (!state.data.processes.some((process) => process.steps_count > 0)) {
    return { action: "map-process", label: "Add process steps" };
  }
  if (!state.data.processes.some((process) => process.checked)) {
    return { action: "check-process", label: "Check a process" };
  }
  if (!state.data.templates.length) return { action: "save-template", label: "Create a template" };
  return { action: "start-implementation", label: "Start an implementation" };
}

function renderGettingStarted() {
  const guide = document.getElementById("getting-started");
  if (!guide) return;
  const steps = [
    {
      title: "Map a process and add at least one step",
      description: "Start with the work your team already does for a new customer.",
      complete: state.data.processes.some((process) => process.steps_count > 0),
      action: "map-process",
      actionLabel: state.data.processes.length ? "Open a process map" : "Create a process map"
    },
    {
      title: "Check that process",
      description: "The check points out missing instructions, roles, and workflow issues before reuse.",
      complete: state.data.processes.some((process) => process.checked),
      action: "check-process",
      actionLabel: "Check a process"
    },
    {
      title: "Create a reusable template",
      description: "A template is a checked snapshot that becomes the starting point for customer work.",
      complete: state.data.templates.length > 0,
      action: "save-template",
      actionLabel: "Create a template"
    },
    {
      title: "Start an implementation",
      description: "Choose the template and enter a customer company to create its work plan.",
      complete: state.data.implementations.length > 0,
      action: "start-implementation",
      actionLabel: "Start an implementation"
    }
  ];
  const nextIndex = steps.findIndex((step) => !step.complete);
  guide.hidden = state.onboardingDismissed;
  document.getElementById("show-getting-started").hidden = !state.onboardingDismissed;
  document.getElementById("getting-started-list").innerHTML = steps.map((step, index) => {
    const waiting = !step.complete && index > nextIndex;
    return `<li class="getting-started-step ${step.complete ? "complete" : waiting ? "waiting" : "current"}">
      <span class="getting-started-check" aria-hidden="true">${step.complete ? "✓" : index + 1}</span>
      <div class="getting-started-copy"><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p>
        ${index === nextIndex ? `<small>Next: ${escapeHtml(step.actionLabel)}. Use the main action above to continue.</small>` : waiting ? '<small>Complete the previous step to continue.</small>' : ""}
      </div>
      <span class="getting-started-state">${step.complete ? "Complete" : waiting ? "Next" : "Up next"}</span>
    </li>`;
  }).join("");
  const status = document.getElementById("getting-started-status");
  status.textContent = nextIndex < 0
    ? "You’ve completed the first implementation path. You can dismiss this guide or keep it as a reference."
    : `${steps.filter((step) => step.complete).length} of ${steps.length} steps complete.`;
}

function setMobileNavigationOpen(isOpen) {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("mobile-nav-toggle");
  sidebar.classList.toggle("mobile-open", isOpen);
  sidebar.inert = window.matchMedia("(max-width: 650px)").matches && !isOpen;
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
  document.getElementById("sidebar-backdrop").hidden = !isOpen;
  document.body.classList.toggle("sidebar-open", isOpen);
}

function setView(name) {
  if (!titles[name]) return;
  const activeView = document.querySelector(".view.active");
  if (activeView?.id !== `view-${name}` && !confirmDiscardChanges()) return false;
  const mobileNavigationWasOpen = document.getElementById("mobile-nav-toggle").getAttribute("aria-expanded") === "true";
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  setMobileNavigationOpen(false);
  document.getElementById("view-eyebrow").textContent = titles[name][0];
  document.getElementById("view-title").textContent = titles[name][1];
  if (mobileNavigationWasOpen) document.getElementById("view-title").focus();
  document.getElementById("refresh-button").hidden = name === "settings";
  globalStatus.textContent = "";
  if (name === "settings") loadAccountDeletionChoices().catch(showError);
  return true;
}

function showError(error) {
  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  if (activeSubmissionForm?.isConnected) {
    failForm(activeSubmissionForm, error);
    activeSubmissionForm = null;
    return;
  }
  globalStatus.textContent = message;
  showToast(message, true);
}

function blockerSummary(implementation) {
  const reasons = [];
  if (implementation.missing_inputs > 0) {
    reasons.push(`Missing or invalid information: ${implementation.missing_input_names}`);
  }
  if (implementation.quiet_customer) {
    reasons.push(`Waiting on the customer for ${implementation.quiet_customer_days} days`);
  }
  if (implementation.unowned_steps > 0) {
    reasons.push(`Open tasks without an owner: ${implementation.unowned_step_names}`);
  }
  if (implementation.blocked_steps > 0) reasons.push(`Blocked tasks: ${implementation.blocked_step_names}`);
  if (implementation.overdue_steps > 0) reasons.push(`Overdue tasks: ${implementation.overdue_step_names}`);
  if (implementation.waiting_steps > 0) reasons.push(`Waiting on prerequisites: ${implementation.waiting_step_names}`);
  return reasons.length ? reasons.join(" · ") : "No configured readiness issues detected";
}

function implementationStatus(implementation) {
  if (implementation.total_steps > 0 && implementation.completed_steps === implementation.total_steps) {
    return implementation.missing_inputs > 0 ? "needs_information" : "complete";
  }
  if (implementation.in_progress_steps > 0 || implementation.completed_steps > 0) return "in_progress";
  return "not_started";
}

function implementationNeedsAttention(implementation, filter = "yes") {
  const attention = {
    blocked: implementation.blocked_steps > 0,
    overdue: implementation.overdue_steps > 0,
    quiet: implementation.quiet_customer,
    waiting: implementation.waiting_steps > 0,
    missing: implementation.missing_inputs > 0,
    unassigned: implementation.unowned_steps > 0
  };
  if (filter === "yes") return Object.values(attention).some(Boolean);
  return Boolean(attention[filter]);
}

function filteredImplementations() {
  const { search, status, owner, attention } = state.implementationFilters;
  const query = search.trim().toLocaleLowerCase();
  return state.data.implementations.filter((implementation) => {
    if (query && !`${implementation.customer_name} ${implementation.template_name}`.toLocaleLowerCase().includes(query)) return false;
    if (status !== "all" && implementationStatus(implementation) !== status) return false;
    const assignedIds = (implementation.assigned_member_ids || "").split(",").filter(Boolean);
    if (owner === "unassigned" && implementation.unowned_steps === 0) return false;
    if (owner !== "all" && owner !== "unassigned" && !assignedIds.includes(owner)) return false;
    if (attention !== "all" && !implementationNeedsAttention(implementation, attention)) return false;
    return true;
  });
}

function renderAttentionBadges(implementation) {
  const features = state.data.plan?.features || {};
  const issues = [
    ["blocked", "Blocked", features.blockers ? implementation.blocked_steps : 0, implementation.blocked_step_names],
    ["overdue", "Overdue", implementation.overdue_steps, implementation.overdue_step_names],
    ["quiet", "Waiting on customer", implementation.quiet_customer ? implementation.quiet_customer_days : 0, implementation.quiet_customer ? `${implementation.quiet_customer_days} days without a customer update` : ""],
    ["waiting", "Waiting", features.dependencies ? implementation.waiting_steps : 0, implementation.waiting_step_names],
    ["missing", "Info missing", implementation.missing_inputs, implementation.missing_input_names],
    ["unassigned", "Unassigned", implementation.unowned_steps, implementation.unowned_step_names]
  ].filter(([, , count]) => count > 0);
  return issues.length
    ? issues.map(([key, label, count, names]) => `<span class="attention-chip ${key}" title="${escapeHtml(names || label)}">${label} · ${count}</span>`).join("")
    : '<span class="badge ready">On track</span>';
}

function renderOverview() {
  const { implementations, templates, processes } = state.data;
  const next = getNextWorkflowAction();
  const primaryAction = document.getElementById("overview-primary-action");
  primaryAction.textContent = next.label;
  primaryAction.dataset.workflowAction = next.action;
  const activeCount = state.data.usage?.activeImplementations ?? implementations.length;
  const features = state.data.plan?.features || {};
  const needsAttention = implementations.filter((item) => item.missing_inputs > 0 || item.unowned_steps > 0
    || item.overdue_steps > 0 || item.quiet_customer || (features.blockers && item.blocked_steps > 0)
    || (features.dependencies && item.waiting_steps > 0)).length;
  document.getElementById("overview-metrics").innerHTML = [
    ["Active implementations", activeCount, "Customer journeys in progress"],
    ["Templates", templates.length, "Approved workflows ready to reuse"],
    ["Needs attention", needsAttention, features.blockers || features.dependencies
      ? "Missing information, overdue work, blockers, or prerequisites"
      : "Missing information, unassigned tasks, or overdue work"]
  ].map(([label, value, detail]) => `<article class="metric"><strong>${value}</strong><span>${escapeHtml(label)} · ${escapeHtml(detail)}</span></article>`).join("");
  document.getElementById("overview-implementations").innerHTML = implementations.length
    ? renderImplementationTable(implementations.slice(0, 6), true)
    : "";
  const emptyState = document.getElementById("overview-empty");
  emptyState.hidden = implementations.length > 0;
  if (!implementations.length) {
    const copy = {
      "map-process": ["Start with your team's process", "Map the steps your team follows so Relay can check the workflow and turn it into a reusable template."],
      "check-process": ["Check your process", "Run a workflow check before creating a template."],
      "save-template": ["Create a reusable template", "A template gives each customer a consistent starting point."],
      "start-implementation": ["Start your first implementation", "Choose a template and enter the customer company to create a customer-specific work plan."]
    }[next.action];
    emptyState.innerHTML = `<strong>${escapeHtml(copy[0])}</strong><p>${escapeHtml(copy[1])}</p>`;
  }
  renderGettingStarted();
  applyPlanGates();
}

function renderPortfolio() {
  const workload = state.data.teamWorkload || [];
  document.getElementById("portfolio-workload").innerHTML = workload.length
    ? workload.map((member) => `<article class="metric">
        <strong>${member.open_tasks}</strong>
        <span>${escapeHtml(member.email)} · open tasks · ${member.overdue_tasks} overdue</span>
      </article>`).join("")
    : '<p class="empty-state">No team workload to show yet.</p>';
  const implementations = state.data.implementations || [];
  document.getElementById("portfolio-implementations").innerHTML = implementations.length
    ? `<table class="data-table"><thead><tr><th>Customer</th><th>Progress</th><th>Health</th><th>Estimated finish</th></tr></thead><tbody>
      ${implementations.map((item) => {
        const total = Number(item.total_steps) || 0;
        const completed = Number(item.completed_steps) || 0;
        const percent = total ? Math.round((completed / total) * 100) : 0;
        const health = item.overdue_steps || item.blocked_steps || item.missing_inputs
          ? "Needs attention" : "On track";
        return `<tr><td><strong>${escapeHtml(item.customer_name)}</strong><small>${escapeHtml(item.template_name)}</small></td>
          <td>${percent}% (${completed}/${total})</td><td><span class="badge ${health === "On track" ? "ready" : "attention"}">${health}</span></td>
          <td>${escapeHtml(item.projected_completion || "Not enough completed tasks")}</td></tr>`;
      }).join("")}</tbody></table>`
    : '<p class="empty-state">Start an implementation to see portfolio health.</p>';
}

function renderNotificationSettings() {
  const settings = state.data.notificationSettings || { email_enabled: false, reminder_days_before: 2 };
  document.getElementById("notifications-email-enabled").checked = settings.email_enabled;
  document.getElementById("notifications-reminder-days").value = settings.reminder_days_before;
  const form = document.getElementById("notification-settings-form");
  const owner = state.workspace.role === "owner";
  for (const control of form.elements) control.disabled = !owner;
  document.getElementById("notifications-demo-note").hidden = !isWorkspaceDemo;
}

function renderIntegrations() {
  const integrations = state.data.integrations || [];
  const connected = new Set(integrations.map((item) => item.provider));
  const hubspot = integrations.find((item) => item.provider === "hubspot");
  document.getElementById("integration-status").textContent = hubspot?.hubspot_onboarding_last_error
    ? `HubSpot handoff needs attention: ${hubspot.hubspot_onboarding_last_error}`
    : state.workspace.role === "owner" ? "" : "Only a workspace owner can connect or disconnect integrations.";
  document.getElementById("integrations-demo-note").hidden = !isWorkspaceDemo;
  document.getElementById("integration-list").innerHTML = ["hubspot"].map((provider) => {
    const name = "HubSpot";
    const isConnected = connected.has(provider);
    const stateLabel = isWorkspaceDemo
      ? isConnected ? "Preview connected · no external service linked" : "Not connected"
      : isConnected ? "Connected" : "Not connected";
    return `<div class="list-row"><div><strong>${name}</strong><small>${stateLabel}</small></div>
      ${connected.has(provider)
        ? `<button class="text-button" type="button" data-disconnect-integration="${provider}" ${state.workspace.role !== "owner" ? "disabled" : ""}>${isWorkspaceDemo ? "Clear preview" : "Disconnect"}</button>`
        : `<button class="button secondary" type="button" data-connect-integration="${provider}" ${state.workspace.role !== "owner" ? "disabled" : ""}>${isWorkspaceDemo ? "Preview connection" : `Connect ${name}`}</button>`}</div>`;
  }).join("");
  const handoffPanel = document.getElementById("hubspot-handoff-panel");
  handoffPanel.hidden = isWorkspaceDemo || !connected.has("hubspot");
  for (const control of document.getElementById("hubspot-handoff-form").elements) {
    control.disabled = state.workspace.role !== "owner";
  }
  if (!handoffPanel.hidden && !hubspotConfigurationLoaded && !hubspotConfigurationLoading) {
    loadHubspotHandoffOptions().catch((error) => {
      document.getElementById("hubspot-handoff-status").textContent = error.message;
      hubspotConfigurationLoading = false;
    });
  }
}

function populateHubspotStages(selectedStageId = "") {
  const pipelineId = document.getElementById("hubspot-pipeline").value;
  const pipeline = hubspotPipelineCache.find((item) => item.id === pipelineId);
  const stages = (pipeline?.stages || []).filter((stage) => stage.isClosedWon);
  const stageSelect = document.getElementById("hubspot-stage");
  stageSelect.innerHTML = '<option value="">Choose a Closed Won stage</option>'
    + stages.map((stage) => `<option value="${escapeHtml(stage.id)}">${escapeHtml(stage.label)}</option>`).join("");
  stageSelect.value = stages.some((stage) => stage.id === selectedStageId) ? selectedStageId : "";
}

async function loadHubspotHandoffOptions() {
  hubspotConfigurationLoading = true;
  const result = await api("/api/product/integrations/hubspot/pipelines");
  hubspotPipelineCache = result.pipelines || [];
  const config = result.configuration || {};
  const pipelineSelect = document.getElementById("hubspot-pipeline");
  pipelineSelect.innerHTML = '<option value="">Choose a HubSpot pipeline</option>'
    + hubspotPipelineCache.map((pipeline) =>
      `<option value="${escapeHtml(pipeline.id)}">${escapeHtml(pipeline.label)}</option>`
    ).join("");
  pipelineSelect.value = hubspotPipelineCache.some((pipeline) => pipeline.id === config.pipelineId)
    ? config.pipelineId : "";
  populateHubspotStages(config.stageId || "");
  const templateSelect = document.getElementById("hubspot-template");
  templateSelect.innerHTML = '<option value="">Choose a template</option>'
    + state.data.templates.map((template) =>
      `<option value="${template.id}">${escapeHtml(template.name)}</option>`
    ).join("");
  templateSelect.value = state.data.templates.some((template) => template.id === config.templateId)
    ? String(config.templateId) : "";
  hubspotConfigurationLoaded = true;
  hubspotConfigurationLoading = false;
  const handoffStatus = document.getElementById("hubspot-handoff-status");
  const integration = state.data.integrations.find((item) => item.provider === "hubspot");
  const configuredPipeline = hubspotPipelineCache.find((pipeline) => pipeline.id === config.pipelineId);
  const configuredStageExists = configuredPipeline?.stages.some((stage) =>
    stage.id === config.stageId && stage.isClosedWon);
  handoffStatus.textContent = integration?.hubspot_onboarding_last_error
    || (config.pipelineId && !configuredPipeline
      ? "The saved HubSpot pipeline is no longer available. Choose a new pipeline and save the handoff."
      : config.stageId && !configuredStageExists
        ? "The saved Closed Won stage is no longer available. Choose a new stage and save the handoff."
        : config.pipelineId && config.stageId && !config.templateId
          ? "The saved Relay template is no longer available. Choose a new template and save the handoff."
          : "");
}

function renderPlanSummary() {
  const panel = document.getElementById("plan-summary");
  const plan = state.data.plan;
  if (!plan) {
    panel.hidden = true;
    return;
  }
  const usage = state.data.usage || {};
  const formatLimit = (value) => value === null || value === undefined ? "Unlimited" : String(value);
  const seatUsage = (usage.members || 0) + (usage.pendingInvites || 0);
  document.getElementById("plan-summary-title").textContent = `${plan.name} plan`;
  document.getElementById("plan-summary-description").textContent =
    plan.code === "custom" ? "Custom pricing and agreed workspace limits." : `${plan.code === "starter" ? "₹2,999" : "₹3,999"} per month before applicable taxes.`;
  document.getElementById("plan-usage").innerHTML = [
    ["Team members", seatUsage, formatLimit(plan.memberLimit)],
    ["Active implementations", usage.activeImplementations || 0, formatLimit(plan.activeImplementationLimit)],
    ["Templates", usage.templates || 0, formatLimit(plan.templateLimit)]
  ].map(([label, used, limit]) => `<div><strong>${used} / ${escapeHtml(limit)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  const featureLabels = [
    !plan.features.dependencies && "Prerequisites",
    !plan.features.blockers && "Blocker tracking",
    !plan.features.templateHistory && "Template history and restore"
  ].filter(Boolean);
  document.getElementById("plan-features").textContent = featureLabels.length
    ? `Growth adds ${featureLabels.join(", ")}.`
    : "Your plan includes prerequisites, blocker tracking, and template revision history and restore.";
  panel.hidden = false;
}

function applyPlanGates() {
  updateSaveTemplateButton();
  const features = state.data.plan?.features;
  if (!features) return;
  for (const element of document.querySelectorAll("[data-growth-only]")) {
    element.hidden = !features[element.dataset.growthOnly];
  }
  for (const button of document.querySelectorAll("[data-start-template]")) {
    button.disabled = state.data.plan.templateLimit !== null && state.data.plan.templateLimit !== undefined
      && state.data.templates.length >= state.data.plan.templateLimit;
  }
  const activeLimit = state.data.plan.activeImplementationLimit;
  const activeFull = activeLimit !== null && activeLimit !== undefined
    && (state.data.usage?.activeImplementations || 0) >= activeLimit;
  const implementationSubmit = document.querySelector("#implementation-form button[type=submit]");
  implementationSubmit.disabled = activeFull;
  const capNotice = document.getElementById("implementation-cap-notice");
  capNotice.hidden = !activeFull;
  capNotice.textContent = activeFull
    ? `Your plan allows ${activeLimit} active implementations. Complete an implementation or upgrade the plan to start another.`
    : "";
}

function updateSaveTemplateButton() {
  const templateLimit = state.data.plan?.templateLimit;
  const templateFull = templateLimit !== null && templateLimit !== undefined
    && state.data.templates.length >= templateLimit;
  const selectedProcess = state.data.processes.find((process) => process.id === state.selectedProcessId);
  const hasDraft = hasUnsavedProcessDraft();
  const hasSteps = Boolean(state.process?.steps?.length);
  const processChecked = state.process?.checked === true && selectedProcess?.checked === true
    && !hasDraft;
  const hasTemplate = processChecked && hasTemplateForProcess(state.selectedProcessId);
  const saveTemplate = document.getElementById("save-template");
  saveTemplate.disabled = templateFull || !processChecked;
  saveTemplate.textContent = hasTemplate ? "Create another template" : "Create template";
  saveTemplate.title = templateFull
    ? "Template limit reached. Upgrade your plan or remove an unused template."
    : processChecked ? "" : "Save the process and at least one step, then check it before creating a template.";
  const actionHelp = document.getElementById("process-action-help");
  if (!state.selectedProcessId) {
    actionHelp.textContent = "Create or select a process map to get started.";
  } else if (hasDraft) {
    actionHelp.textContent = "Save the process details or step you are editing before checking or creating a template.";
  } else if (!hasSteps) {
    actionHelp.textContent = "Save at least one step before checking the process. One step is enough to start.";
  } else if (templateFull) {
    actionHelp.textContent = "Your workspace has reached its template limit.";
  } else if (hasTemplate) {
    actionHelp.textContent = "This process already has a template. Create another snapshot only if you need a separate version.";
  } else if (processChecked) {
    actionHelp.textContent = "Check passed. Select Create template to make this process reusable for customers.";
  } else {
    actionHelp.textContent = "Save each step, then select Check process. A successful check enables Create template.";
  }
}

function hasUnsavedProcessDraft() {
  return dirtyScopes.has(document.getElementById("process-meta-form"))
    || dirtyScopes.has(document.getElementById("step-form"));
}

function hasTemplateForProcess(processId) {
  return processId !== null && processId !== undefined
    && state.data.templates.some((template) => String(template.process_id) === String(processId));
}

function renderProcessProgress() {
  const container = document.getElementById("process-progress");
  if (!container) return;

  const selectedProcess = state.data.processes.find((process) => process.id === state.selectedProcessId);
  const process = state.process?.id === state.selectedProcessId ? state.process : null;
  const stepCount = process?.steps?.length ?? selectedProcess?.steps_count ?? selectedProcess?.steps?.length ?? 0;
  const hasDraft = hasUnsavedProcessDraft();
  const checked = process?.checked === true && selectedProcess?.checked === true && !hasDraft;
  const templateCreated = checked && hasTemplateForProcess(state.selectedProcessId);
  const currentStep = !state.selectedProcessId ? 0 : stepCount === 0 ? 1 : templateCreated ? -1 : 2;
  const steps = [
    { title: "Create a process map", detail: "Name the workflow" },
    { title: "Save process steps", detail: "Save the work in order" },
    { title: "Create a template", detail: templateCreated ? "Template created" : checked ? "Ready to create" : "Check the process first" }
  ];

  container.innerHTML = steps.map((step, index) => {
    const complete = index < currentStep || (currentStep === -1);
    const current = index === currentStep;
    const stateClass = complete ? "is-complete" : current ? "is-current" : "is-upcoming";
    const status = complete ? "Done" : current ? "Next" : "Up next";
    const number = complete ? "✓" : index + 1;
    return `<li class="process-progress-step ${stateClass}" ${current ? 'aria-current="step"' : ""}>
      <span class="process-progress-number" aria-hidden="true">${number}</span>
      <span class="process-progress-copy"><strong>${step.title}</strong><small>${current ? step.detail : status}</small></span>
    </li>`;
  }).join("");

  const count = document.getElementById("process-step-count");
  count.hidden = !process;
  if (process) count.textContent = `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;

  const subtitle = document.getElementById("process-editor-subtitle");
  if (process) {
    subtitle.textContent = !stepCount
      ? "Save the process details above, then save at least one step below."
      : checked
        ? templateCreated
          ? "This process has been checked and saved as a template."
          : "The check passed. Create a template when you are ready to reuse this process."
        : "Save any changes, then check the process before creating a template.";
  } else {
    subtitle.textContent = "Choose a map or create your first one to begin.";
  }
}

function showUnsavedProcessDraftNotice() {
  const result = document.getElementById("process-test-result");
  result.hidden = false;
  result.classList.add("warning");
  result.setAttribute("role", "status");
  result.setAttribute("aria-live", "polite");
  result.textContent = "Save or cancel your unsaved process details or step before testing or saving a template. Your draft is still here.";
}

function updateProcessActionButtons() {
  const hasDraft = hasUnsavedProcessDraft();
  const testButton = document.getElementById("test-process");
  const result = document.getElementById("process-test-result");
  testButton.disabled = hasDraft;
  testButton.title = hasDraft ? "Save or cancel your unsaved process changes before testing." : "";
  if (hasDraft) {
    showUnsavedProcessDraftNotice();
  } else if (result.textContent === "Save or cancel your unsaved process details or step before testing or saving a template. Your draft is still here.") {
    result.hidden = true;
    result.classList.remove("warning");
    result.textContent = "";
  }
  updateSaveTemplateButton();
  renderProcessProgress();
}

function renderImplementationTable(implementations, compact = false) {
  if (!implementations.length) {
    const next = getNextWorkflowAction();
    return `<div class="empty-state"><strong>No customer implementations yet</strong><p>${state.data.templates.length
      ? "Start from a saved template to create the first customer-specific work plan."
      : "Follow the next setup step to prepare a reusable starting point before customer work."}</p><button class="button secondary" type="button" data-workflow-action="${next.action}">${escapeHtml(next.label)}</button></div>`;
  }
  const ownerLabels = (item) => {
    const assignedIds = (item.assigned_member_ids || "").split(",").filter(Boolean);
    const names = state.data.members.filter((member) => assignedIds.includes(String(member.id))).map((member) => member.email);
    return names.length ? names.map(escapeHtml).join(", ") : "No assigned owners";
  };
  const headings = compact
    ? "<th>Customer</th><th>Status</th><th>Open tasks</th><th>Attention</th><th></th>"
    : "<th>Customer</th><th>Template</th><th>Status</th><th>Owners</th><th>Open tasks</th><th>Attention</th><th></th>";
  return `<table class="data-table implementation-table ${compact ? "compact" : ""}"><thead><tr>${headings}</tr></thead><tbody>${implementations.map((item) => {
    const status = implementationStatus(item);
    const statusLabel = {
      not_started: "Not started",
      in_progress: "In progress",
      needs_information: "Needs information",
      complete: "Complete"
    }[status];
    return compact
      ? `<tr>
          <td><strong>${escapeHtml(item.customer_name)}</strong></td>
          <td><span class="badge status-${status}">${statusLabel}</span></td>
          <td>${item.open_steps} open</td>
          <td><div class="attention-chips">${renderAttentionBadges(item)}</div></td>
          <td><button class="row-button" type="button" data-open-implementation="${item.id}">Open</button></td>
        </tr>`
      : `<tr>
          <td><strong>${escapeHtml(item.customer_name)}</strong></td>
          <td>${escapeHtml(item.template_name)}</td>
          <td><span class="badge status-${status}">${statusLabel}</span></td>
          <td class="implementation-owners">${ownerLabels(item)}</td>
          <td>${item.open_steps} open / ${item.total_steps} total</td>
          <td><div class="attention-chips">${renderAttentionBadges(item)}</div></td>
          <td><button class="row-button" type="button" data-open-implementation="${item.id}">Open</button></td>
        </tr>`;
  }).join("")}</tbody></table>`;
}

function renderProcesses() {
  const container = document.getElementById("process-list");
  if (!state.data.processes.length) {
    container.innerHTML = `<div class="empty-state"><strong>No process maps yet</strong><p>Capture the steps your team already follows. You can check the workflow before reusing it for customers.</p><button class="button secondary" type="button" data-workflow-action="create-process">Create your first process map</button></div>`;
    renderProcessProgress();
    return;
  }
  container.innerHTML = state.data.processes.map((process) => {
    const stepCount = Number(process.steps_count ?? process.steps?.length ?? 0);
    const checked = process.checked === true;
    return `
      <article class="process-list-card ${process.id === state.selectedProcessId ? "selected" : ""}">
        <div class="process-list-main">
          <strong>${escapeHtml(process.name)}</strong>
          <small>${escapeHtml(process.description || "Onboarding process")}</small>
          <div class="process-card-meta">
            <span>${stepCount} ${stepCount === 1 ? "step" : "steps"}</span>
            <span class="process-card-status ${checked ? "ready" : ""}">${checked ? "Check passed" : stepCount ? "Needs a check" : "Add a step"}</span>
          </div>
        </div>
        <div class="process-card-actions">
          <button type="button" class="process-open-button" data-select-process="${process.id}" aria-current="${process.id === state.selectedProcessId ? "true" : "false"}">Open</button>
          <button type="button" class="text-button process-delete-button" data-delete-process="${process.id}" aria-label="Delete ${escapeHtml(process.name)} process map">Delete</button>
        </div>
      </article>`;
  }).join("");
  renderProcessProgress();
}

function renderAutomationAndCapacity() {
  const memberSelect = document.getElementById("capacity-user");
  if (memberSelect) {
    memberSelect.innerHTML = '<option value="">Choose member</option>'
      + (state.data.members || []).map((member) =>
        `<option value="${member.id}">${escapeHtml(member.email)}</option>`).join("");
  }
  const capacity = state.data.capacityPlans || [];
  const summary = [
    ...capacity.slice(0, 10).map((plan) => `<article class="list-row"><div><strong>${escapeHtml(plan.user_email)}</strong><small>${escapeHtml(plan.week_start)} · ${Math.round(plan.available_minutes / 60)} hours available</small></div></article>`)
  ];
  const container = document.getElementById("automation-capacity-summary");
  if (container) container.innerHTML = summary.length ? summary.join("") : '<p class="muted">No capacity plans yet.</p>';
}

function renderTeam() {
  document.getElementById("team-member-list").innerHTML = state.data.members.length
    ? state.data.members.map((member) => `<div class="list-row"><strong>${escapeHtml(member.email)}</strong><span class="badge">${escapeHtml(member.role)}</span></div>`).join("")
    : '<p class="empty-state">No workspace members are available.</p>';
  document.getElementById("team-invite-list").innerHTML = state.data.invites.length
    ? state.data.invites.map((invite) => `<div class="list-row"><div><strong>${escapeHtml(invite.invited_email)}</strong><small>Expires ${escapeHtml(invite.expires_at)}</small></div><button class="text-button" type="button" data-revoke-invite="${invite.id}">Revoke</button></div>`).join("")
    : '<p class="empty-state">No pending invitations.</p>';
  const inviteForm = document.getElementById("team-invite-form");
  const memberLimit = state.data.plan?.memberLimit;
  const seatsUsed = state.data.usage ? state.data.usage.members + state.data.usage.pendingInvites : state.data.members.length;
  const seatsFull = memberLimit !== null && memberLimit !== undefined && seatsUsed >= memberLimit;
  inviteForm.hidden = state.workspace.role !== "owner" || seatsFull;
  const capNotice = document.getElementById("team-cap-notice");
  capNotice.hidden = state.workspace.role !== "owner" || !seatsFull;
  capNotice.textContent = seatsFull ? `Your plan allows ${memberLimit} team members, including pending invitations. Upgrade the plan or revoke an invitation to add someone.` : "";
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
  if (dirtyScopes.size && !confirmDiscardChanges()) return false;
  if (state.selectedProcessId !== Number(processId)) state.editingStepId = null;
  const requestId = ++processLoadRequestId;
  const { process } = await api(`/api/product/processes/${processId}`);
  if (requestId !== processLoadRequestId) return false;
  state.process = process;
  state.selectedProcessId = process.id;
  renderProcesses();
  document.getElementById("process-editor-title").textContent = process.name;
  document.getElementById("step-form-heading").textContent = state.editingStepId ? "Edit a step" : "Add a step";
  document.getElementById("process-meta-form").hidden = false;
  document.getElementById("process-edit-name").value = process.name;
  document.getElementById("process-edit-description").value = process.description || "";
  document.getElementById("step-form").hidden = false;
  document.getElementById("process-actions").hidden = false;
  const result = document.getElementById("process-test-result");
  result.hidden = true;
  updateSaveTemplateButton();
  const dependencies = document.getElementById("step-dependencies");
  const availableDependencies = process.steps.filter((step) => step.id !== state.editingStepId);
  dependencies.innerHTML = availableDependencies.map((step) =>
    `<label><input type="checkbox" value="${step.id}"><span>${escapeHtml(step.title)}</span></label>`
  ).join("");
  document.getElementById("step-dependencies-search").value = "";
  document.getElementById("step-dependencies-empty").hidden = availableDependencies.length > 0;
  document.getElementById("step-dependencies-no-results").hidden = true;
  document.getElementById("step-assignee").value = state.user?.id ? String(state.user.id) : "";
  document.getElementById("process-step-list").classList.toggle("empty-state", process.steps.length === 0);
  document.getElementById("process-step-list").innerHTML = process.steps.length
    ? process.steps.map((step, index) => `<article class="step-card">
        <span class="step-number">${index + 1}</span>
        <div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p>
          <small>${escapeHtml(step.stage)} · Role: ${escapeHtml(step.owner || "Not assigned")} · Due ${step.due_offset_days} days after start</small>
          <small>Assigned to: ${escapeHtml(step.assignee_email || "No workspace member assigned")}</small>
          ${step.customer_visible ? '<small class="badge ready">Visible to customer</small>' : ""}
          ${state.data.plan?.features.dependencies && step.dependsOn.length ? `<small>Prerequisites: ${escapeHtml(step.dependsOn.map((id) => process.steps.find((item) => item.id === id)?.title || "").filter(Boolean).join(", "))}</small>` : ""}
        </div>
        <div class="button-row">
          <button class="text-button" type="button" data-edit-step="${step.id}">Edit</button>
          <button class="text-button" type="button" data-step-up="${step.id}" ${index === 0 ? "disabled" : ""}>↑</button>
          <button class="text-button" type="button" data-step-down="${step.id}" ${index === process.steps.length - 1 ? "disabled" : ""}>↓</button>
          <button class="text-button" type="button" data-delete-step="${step.id}">Delete</button>
        </div>
      </article>`).join("")
    : `<div class="empty-state"><strong>This process map has no steps yet</strong><p>Add one task your team completes for a new customer, with clear instructions and a responsible role. One step is enough to start; you can add more later.</p><button class="button secondary" type="button" data-workflow-action="focus-step">Add the first step</button></div>`;
  const templateScope = document.getElementById("requirement-template");
  const selectedScope = templateScope.value;
  templateScope.innerHTML = '<option value="">Every implementation</option>' + state.data.templates
    .map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  if ([...templateScope.options].some((option) => option.value === selectedScope)) templateScope.value = selectedScope;
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
    const next = getNextWorkflowAction();
    container.innerHTML = `<div class="empty-state"><strong>No templates yet</strong><p>A checked process becomes a reusable starting point for each new customer implementation.</p><button class="button secondary" type="button" data-workflow-action="${next.action}">${escapeHtml(next.label)}</button></div>`;
    return;
  }
  container.innerHTML = state.data.templates.map((template) => `
    <article class="template-card">
      <span class="badge ready">Reusable workflow</span>
      <form data-edit-template="${template.id}">
        <label for="template-name-${template.id}">Template name</label>
        <input id="template-name-${template.id}" name="name" maxlength="100" value="${escapeHtml(template.name)}" required>
        <p>${template.step_count} process steps · ${state.data.plan?.features.templateHistory ? `Revision ${template.revision}` : "Current version"}</p>
        <p>Starting an implementation copies this version into an independent customer work plan.</p>
        <button class="button secondary" type="submit">Save name</button>
      </form>
      <button class="text-button" type="button" data-refresh-template="${template.id}">Refresh from tested process</button>
      <details data-template-history="${template.id}" data-growth-only="templateHistory">
        <summary>Version history</summary>
        <button class="text-button" type="button" data-load-template-versions="${template.id}">Load versions</button>
        <ol data-template-version-list="${template.id}"></ol>
      </details>
      <button class="text-button" type="button" data-delete-template="${template.id}">Delete template</button>
      <button class="button secondary" type="button" data-start-template="${template.id}">Use template</button>
    </article>`).join("");
}

function renderImplementations() {
  const form = document.getElementById("implementation-form");
  const prerequisite = document.getElementById("implementation-prerequisite");
  form.hidden = state.data.templates.length === 0;
  prerequisite.hidden = state.data.templates.length > 0;
  if (!prerequisite.hidden) {
    const next = getNextWorkflowAction();
    prerequisite.innerHTML = emptyStateMarkup(
      "A template is needed first",
      "Templates are checked process snapshots. Create a process map, save its steps, run the check, then create a template.",
      next.label,
      next.action
    );
  }
  const ownerFilter = document.getElementById("implementation-owner-filter");
  const selectedOwner = state.implementationFilters.owner;
  ownerFilter.innerHTML = '<option value="all">All owners</option><option value="unassigned">Has unassigned tasks</option>'
    + state.data.members.map((member) => `<option value="${member.id}">${escapeHtml(member.email)}</option>`).join("");
  ownerFilter.value = [...ownerFilter.options].some((option) => option.value === selectedOwner) ? selectedOwner : "all";
  const filtered = filteredImplementations();
  const filterActive = state.implementationFilters.search || state.implementationFilters.status !== "all"
    || state.implementationFilters.owner !== "all" || state.implementationFilters.attention !== "all";
  document.getElementById("implementation-filter-summary").textContent =
    `${filtered.length} of ${state.data.implementations.length} implementation${state.data.implementations.length === 1 ? "" : "s"} shown`;
  document.getElementById("implementation-list").innerHTML = filtered.length
    ? renderImplementationTable(filtered)
    : state.data.implementations.length && filterActive
      ? `<div class="empty-state"><strong>No implementations match these filters</strong><p>Try changing a filter or clear them to see every customer.</p><button class="button secondary" type="button" data-clear-implementation-filters>Clear filters</button></div>`
      : renderImplementationTable(filtered);
}

function renderRequirements() {
  const container = document.getElementById("requirement-list");
  if (!state.data.requirements.length) {
    container.innerHTML = `<div class="empty-state"><strong>No customer information requests yet</strong><p>Add only the specific information a customer needs to provide during setup. You can make a request optional or limit it to one template.</p><button class="button secondary" type="button" data-workflow-action="add-requirement">Create an information request</button></div>`;
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
  renderPlanSummary();
  renderOverview();
  renderPortfolio();
  renderProcesses();
  renderTemplates();
  renderImplementations();
  renderRequirements();
  renderTeam();
  renderNotificationSettings();
  renderIntegrations();
  renderAutomationAndCapacity();
  renderGettingStarted();
}

async function openImplementation(implementationId) {
  if (dirtyScopes.size && !confirmDiscardChanges()) return false;
  const { implementation } = await api(`/api/product/implementations/${implementationId}`);
  state.selectedImplementationId = implementation.id;
  const panel = document.getElementById("implementation-detail");
  panel.hidden = false;
  document.getElementById("implementation-detail-title").textContent = implementation.customer_name;
  document.getElementById("implementation-detail-subtitle").textContent = `Started from ${implementation.template_name}`;
  document.getElementById("implementation-plan-owner").value = implementation.customer_owner_name || "";
  document.getElementById("implementation-plan-email").value = implementation.customer_owner_email || "";
  document.getElementById("implementation-plan-date").value = implementation.target_launch_date || "";
  document.getElementById("implementation-plan-status").textContent = "";
  document.getElementById("launch-success-criteria").value = implementation.success_criteria || "";
  document.getElementById("launch-test-plan").value = implementation.test_plan || "";
  document.getElementById("launch-rollback-plan").value = implementation.rollback_plan || "";
  document.getElementById("launch-acceptance-status").value = implementation.acceptance_status || "not_started";
  document.getElementById("launch-training-status").value = implementation.training_status || "not_started";
  document.getElementById("launch-go-live-status").value = implementation.go_live_status || "not_ready";
  document.getElementById("launch-support-name").value = implementation.support_owner_name || "";
  document.getElementById("launch-support-email").value = implementation.support_owner_email || "";
  document.getElementById("launch-readiness-status").textContent = "";
  document.getElementById("gap-communication-channel").value = implementation.communication_channel || "";
  document.getElementById("gap-communication-cadence").value = implementation.communication_cadence || "";
  document.getElementById("gap-communication-owner-name").value = implementation.communication_owner_name || "";
  document.getElementById("gap-communication-owner-email").value = implementation.communication_owner_email || "";
  document.getElementById("gap-procurement-status").value = implementation.procurement_status || "not_started";
  document.getElementById("gap-security-status").value = implementation.security_status || "not_started";
  document.getElementById("gap-security-notes").value = implementation.security_notes || "";
  document.getElementById("gap-integration-inventory").value = implementation.integration_inventory || "";
  document.getElementById("gap-integration-status").value = implementation.integration_status || "not_started";
  document.getElementById("gap-technical-status").value = implementation.technical_setup_status || "not_started";
  document.getElementById("gap-technical-notes").value = implementation.technical_setup_notes || "";
  document.getElementById("gap-change-status").value = implementation.change_management_status || "not_started";
  document.getElementById("gap-adoption-notes").value = implementation.adoption_notes || "";
  document.getElementById("gap-validation-status").value = implementation.early_validation_status || "not_started";
  document.getElementById("gap-validation-notes").value = implementation.early_validation_notes || "";
  document.getElementById("gap-support-plan").value = implementation.post_launch_support_plan || "";
  document.getElementById("gap-duplicate-control").value = implementation.duplicate_request_control || "";
  document.getElementById("gap-plan-status").textContent = "";
  document.getElementById("sow-scope").value = implementation.sow_scope || "";
  document.getElementById("sow-milestones").value = implementation.sow_milestones || "";
  document.getElementById("sow-exclusions").value = implementation.sow_exclusions || "";
  document.getElementById("sow-stage-gate").value = implementation.stage_gate_status || "kickoff";
  const financial = implementation.financialPlan || {};
  document.getElementById("finance-budget").value = financial.budget_amount || "";
  document.getElementById("finance-forecast").value = financial.forecast_amount || "";
  document.getElementById("finance-cost").value = financial.actual_cost || "";
  document.getElementById("finance-invoice-status").value = financial.invoice_status || "not_started";
  document.getElementById("finance-invoice-reference").value = financial.invoice_reference || "";
  document.getElementById("finance-margin-note").value = financial.margin_note || "";
  const deliveryItems = [];
  deliveryItems.push(...(implementation.timeEntries || []).slice(0, 5).map((entry) =>
    `<article class="list-row"><div><strong>${Math.floor(entry.minutes / 60)}h ${entry.minutes % 60}m</strong><small>${escapeHtml(entry.work_date)} · ${entry.billable ? "Billable" : "Non-billable"} · ${escapeHtml(entry.user_email || "Team member")}</small></div><button class="text-button danger-text" type="button" data-delete-time-entry="${entry.id}">Delete</button></article>`));
  deliveryItems.push(...(implementation.approvals || []).map((approval) =>
    `<article class="list-row"><div><strong>${escapeHtml(approval.title)}</strong><small>${escapeHtml(approval.approval_type)} · ${escapeHtml(approval.status)}${approval.due_at ? ` · Due ${escapeHtml(approval.due_at)}` : ""}</small></div><div class="button-row">${approval.status !== "approved" ? `<button class="text-button" type="button" data-approval-status="${approval.id}">Approve</button>` : ""}<button class="text-button danger-text" type="button" data-delete-approval="${approval.id}">Delete</button></div></article>`));
  deliveryItems.push(...(implementation.calendarEvents || []).slice(0, 5).map((event) =>
    `<article class="list-row"><div><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.event_type)} · ${escapeHtml(event.start_at)}</small></div><button class="text-button danger-text" type="button" data-delete-calendar-event="${event.id}">Delete</button></article>`));
  document.getElementById("delivery-operations-summary").innerHTML = deliveryItems.length
    ? deliveryItems.join("") : '<p class="muted">No time, approval, or calendar records yet.</p>';
  document.getElementById("launch-stakeholder-list").innerHTML = (implementation.launchStakeholders || []).length
    ? implementation.launchStakeholders.map((stakeholder) => `
      <article class="list-row">
        <div><strong>${escapeHtml(stakeholder.display_name || stakeholder.email)}</strong>
          <small>${escapeHtml(stakeholder.role || "Stakeholder")} · ${escapeHtml(stakeholder.email)}</small>
          <small>${stakeholder.approval_status === "approved" ? "Approved" : stakeholder.approval_status === "blocked" ? "Blocked" : "Pending"}${stakeholder.next_action ? ` · ${escapeHtml(stakeholder.next_action)}` : ""}</small></div>
        <button class="text-button danger-text" type="button" data-delete-launch-stakeholder="${stakeholder.id}">Remove</button>
      </article>`).join("")
    : '<p class="muted">No stakeholders or approvals recorded.</p>';
  document.getElementById("launch-risk-list").innerHTML = (implementation.launchRisks || []).length
    ? implementation.launchRisks.map((risk) => `
      <article class="list-row">
        <div><strong>${escapeHtml(risk.title)}</strong>
          <small>${escapeHtml(risk.category)} · ${escapeHtml(risk.severity)} · ${escapeHtml(risk.status)}${risk.due_at ? ` · Due ${escapeHtml(risk.due_at)}` : ""}</small>
          ${risk.owner_name || risk.owner_email ? `<small>Owner: ${escapeHtml(risk.owner_name || risk.owner_email)}</small>` : ""}
          ${risk.next_action ? `<small>Next action: ${escapeHtml(risk.next_action)}</small>` : ""}</div>
        <button class="text-button danger-text" type="button" data-delete-launch-risk="${risk.id}">Resolve/remove</button>
      </article>`).join("")
    : '<p class="muted">No launch risks recorded.</p>';
  document.getElementById("customer-contact-status").textContent = "";
  document.getElementById("customer-contact-list").innerHTML = (implementation.customerContacts || []).length
    ? implementation.customerContacts.map((contact) => {
      const expired = Date.parse(contact.expires_at) <= Date.now();
      const active = !contact.revoked_at && !expired;
      return `<article class="list-row">
        <div><strong>${escapeHtml(contact.display_name || contact.email)}</strong><small>${escapeHtml(contact.email)}</small>
          <small>${active ? `${contact.invitation_sent_at ? "Invitation sent" : "Invitation not sent"} · Link expires ${new Date(contact.expires_at).toLocaleDateString()}` : contact.revoked_at ? "Access revoked" : "Link expired"}</small></div>
        <div class="button-row">
          ${active && !contact.invitation_sent_at ? `<button class="text-button" type="button" data-resend-customer-contact="${contact.id}" data-contact-email="${escapeHtml(contact.email)}" data-contact-name="${escapeHtml(contact.display_name || "")}">Send invitation</button>` : ""}
          ${active ? `<button class="text-button danger-text" type="button" data-revoke-customer-contact="${contact.id}">Revoke</button>` : ""}
        </div>
      </article>`;
    }).join("")
    : '<p class="muted">No named customer contacts invited yet.</p>';
  document.getElementById("implementation-step-list").innerHTML = implementation.steps.length
    ? implementation.steps.map((step, index) => `
      <article class="step-card">
        <span class="step-number">${index + 1}</span>
        <div class="task-main"><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p>
          <small>${escapeHtml(step.stage)} · Role: ${escapeHtml(step.owner || "Not assigned")} · Due ${escapeHtml(step.due_at || "not scheduled")}</small>
          <small>Assigned to: ${escapeHtml(step.assignee_email || "No workspace member assigned")}</small>
          ${state.data.plan?.features.dependencies && step.waiting_on ? `<small>Waiting on: ${escapeHtml(step.waiting_on)}</small>` : ""}
          ${state.data.plan?.features.blockers && step.is_blocked ? `<p class="status warning"><strong>Blocked:</strong> ${escapeHtml(step.blocker_reason)}<br><strong>Next action:</strong> ${escapeHtml(step.blocker_next_action)}</p>` : ""}
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
          <label class="check-field"><input data-task-customer-visible="${step.id}" type="checkbox" ${step.customer_visible ? "checked" : ""}> Show to customer in portal</label>
          <label class="check-field" data-growth-only="blockers"><input data-task-blocked="${step.id}" type="checkbox" ${step.is_blocked ? "checked" : ""}> Blocked</label>
          <label data-growth-only="blockers">Blocker reason<textarea data-task-reason="${step.id}" maxlength="500">${escapeHtml(step.blocker_reason)}</textarea></label>
          <label data-growth-only="blockers">Next action<textarea data-task-action="${step.id}" maxlength="500">${escapeHtml(step.blocker_next_action)}</textarea></label>
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
    : '<div class="empty-state"><strong>No customer information requested</strong><p>Add a specific request if this customer needs to provide setup details.</p><button class="button secondary" type="button" data-workflow-action="add-requirement">Create an information request</button></div>';
  const linkBox = document.getElementById("customer-link-box");
  linkBox.hidden = false;
  linkBox.innerHTML = implementation.has_customer_link
    ? "<strong>Previous shared-link access is still active.</strong><br>Invite a named contact above to revoke the shared link and use individually revocable portal access.<br>"
    : "";
  linkBox.insertAdjacentHTML("beforeend", `
    <form class="inline-form vertical customer-escalation-form">
      <div class="field">
        <label for="customer-escalation-email">Backup customer contact</label>
        <input id="customer-escalation-email" type="email" maxlength="254" value="${escapeHtml(implementation.escalation_email || "")}" placeholder="backup@example.com">
      </div>
      <div class="field">
        <label for="customer-escalation-delay">Escalate after (days)</label>
        <input id="customer-escalation-delay" type="number" min="3" max="30" step="1" value="${escapeHtml(implementation.escalation_delay_days ?? 5)}" required>
      </div>
      <small>Relay flags silence after 3 days. If required information is still missing after this delay, it emails the backup contact. Email notifications and a configured sender are required.</small>
      <button class="button secondary" type="submit">Save backup contact</button>
    </form>`);
  document.getElementById("implementation-file-list").innerHTML = (implementation.customerFiles || []).length
    ? implementation.customerFiles.map((file) => `
      <article class="list-row">
        <div>${file.demo ? `<strong>${escapeHtml(file.filename)}</strong>` : `<a href="/api/product/implementations/${implementation.id}/files/${file.id}">${escapeHtml(file.filename)}</a>`}
          <small>${escapeHtml(file.uploaded_by_name || "Customer team")} · ${Math.ceil(file.size_bytes / 1024)} KB</small></div>
        <button class="text-button danger-text" type="button" data-delete-customer-file="${file.id}">Delete</button>
      </article>`).join("")
    : '<p class="muted">No files shared yet.</p>';
  document.getElementById("implementation-message-list").innerHTML = (implementation.customerMessages || []).length
    ? implementation.customerMessages.map((message) => `
      <article class="customer-message ${message.sender_role === "customer" ? "from-customer" : "from-team"}">
        <strong>${escapeHtml(message.sender_name || message.sender_email || "Customer")}</strong>
        <p>${escapeHtml(message.body)}</p><small>${escapeHtml(new Date(message.created_at).toLocaleString())}</small>
      </article>`).join("")
    : '<p class="muted">No customer messages yet.</p>';
  document.getElementById("implementation-message-status").textContent = "";
  document.getElementById("implementation-message").value = "";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

async function refreshWorkspace() {
  if (!await loadWorkspace()) return false;
  if (state.selectedImplementationId && !document.getElementById("implementation-detail").hidden) {
    return openImplementation(state.selectedImplementationId);
  }
  return true;
}

authTabs.login.addEventListener("click", () => setAuthMode("login"));
authTabs.signup.addEventListener("click", () => setAuthMode("signup"));
function setPasswordVisibility(button, isVisible) {
  const input = document.getElementById(button.dataset.passwordToggle);
  input.type = isVisible ? "text" : "password";
  button.setAttribute("aria-label", isVisible ? "Hide password" : "Show password");
  button.setAttribute("aria-pressed", String(isVisible));
  button.querySelectorAll("svg").forEach((icon, index) => {
    icon.hidden = index !== Number(isVisible);
  });
}

document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.passwordToggle);
    setPasswordVisibility(button, input.type === "password");
  });
});
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
  const form = event.currentTarget;
  const status = document.getElementById("password-reset-complete-status");
  const button = form.querySelector('button[type="submit"]');
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
    document.getElementById("reset-password").value = "";
    document.getElementById("reset-password-confirm").value = "";
    form.querySelectorAll("[data-password-toggle]").forEach((toggle) => setPasswordVisibility(toggle, false));
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
        inviteToken: state.inviteToken || undefined
      }
    });
    state.user = data.user;
    state.workspace = data.workspace;
    await loadPreferences();
    if (state.inviteToken) {
      state.inviteToken = "";
      window.history.replaceState(null, "", window.location.pathname);
    }
    showProduct();
    await loadOnboarding();
    await loadWorkspace();
    await loadHelpHistory();
    void loadJustOneCXIdentity();
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
  if (!button || !window.confirm("Revoke this pending invitation?") || !confirmDiscardChanges()) return;
  try {
    await api(`/api/product/invites/${button.dataset.revokeInvite}`, { method: "DELETE" });
    state.inviteUrl = "";
    await loadWorkspace();
    showToast("Invitation revoked.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("notification-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = formStatus(form);
  status.textContent = "Saving notification preferences...";
  try {
    const settings = await api("/api/product/notifications", {
      method: "PATCH",
      body: {
        emailEnabled: document.getElementById("notifications-email-enabled").checked,
        reminderDaysBefore: Number(document.getElementById("notifications-reminder-days").value)
      }
    });

    document.getElementById("capacity-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = document.getElementById("capacity-status");
      try {
        await api("/api/product/capacity-plans", {
          method: "POST",
          body: {
            userId: document.getElementById("capacity-user").value,
            weekStart: document.getElementById("capacity-week").value,
            availableMinutes: Number(document.getElementById("capacity-minutes").value),
            capacityNote: document.getElementById("capacity-note").value
          }
        });
        await refreshWorkspace();
        status.textContent = "Capacity plan saved.";
      } catch (error) {
        status.textContent = error.message;
      }
    });

    state.data.notificationSettings = {
      email_enabled: settings.emailEnabled,
      reminder_days_before: settings.reminderDaysBefore
    };
    status.textContent = "Notification preferences saved.";
  } catch (error) {
    if (activeSubmissionForm === form) activeSubmissionForm = null;
    finishForm(form, error.message);
    status.setAttribute("role", "alert");
  }
});

document.getElementById("integration-list").addEventListener("click", async (event) => {
  const connect = event.target.closest("[data-connect-integration]");
  const disconnect = event.target.closest("[data-disconnect-integration]");
  if (!connect && !disconnect) return;
  try {
    if (connect) {
      const { authorizationUrl } = await api(`/api/product/integrations/${connect.dataset.connectIntegration}/connect`, {
        method: "POST",
        body: {}
      });
      if (isWorkspaceDemo) {
        await loadWorkspace();
        document.getElementById("integration-status").textContent =
          "Preview only: no external integration was authorized or connected.";
        return;
      }
      window.location.assign(authorizationUrl);
      return;
    }
    if (!window.confirm(`Disconnect ${disconnect.dataset.disconnectIntegration}?`)) return;
    await api(`/api/product/integrations/${disconnect.dataset.disconnectIntegration}`, { method: "DELETE" });
    if (disconnect.dataset.disconnectIntegration === "hubspot") {
      hubspotPipelineCache = [];
      hubspotConfigurationLoaded = false;
    }
    await loadWorkspace();
    showToast("Integration disconnected.");
  } catch (error) {
    document.getElementById("integration-status").textContent = error.message;
  }
});
document.getElementById("hubspot-pipeline").addEventListener("change", () => populateHubspotStages());
document.getElementById("hubspot-handoff-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("hubspot-handoff-status");
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  status.textContent = "";
  try {
    const result = await api("/api/product/integrations/hubspot/onboarding", {
      method: "PUT",
      body: {
        pipelineId: document.getElementById("hubspot-pipeline").value,
        stageId: document.getElementById("hubspot-stage").value,
        templateId: document.getElementById("hubspot-template").value
      }
    });
    status.textContent = result.message;
    await refreshWorkspace();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
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

document.getElementById("mobile-nav-toggle").addEventListener("click", () => {
  const isOpen = document.getElementById("mobile-nav-toggle").getAttribute("aria-expanded") === "true";
  setMobileNavigationOpen(!isOpen);
  if (!isOpen) document.querySelector("#sidebar .nav-item.active")?.focus();
});
document.getElementById("sidebar-backdrop").addEventListener("click", () => {
  setMobileNavigationOpen(false);
  document.getElementById("mobile-nav-toggle").focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.getElementById("mobile-nav-toggle").getAttribute("aria-expanded") === "true") {
    setMobileNavigationOpen(false);
    document.getElementById("mobile-nav-toggle").focus();
  }
});
window.addEventListener("resize", () => {
  const isMobile = window.matchMedia("(max-width: 650px)").matches;
  const isOpen = document.getElementById("mobile-nav-toggle").getAttribute("aria-expanded") === "true";
  setMobileNavigationOpen(isMobile && isOpen);
});
setMobileNavigationOpen(false);
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.go)));
document.getElementById("refresh-button").addEventListener("click", () => refreshWorkspace().catch(showError));
document.getElementById("implementation-search").addEventListener("input", (event) => {
  state.implementationFilters.search = event.currentTarget.value;
  renderImplementations();
});
document.getElementById("implementation-status-filter").addEventListener("change", (event) => {
  state.implementationFilters.status = event.currentTarget.value;
  renderImplementations();
});
document.getElementById("implementation-owner-filter").addEventListener("change", (event) => {
  state.implementationFilters.owner = event.currentTarget.value;
  renderImplementations();
});
document.getElementById("implementation-attention-filter").addEventListener("change", (event) => {
  state.implementationFilters.attention = event.currentTarget.value;
  renderImplementations();
});
document.getElementById("clear-implementation-filters").addEventListener("click", clearImplementationFilters);

function clearImplementationFilters() {
  state.implementationFilters = { search: "", status: "all", owner: "all", attention: "all" };
  document.getElementById("implementation-search").value = "";
  document.getElementById("implementation-status-filter").value = "all";
  document.getElementById("implementation-owner-filter").value = "all";
  document.getElementById("implementation-attention-filter").value = "all";
  renderImplementations();
}

document.getElementById("implementation-list").addEventListener("click", (event) => {
  if (event.target.closest("[data-clear-implementation-filters]")) clearImplementationFilters();
});
document.getElementById("dismiss-getting-started").addEventListener("click", async () => {
  const status = document.getElementById("getting-started-status");
  try {
    const result = await api("/api/product/onboarding", { method: "PATCH", body: { dismissed: true } });
    state.onboardingDismissed = result.dismissed;
    renderGettingStarted();
  } catch (error) {
    status.textContent = error.message;
  }
});
document.getElementById("show-getting-started").addEventListener("click", async () => {
  const status = document.getElementById("getting-started-status");
  try {
    const result = await api("/api/product/onboarding", { method: "PATCH", body: { dismissed: false } });
    state.onboardingDismissed = result.dismissed;
    renderGettingStarted();
  } catch (error) {
    status.textContent = error.message;
  }
});
appShell.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-workflow-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.workflowAction;
  if (action === "create-process") {
    if (!setView("processes")) return;
    document.getElementById("process-name").focus();
    return;
  }
  if (action === "map-process" || action === "focus-step" || action === "check-process" || action === "save-template") {
    const process = action === "save-template"
      ? state.data.processes.find((item) => item.checked) || state.data.processes[0]
      : action === "check-process"
        ? state.data.processes.find((item) => item.steps_count > 0 && !item.checked)
          || state.data.processes.find((item) => item.steps_count > 0)
          || state.data.processes[0]
        : state.data.processes.find((item) => item.steps_count === 0)
          || state.data.processes[0];
    if (!process) {
      if (!setView("processes")) return;
      document.getElementById("process-name").focus();
      return;
    }
    try {
      if (!setView("processes")) return;
      await loadProcess(process.id);
      if (action === "check-process") {
        document.getElementById("test-process").focus();
      } else if (action === "save-template" && process.checked) {
        document.getElementById("save-template").focus();
      } else if (process.steps_count === 0) {
        document.getElementById("step-title").focus();
      } else {
        document.getElementById("process-step-list").focus();
      }
    } catch (error) {
      showError(error);
    }
    return;
  }
  if (action === "start-implementation") {
    if (!state.data.templates.length) {
      if (!setView("processes")) return;
      document.getElementById("process-name").focus();
      return;
    }
    if (!setView("implementations")) return;
    document.getElementById("implementation-customer").focus();
    return;
  }
  if (action === "add-requirement") {
    if (!setView("requirements")) return;
    document.getElementById("requirement-name").focus();
  }
});
document.getElementById("theme-mode").addEventListener("change", (event) => {
  savePreference("theme", event.currentTarget.value);
});
document.getElementById("theme-accent").addEventListener("change", (event) => {
  savePreference("accent", event.currentTarget.value);
});
document.getElementById("account-deletion-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById("account-deletion-status");
  if (!window.confirm("Permanently delete your Relay account and apply the workspace changes listed above? This cannot be undone.")) {
    return;
  }
  const password = document.getElementById("account-delete-password").value;
  const confirmation = document.getElementById("account-delete-confirmation").value;
  const transfers = [...form.querySelectorAll("[data-account-delete-transfer]")].map((select) => ({
    workspaceId: Number(select.dataset.accountDeleteTransfer),
    newOwnerUserId: Number(select.value)
  }));
  setFormBusy(form, "Deleting your account...");
  activeSubmissionForm = form;
  status.setAttribute("role", "status");
  status.textContent = "Deleting your account…";
  try {
    await api("/api/product/account", {
      method: "DELETE",
      body: {
        password,
        confirmation,
        transfers
      }
    });
    form.reset();
    resetJustOneCXIdentity();
    showAuth("Your Relay account has been deleted.");
  } catch (error) {
    failForm(form, error);
    activeSubmissionForm = null;
    status.textContent = error.message;
    status.setAttribute("role", "alert");
  }
});
document.getElementById("signout-button").addEventListener("click", async () => {
  try {
    await api("/api/product/auth/logout", { method: "POST", body: {} });
    state.helpMessages = [];
    renderHelpMessages();
    resetJustOneCXIdentity();
    showAuth("You have signed out.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("help-open").addEventListener("click", async () => {
  const panel = document.getElementById("help-panel");
  const open = panel.hidden;
  panel.hidden = !open;
  document.getElementById("help-open").setAttribute("aria-expanded", String(open));
  if (open) {
    if (isRayDemo) {
      document.getElementById("help-input").focus();
      return;
    }
    try {
      await loadHelpHistory();
      document.getElementById("help-input").focus();
    } catch (error) {
      document.getElementById("help-status").textContent = error.message;
    }
  }
});

document.getElementById("help-close").addEventListener("click", () => {
  document.getElementById("help-panel").hidden = true;
  document.getElementById("help-open").setAttribute("aria-expanded", "false");
  document.getElementById("help-open").focus();
});

document.getElementById("help-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("help-input");
  const button = document.getElementById("help-send");
  const status = document.getElementById("help-status");
  const message = input.value.trim();
  if (!message) return;
  button.disabled = true;
  status.textContent = "Ray is preparing an answer...";
  if (isRayDemo) {
    state.helpMessages.push(
      { role: "user", content: message },
      { role: "assistant", content: rayDemoReply(message) }
    );
    input.value = "";
    status.textContent = "";
    renderHelpMessages();
    button.disabled = false;
    input.focus();
    return;
  }
  try {
    const result = await api("/api/product/help-chat", {
      method: "POST",
      body: { message }
    });
    state.helpMessages.push({ role: "user", content: message }, result.message);
    if (state.helpMessages.length > 50) state.helpMessages = state.helpMessages.slice(-50);
    input.value = "";
    status.textContent = "";
    renderHelpMessages();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    input.focus();
  }
});

document.getElementById("help-clear").addEventListener("click", async () => {
  if (!window.confirm("Clear your Ray conversation history for this account?")) return;
  const button = document.getElementById("help-clear");
  const status = document.getElementById("help-status");
  button.disabled = true;
  if (isRayDemo) {
    state.helpMessages = [];
    renderHelpMessages();
    status.textContent = "Demo conversation cleared.";
    button.disabled = false;
    return;
  }
  try {
    await api("/api/product/help-chat", { method: "DELETE" });
    state.helpMessages = [];
    renderHelpMessages();
    status.textContent = "Your help history was cleared.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("ray-demo-open").addEventListener("click", () => {
  document.getElementById("help-panel").hidden = false;
  document.getElementById("help-open").setAttribute("aria-expanded", "true");
  document.getElementById("help-input").focus();
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
    document.getElementById("step-title").focus();
    showToast("Process map created.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("process-list").addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-select-process]");
  if (openButton) {
    if (openButton.disabled) return;
    openButton.disabled = true;
    const openLabel = openButton.textContent;
    openButton.textContent = "Opening...";
    loadProcess(openButton.dataset.selectProcess).then((loaded) => {
      if (loaded) state.editingStepId = null;
    }).catch(showError).finally(() => {
      if (openButton.isConnected) {
        openButton.disabled = false;
        openButton.textContent = openLabel;
      }
    });
    return;
  }
  const deleteButton = event.target.closest("[data-delete-process]");
  if (!deleteButton || !window.confirm("Delete this process map? Saved templates must be deleted first.")
    || !confirmDiscardChanges()) return;
  api(`/api/product/processes/${deleteButton.dataset.deleteProcess}`, { method: "DELETE" })
    .then(async () => {
      if (state.selectedProcessId === Number(deleteButton.dataset.deleteProcess)) {
        state.selectedProcessId = null;
        state.process = null;
        state.editingStepId = null;
        document.getElementById("process-meta-form").hidden = true;
        document.getElementById("step-form").hidden = true;
        document.getElementById("process-actions").hidden = true;
        document.getElementById("process-editor-title").textContent = "Select a process";
        document.getElementById("process-test-result").hidden = true;
        document.getElementById("process-step-list").innerHTML = '<strong>No process selected</strong><p>Choose an existing process map or create your first one to start outlining the work.</p><button class="button secondary" type="button" data-workflow-action="create-process">Create a process map</button>';
      }
      await loadWorkspace();
      showToast("Process map deleted.");
    })
    .catch(showError);
});

document.getElementById("process-meta-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!state.selectedProcessId) return;
  try {
    await api(`/api/product/processes/${state.selectedProcessId}`, {
      method: "PATCH",
      body: {
        name: document.getElementById("process-edit-name").value,
        description: document.getElementById("process-edit-description").value
      }
    });
    clearDirtyScope(form);
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
  const form = event.currentTarget;
  const processMetaForm = document.getElementById("process-meta-form");
  const processDetailsWereDirty = dirtyScopes.has(processMetaForm);
  const stepTitle = document.getElementById("step-title").value.trim();
  const savedStepId = state.editingStepId;
  try {
    if (processDetailsWereDirty) {
      const stepSubmissionForm = activeSubmissionForm;
      setFormBusy(processMetaForm, "Saving process...");
      activeSubmissionForm = null;
      try {
        await api(`/api/product/processes/${state.selectedProcessId}`, {
          method: "PATCH",
          body: {
            name: document.getElementById("process-edit-name").value,
            description: document.getElementById("process-edit-description").value
          }
        });
        finishForm(processMetaForm, "Saved.");
      } catch (error) {
        failForm(processMetaForm, error);
        throw error;
      } finally {
        activeSubmissionForm = stepSubmissionForm;
      }
    }
    const result = await api(`/api/product/processes/${state.selectedProcessId}/steps${state.editingStepId ? `/${state.editingStepId}` : ""}`, {
      method: state.editingStepId ? "PATCH" : "POST",
      body: {
        title: document.getElementById("step-title").value,
        description: document.getElementById("step-description").value,
        owner: document.getElementById("step-owner").value,
        assigneeUserId: document.getElementById("step-assignee").value || null,
        stage: document.getElementById("step-stage").value,
        dueOffsetDays: Number(document.getElementById("step-due-offset").value),
        customerVisible: document.getElementById("step-customer-visible").checked,
        dependsOn: [...document.querySelectorAll("#step-dependencies input:checked")].map((input) => Number(input.value))
      }
    });
    clearDirtyScope(form);
    const displayedStepId = savedStepId || result.step.id;
    state.editingStepId = null;
    form.reset();
    document.getElementById("step-stage").value = "Implementation";
    document.getElementById("step-due-offset").value = "0";
    document.getElementById("step-customer-visible").checked = false;
    document.getElementById("step-form-heading").textContent = "Add a step";
    document.getElementById("step-submit").textContent = "Save step";
    document.getElementById("cancel-step-edit").hidden = true;
    await loadProcess(state.selectedProcessId);
    await loadWorkspace();
    document.querySelector(`#process-step-list [data-edit-step="${displayedStepId}"]`)
      ?.closest(".step-card")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    const status = formStatus(form);
    status.textContent = processDetailsWereDirty
      ? `Saved the process details and "${stepTitle}". The step is listed above; the form is ready for another step.`
      : `Saved "${stepTitle}" to this process. It is listed above; the form is ready for another step.`;
    showToast("Process step saved.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("cancel-step-edit").addEventListener("click", () => {
  if (dirtyScopes.size && !confirmDiscardChanges()) return;
  state.editingStepId = null;
  const form = document.getElementById("step-form");
  form.reset();
  document.getElementById("step-stage").value = "Implementation";
  document.getElementById("step-due-offset").value = "0";
  document.getElementById("step-customer-visible").checked = false;
  document.getElementById("step-form-heading").textContent = "Add a step";
  document.getElementById("step-submit").textContent = "Save step";
  document.getElementById("cancel-step-edit").hidden = true;
  if (state.selectedProcessId) loadProcess(state.selectedProcessId).catch(showError);
});

document.getElementById("process-step-list").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-step]");
  if (edit && state.process) {
    if (dirtyScopes.size && !confirmDiscardChanges()) return;
    const step = state.process.steps.find((item) => item.id === Number(edit.dataset.editStep));
    if (!step) return;
    state.editingStepId = step.id;
    document.getElementById("step-title").value = step.title;
    document.getElementById("step-description").value = step.description;
    document.getElementById("step-owner").value = step.owner;
    document.getElementById("step-assignee").value = step.assignee_user_id ? String(step.assignee_user_id) : "";
    document.getElementById("step-stage").value = step.stage;
    document.getElementById("step-due-offset").value = step.due_offset_days;
    document.getElementById("step-customer-visible").checked = step.customer_visible === true;
    document.getElementById("step-form-heading").textContent = "Edit a step";
    [...document.querySelectorAll("#step-dependencies input")].forEach((input) => {
      input.disabled = Number(input.value) === step.id;
      input.checked = step.dependsOn.includes(Number(input.value));
    });
    document.getElementById("step-submit").textContent = "Save step";
    document.getElementById("cancel-step-edit").hidden = false;
    document.getElementById("step-form").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const deleteStep = event.target.closest("[data-delete-step]");
  if (deleteStep) {
    if (!window.confirm("Delete this process step? Its prerequisite links will also be removed.")
      || !confirmDiscardChanges()) return;
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
    if (dirtyScopes.size && !confirmDiscardChanges()) return;
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

document.getElementById("step-dependencies-search").addEventListener("input", (event) => {
  const query = event.currentTarget.value.trim().toLocaleLowerCase();
  const options = [...document.querySelectorAll("#step-dependencies label")];
  for (const option of options) {
    option.hidden = !option.textContent.toLocaleLowerCase().includes(query);
  }
  document.getElementById("step-dependencies-no-results").hidden = !query
    || options.some((option) => !option.hidden);
});

document.getElementById("delete-process").addEventListener("click", () => {
  const button = document.querySelector(`[data-delete-process="${state.selectedProcessId}"]`);
  button?.click();
});

document.getElementById("test-process").addEventListener("click", async () => {
  if (!state.selectedProcessId) return showError(new Error("Choose a process to test."));
  if (hasUnsavedProcessDraft()) return showUnsavedProcessDraftNotice();
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
    state.process.checked = check.result === "ready";
    const processSummary = state.data.processes.find((process) => process.id === state.selectedProcessId);
    if (processSummary) processSummary.checked = state.process.checked;
    updateSaveTemplateButton();
    renderProcesses();
    renderOverview();
    showToast(check.result === "ready" ? "Setup check passed." : "Setup check found items to fix.", check.result !== "ready");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("save-template").addEventListener("click", async () => {
  if (!state.selectedProcessId) return showError(new Error("Choose a process to save."));
  if (hasUnsavedProcessDraft()) return showUnsavedProcessDraftNotice();
  const processName = document.getElementById("process-editor-title").textContent;
  try {
    await api("/api/product/templates", {
      method: "POST",
      body: { processId: state.selectedProcessId, name: `${processName} template` }
    });
    await loadWorkspace();
    setView("templates");
    showToast("Template created.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("template-list").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-edit-template]");
  if (!form) return;
  event.preventDefault();
  try {
    await api(`/api/product/templates/${form.dataset.editTemplate}`, {
      method: "PATCH",
      body: { name: form.querySelector('[name="name"]').value }
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
    const form = refreshButton.closest(".template-card").querySelector("form");
    const name = form.querySelector(`[name="name"]`).value;
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
    if (!window.confirm("Delete this template? Existing implementations cannot be deleted with it.")
      || !confirmDiscardChanges()) return;
    const deleteLabel = deleteButton.textContent;
    deleteButton.disabled = true;
    deleteButton.textContent = "Deleting...";
    try {
      await api(`/api/product/templates/${deleteButton.dataset.deleteTemplate}`, { method: "DELETE" });
      const deletedTemplateId = Number(deleteButton.dataset.deleteTemplate);
      state.data.templates = state.data.templates.filter((template) => template.id !== deletedTemplateId);
      renderTemplates();
      renderImplementations();
      renderRequirements();
      renderOverview();
      showToast("Template deleted.");
    } catch (error) {
      if (deleteButton.isConnected) {
        deleteButton.disabled = false;
        deleteButton.textContent = deleteLabel;
      }
      showError(error);
    }
  }
});

document.getElementById("implementation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/product/implementations", {
      method: "POST",
      body: {
        customerName: document.getElementById("implementation-customer").value,
        templateId: document.getElementById("implementation-template").value,
        customerOwnerName: document.getElementById("implementation-contact-name").value,
        customerOwnerEmail: document.getElementById("implementation-contact-email").value,
        targetLaunchDate: document.getElementById("implementation-launch-date").value
      }
    });
    event.target.reset();
    await loadWorkspace();
    setView("implementations");
    await openImplementation(result.implementation.id);
    document.getElementById("customer-contact-status").textContent = result.customerInvitation?.sent
      ? `Personal portal invitation sent to ${result.implementation.customer_owner_email}.`
      : result.customerInvitation?.message
        ? `${result.customerInvitation.message}${result.customerInvitation.link ? ` Copy this one-time link: ${result.customerInvitation.link}` : ""}`
        : "Implementation started. Invite a customer contact to grant portal access.";
    showToast("Implementation started with a customer launch plan.");
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
    if (!setView("implementations")) return;
    openImplementation(button.dataset.openImplementation).catch(showError);
  }
});
document.getElementById("close-implementation").addEventListener("click", () => {
  if (dirtyScopes.size && !confirmDiscardChanges()) return;
  state.selectedImplementationId = null;
  document.getElementById("implementation-detail").hidden = true;
});
document.getElementById("implementation-step-list").addEventListener("click", async (event) => {
  const save = event.target.closest("[data-save-task]");
  if (!save || !state.selectedImplementationId) return;
  const stepId = save.dataset.saveTask;
  const root = save.closest(".step-card");
  setFormBusy(root);
  try {
    const taskUpdate = {
      status: root.querySelector(`[data-step-status="${stepId}"]`).value,
      owner: root.querySelector(`[data-task-owner="${stepId}"]`).value,
      assigneeUserId: root.querySelector(`[data-task-assignee="${stepId}"]`).value || null,
      dueAt: root.querySelector(`[data-task-due="${stepId}"]`).value,
      customerVisible: root.querySelector(`[data-task-customer-visible="${stepId}"]`).checked
    };
    if (state.data.plan?.features.blockers) {
      taskUpdate.isBlocked = root.querySelector(`[data-task-blocked="${stepId}"]`).checked;
      taskUpdate.blockerReason = root.querySelector(`[data-task-reason="${stepId}"]`).value;
      taskUpdate.blockerNextAction = root.querySelector(`[data-task-action="${stepId}"]`).value;
    }
    await api(`/api/product/implementations/${state.selectedImplementationId}/steps/${stepId}`, {
      method: "PATCH",
      body: taskUpdate
    });
    finishForm(root, "Saved.");
    await refreshWorkspace();
    showToast("Task details saved.");
  } catch (error) {
    failForm(root, error);
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
  try {
    await api(`/api/product/requirements/${form.dataset.editRequirement}`, {
      method: "PATCH",
      body: {
        name: form.querySelector('[name="name"]').value,
        description: form.querySelector('[name="description"]').value,
        inputType: form.querySelector('[name="inputType"]').value,
        required: form.querySelector('[name="required"]').checked
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
  if (!button || !window.confirm("Delete this request and its saved customer responses?")
    || !confirmDiscardChanges()) return;
  try {
    await api(`/api/product/requirements/${button.dataset.deleteRequirement}`, { method: "DELETE" });
    await refreshWorkspace();
    showToast("Customer information request deleted.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("customer-link-box").addEventListener("submit", async (event) => {
  const form = event.target.closest(".customer-escalation-form");
  if (!form) return;
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  setFormBusy(form);
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/customer-escalation`, {
      method: "PATCH",
      body: {
        escalationEmail: form.querySelector("#customer-escalation-email").value,
        escalationDelayDays: Number(form.querySelector("#customer-escalation-delay").value)
      }
    });
    await refreshWorkspace();
    showToast("Backup customer contact saved.");
  } catch (error) {
    failForm(form, error);
  }
});


document.getElementById("implementation-launch-plan").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("implementation-plan-status");
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/launch-plan`, { method: "PATCH", body: { customerOwnerName: document.getElementById("implementation-plan-owner").value, customerOwnerEmail: document.getElementById("implementation-plan-email").value, targetLaunchDate: document.getElementById("implementation-plan-date").value } });
    await openImplementation(state.selectedImplementationId);
    status.textContent = "Launch plan saved.";
  } catch (error) { status.textContent = error.message; }
});

document.getElementById("implementation-launch-readiness").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("launch-readiness-status");
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/launch-readiness`, { method: "PATCH", body: { successCriteria: document.getElementById("launch-success-criteria").value, testPlan: document.getElementById("launch-test-plan").value, rollbackPlan: document.getElementById("launch-rollback-plan").value, acceptanceStatus: document.getElementById("launch-acceptance-status").value, trainingStatus: document.getElementById("launch-training-status").value, goLiveStatus: document.getElementById("launch-go-live-status").value, supportOwnerName: document.getElementById("launch-support-name").value, supportOwnerEmail: document.getElementById("launch-support-email").value } });
    status.textContent = "Launch readiness saved.";
  } catch (error) { status.textContent = error.message; }
});

document.getElementById("launch-stakeholder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("launch-stakeholder-status-text");
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/launch-stakeholders`, { method: "POST", body: { displayName: document.getElementById("launch-stakeholder-name").value, email: document.getElementById("launch-stakeholder-email").value, role: document.getElementById("launch-stakeholder-role").value, approvalStatus: document.getElementById("launch-stakeholder-status").value, nextAction: document.getElementById("launch-stakeholder-action").value } });
    event.currentTarget.reset();
    await openImplementation(state.selectedImplementationId);
    status.textContent = "Stakeholder saved.";
  } catch (error) { status.textContent = error.message; }
});

document.getElementById("implementation-onboarding-gap-plan").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("gap-plan-status");
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/onboarding-gap-plan`, { method: "PATCH", body: { communicationChannel: document.getElementById("gap-communication-channel").value, communicationCadence: document.getElementById("gap-communication-cadence").value, communicationOwnerName: document.getElementById("gap-communication-owner-name").value, communicationOwnerEmail: document.getElementById("gap-communication-owner-email").value, procurementStatus: document.getElementById("gap-procurement-status").value, securityStatus: document.getElementById("gap-security-status").value, securityNotes: document.getElementById("gap-security-notes").value, integrationInventory: document.getElementById("gap-integration-inventory").value, integrationStatus: document.getElementById("gap-integration-status").value, technicalSetupStatus: document.getElementById("gap-technical-status").value, technicalSetupNotes: document.getElementById("gap-technical-notes").value, changeManagementStatus: document.getElementById("gap-change-status").value, adoptionNotes: document.getElementById("gap-adoption-notes").value, earlyValidationStatus: document.getElementById("gap-validation-status").value, earlyValidationNotes: document.getElementById("gap-validation-notes").value, postLaunchSupportPlan: document.getElementById("gap-support-plan").value, duplicateRequestControl: document.getElementById("gap-duplicate-control").value } });
    status.textContent = "Communication and setup plan saved.";
  } catch (error) { status.textContent = error.message; }
});

document.getElementById("implementation-sow-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("sow-status");
  try { await api(`/api/product/implementations/${state.selectedImplementationId}/sow`, { method: "PATCH", body: { sowScope: document.getElementById("sow-scope").value, sowMilestones: document.getElementById("sow-milestones").value, sowExclusions: document.getElementById("sow-exclusions").value, stageGateStatus: document.getElementById("sow-stage-gate").value } }); status.textContent = "SOW and stage gate saved."; } catch (error) { status.textContent = error.message; }
});

document.getElementById("implementation-financial-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("finance-status");
  try { await api(`/api/product/implementations/${state.selectedImplementationId}/financial-plan`, { method: "PATCH", body: { budgetAmount: document.getElementById("finance-budget").value, forecastAmount: document.getElementById("finance-forecast").value, actualCost: document.getElementById("finance-cost").value, invoiceStatus: document.getElementById("finance-invoice-status").value, invoiceReference: document.getElementById("finance-invoice-reference").value, marginNote: document.getElementById("finance-margin-note").value } }); status.textContent = "Financial plan saved."; } catch (error) { status.textContent = error.message; }
});

document.getElementById("time-entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("time-status");
  try { await api(`/api/product/implementations/${state.selectedImplementationId}/time-entries`, { method: "POST", body: { workDate: document.getElementById("time-work-date").value, minutes: Number(document.getElementById("time-minutes").value), hourlyRate: document.getElementById("time-rate").value, billable: document.getElementById("time-billable").checked, note: document.getElementById("time-note").value } }); event.currentTarget.reset(); await openImplementation(state.selectedImplementationId); status.textContent = "Time entry logged."; } catch (error) { status.textContent = error.message; }
});

document.getElementById("approval-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("approval-status");
  try { await api(`/api/product/implementations/${state.selectedImplementationId}/approvals`, { method: "POST", body: { title: document.getElementById("approval-title").value, approvalType: document.getElementById("approval-type").value, approverName: document.getElementById("approval-name").value, approverEmail: document.getElementById("approval-email").value, dueAt: document.getElementById("approval-due").value } }); event.currentTarget.reset(); await openImplementation(state.selectedImplementationId); status.textContent = "Approval requested."; } catch (error) { status.textContent = error.message; }
});

document.getElementById("calendar-event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("calendar-event-status");
  try { await api(`/api/product/implementations/${state.selectedImplementationId}/calendar-events`, { method: "POST", body: { title: document.getElementById("calendar-event-title").value, startAt: document.getElementById("calendar-event-start").value, endAt: document.getElementById("calendar-event-end").value, eventType: document.getElementById("calendar-event-type").value, externalUrl: document.getElementById("calendar-event-url").value } }); event.currentTarget.reset(); await openImplementation(state.selectedImplementationId); status.textContent = "Timeline event added."; } catch (error) { status.textContent = error.message; }
});

document.getElementById("launch-risk-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("launch-risk-status-text");
  try { await api(`/api/product/implementations/${state.selectedImplementationId}/launch-risks`, { method: "POST", body: { title: document.getElementById("launch-risk-title").value, category: document.getElementById("launch-risk-category").value, severity: document.getElementById("launch-risk-severity").value, ownerName: document.getElementById("launch-risk-owner-name").value, ownerEmail: document.getElementById("launch-risk-owner-email").value, dueAt: document.getElementById("launch-risk-due").value, status: document.getElementById("launch-risk-status").value, nextAction: document.getElementById("launch-risk-action").value } }); event.currentTarget.reset(); await openImplementation(state.selectedImplementationId); status.textContent = "Risk saved."; } catch (error) { status.textContent = error.message; }
});

document.getElementById("delivery-operations-summary").addEventListener("click", async (event) => {
  const approveButton = event.target.closest("[data-approval-status]");
  const deleteTimeButton = event.target.closest("[data-delete-time-entry]");
  const deleteApprovalButton = event.target.closest("[data-delete-approval]");
  const deleteCalendarButton = event.target.closest("[data-delete-calendar-event]");
  if (!state.selectedImplementationId) return;
  try {
    if (approveButton) {
      await api(`/api/product/implementations/${state.selectedImplementationId}/approvals/${approveButton.dataset.approvalStatus}`, { method: "PATCH", body: { status: "approved" } });
      await openImplementation(state.selectedImplementationId);
      showToast("Approval marked approved.");
    } else if (deleteTimeButton) {
      await api(`/api/product/implementations/${state.selectedImplementationId}/time-entries/${deleteTimeButton.dataset.deleteTimeEntry}`, { method: "DELETE" });
      await openImplementation(state.selectedImplementationId);
      showToast("Time entry deleted.");
    } else if (deleteApprovalButton) {
      await api(`/api/product/implementations/${state.selectedImplementationId}/approvals/${deleteApprovalButton.dataset.deleteApproval}`, { method: "DELETE" });
      await openImplementation(state.selectedImplementationId);
      showToast("Approval deleted.");
    } else if (deleteCalendarButton) {
      await api(`/api/product/implementations/${state.selectedImplementationId}/calendar-events/${deleteCalendarButton.dataset.deleteCalendarEvent}`, { method: "DELETE" });
      await openImplementation(state.selectedImplementationId);
      showToast("Timeline event deleted.");
    }
  } catch (error) {
    showError(error);
  }
});

document.getElementById("customer-contact-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("customer-contact-status");
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  status.textContent = "";
  try {
    const result = await api(`/api/product/implementations/${state.selectedImplementationId}/customer-contacts`, {
      method: "POST",
      body: {
        displayName: document.getElementById("customer-contact-name").value,
        email: document.getElementById("customer-contact-email").value
      }
    });
    document.getElementById("customer-contact-form").reset();
    await openImplementation(state.selectedImplementationId);
    const contactStatus = document.getElementById("customer-contact-status");
    contactStatus.textContent = result.invitationSent
      ? `Invitation sent to ${result.contact.email}. The personal link expires ${new Date(result.contact.expires_at).toLocaleDateString()}.`
      : `${result.message || "Invitation email was not sent."}${result.customerPortalUrl ? ` Copy this one-time link and share it securely: ${result.customerPortalUrl}` : ""}`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("customer-contact-list").addEventListener("click", async (event) => {
  const resendButton = event.target.closest("[data-resend-customer-contact]");
  if (resendButton && state.selectedImplementationId) {
    const status = document.getElementById("customer-contact-status");
    resendButton.disabled = true;
    try {
      const result = await api(`/api/product/implementations/${state.selectedImplementationId}/customer-contacts`, {
        method: "POST",
        body: {
          displayName: resendButton.dataset.contactName || "",
          email: resendButton.dataset.contactEmail
        }
      });
      await openImplementation(state.selectedImplementationId);
      status.textContent = result.invitationSent
        ? `Fresh portal invitation sent to ${result.contact.email}. The personal link expires ${new Date(result.contact.expires_at).toLocaleDateString()}.`
        : `${result.message || "Invitation email was not sent."}${result.customerPortalUrl ? ` Copy this fresh link and share it securely: ${result.customerPortalUrl}` : ""}`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      resendButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest("[data-revoke-customer-contact]");
  if (!button || !state.selectedImplementationId
    || !window.confirm("Revoke this contact’s portal access immediately?")) return;
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/customer-contacts/${button.dataset.revokeCustomerContact}`, {
      method: "DELETE"
    });
    await openImplementation(state.selectedImplementationId);
    showToast("Customer portal access revoked.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("implementation-message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("implementation-message-status");
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  status.textContent = "";
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/messages`, {
      method: "POST",
      body: { body: document.getElementById("implementation-message").value }
    });
    await openImplementation(state.selectedImplementationId);
    document.getElementById("implementation-message-status").textContent = "Reply added to the customer conversation.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("launch-stakeholder-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-launch-stakeholder]");
  if (!button || !state.selectedImplementationId
    || !window.confirm("Remove this stakeholder or approval?")) return;
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/launch-stakeholders/${button.dataset.deleteLaunchStakeholder}`, { method: "DELETE" });
    await openImplementation(state.selectedImplementationId);
    showToast("Stakeholder removed.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("launch-risk-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-launch-risk]");
  if (!button || !state.selectedImplementationId
    || !window.confirm("Remove this launch risk? If it is resolved, keep that status in the risk notes.")) return;
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/launch-risks/${button.dataset.deleteLaunchRisk}`, { method: "DELETE" });
    await openImplementation(state.selectedImplementationId);
    showToast("Launch risk removed.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("implementation-file-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-customer-file]");
  if (!button || !state.selectedImplementationId
    || !window.confirm("Permanently delete this customer file?")) return;
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/files/${button.dataset.deleteCustomerFile}`, {
      method: "DELETE"
    });
    await openImplementation(state.selectedImplementationId);
    showToast("Customer file deleted.");
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
  if (isWorkspaceDemo) {
    state.user = { id: 9001, email: "owner@demo.invalid" };
    state.workspace = {
      id: 9000,
      name: "Northstar Demo Workspace",
      role: "owner",
      subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString()
    };
    document.getElementById("auth-screen").hidden = true;
    appShell.hidden = false;
    document.getElementById("local-demo-banner").hidden = false;
    document.getElementById("help-privacy-note").textContent =
      "Sample workspace: fictional records only. Changes stay in this browser and no Relay account or backend is used. Ray uses built-in answers; no external AI service is contacted.";
    await loadPreferences();
    await loadOnboarding();
    showProduct();
    await loadWorkspace();
    await loadHelpHistory();
    return;
  }
  if (isRayDemo) {
    state.user = { id: 0, email: "Demo preview" };
    state.workspace = {
      id: 0,
      name: "Relay demo",
      role: "owner",
      subscriptionExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    };
    state.helpMessages = [
      { role: "user", content: "How do I start a customer implementation?" },
      { role: "assistant", content: "Open Implementations, choose a saved template, and enter the customer's name. Relay creates a customer-specific task list where your team can assign owners, set due dates, and share a private customer information link." }
    ];
    document.getElementById("auth-screen").hidden = true;
    appShell.hidden = false;
    document.getElementById("sidebar").hidden = true;
    document.querySelector(".main-content").hidden = true;
    document.getElementById("ray-demo-stage").hidden = false;
    document.getElementById("help-privacy-note").textContent =
      "Preview mode: Ray uses built-in Relay answers. Messages are not sent to an external AI service or saved.";
    document.getElementById("help-panel").hidden = false;
    document.getElementById("help-open").setAttribute("aria-expanded", "true");
    renderHelpMessages();
    return;
  }
  showAuth();
  if (state.resetToken) {
    window.history.replaceState(null, "", window.location.pathname);
    showPasswordResetPanel("password-reset-complete");
    return;
  }
  setAuthMode(state.inviteToken ? "signup" : "login");
  if (window.location.protocol === "file:") {
    authStatus.textContent = "This local file cannot connect to Relay. Use Preview Ray demo to show Ray, or open the deployed Relay site to sign in.";
    return;
  }
  try {
    const session = await api("/api/product/me");
    state.user = session.user;
    state.workspace = session.workspace;
    await loadPreferences();
    await loadOnboarding();
    showProduct();
    await loadWorkspace();
    await loadHelpHistory();
    void syncJustOneCXIdentity(session);
  } catch (error) {
    if (error.message.startsWith("Your session expired.")) {
      resetJustOneCXIdentity();
    } else if (error.message !== "Sign in to continue.") {
      authStatus.textContent = error.message;
    }
  }
}

initialize();
