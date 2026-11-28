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
let workspaceLoadRequestId = 0;
const deletedProcessIds = new Set();
const state = {
  authMode: "login",
  inviteToken: new URLSearchParams(window.location.search).get("invite") || "",
  resetToken: new URLSearchParams(window.location.search).get("reset") || "",
  inviteUrl: "",
  user: null,
  workspace: null,
  data: { processes: [], templates: [], implementations: [], archivedImplementations: [], requirements: [], members: [], invites: [], teamWorkload: [], integrations: [], notificationSettings: null, role: "member", usage: null, plan: null },
  selectedProcessId: null,
  process: null,
  editingStepId: null,
  selectedImplementationId: null,
  customerTokens: new Map(),
  handoverGuide: "",
  helpMessages: [],
  onboardingDismissed: false,
  preferences: { theme: "light", accent: "blue" },
  implementationFilters: { search: "", status: "all", owner: "all", attention: "all" },
  implementationListMode: "active",
  financialDashboard: null,
  activeTimeTimer: null,
  auditLogEvents: [],
  auditLogCursor: null,
  notificationDeliveryEvents: []
};
const TASK_TIMER_STORAGE_KEY = "relay-task-time-timer";
const dirtyScopes = new Map();
let hubspotPipelineCache = [];
let hubspotConfigurationLoaded = false;
let hubspotConfigurationLoading = false;
let salesforceCatalogCache = null;
let salesforceCatalogLoading = false;
const dirtyScopeBaselines = new WeakMap();
const pendingFormButtons = new WeakMap();
let activeSubmissionForm = null;
let nextFieldErrorId = 0;

const titles = {
  overview: ["Your workspace", "Overview"],
  portfolio: ["See delivery health", "Portfolio"],
  financials: ["Protect project margins", "Financials"],
  processes: ["Plan your work", "Process map"],
  templates: ["Reuse what works", "Templates"],
  implementations: ["Run customer work", "Implementations"],
  requirements: ["Get customer-ready", "Customer information"],
  guide: ["Learn Relay", "How to use Relay"],
  integrations: ["Connect your tools", "Integrations"],
  settings: ["Personalize your workspace", "Settings"]
};

function taskTimerStorageKey() {
  return `${TASK_TIMER_STORAGE_KEY}:${state.workspace?.id || "none"}:${state.user?.id || "none"}`;
}

function loadTaskTimer() {
  const storageKey = taskTimerStorageKey();
  const saved = window.localStorage.getItem(storageKey);
  if (!saved) return null;
  try {
    const timer = JSON.parse(saved);
    if (Number.isInteger(timer.implementationId) && Number.isInteger(timer.taskId)
      && Number.isFinite(timer.startedAt)) return timer;
  } catch {
    window.localStorage.removeItem(storageKey);
    showToast("An unreadable saved timer was cleared.");
    return null;
  }
  window.localStorage.removeItem(storageKey);
  showToast("An invalid saved timer was cleared.");
  return null;
}

function saveTaskTimer(timer) {
  state.activeTimeTimer = timer;
  if (timer) window.localStorage.setItem(taskTimerStorageKey(), JSON.stringify(timer));
  else window.localStorage.removeItem(taskTimerStorageKey());
  updateTaskTimerDisplay();
}

function updateTaskTimerDisplay() {
  const timer = state.activeTimeTimer;
  document.querySelectorAll("[data-time-elapsed]").forEach((element) => {
    const isActive = timer && Number(element.dataset.timeElapsed) === timer.taskId
      && Number(element.dataset.timeImplementation) === timer.implementationId;
    element.textContent = isActive ? `Running · ${formatElapsed(Date.now() - timer.startedAt)}` : "Timer stopped";
  });
  document.querySelectorAll("[data-time-start]").forEach((button) => {
    const isActiveTimer = timer && Number(button.dataset.timeStart) === timer.taskId
      && Number(button.dataset.timeImplementation) === timer.implementationId;
    button.hidden = Boolean(isActiveTimer);
    button.disabled = Boolean(timer && !isActiveTimer);
  });
  document.querySelectorAll("[data-time-stop]").forEach((button) => {
    button.hidden = !(timer && Number(button.dataset.timeStop) === timer.taskId
      && Number(button.dataset.timeImplementation) === timer.implementationId);
  });
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${remainder}`;
}

function formatMoney(value) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    .format(Number(value) || 0);
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

function safeEngineeringIssueUrl(issue) {
  try {
    const url = new URL(issue.issue_url);
    const trustedHost = issue.provider === "jira"
      ? url.hostname.endsWith(".atlassian.net")
      : issue.provider === "linear" && url.hostname === "linear.app";
    return url.protocol === "https:" && trustedHost && !url.username && !url.password && !url.port
      ? url.href : "";
  } catch {
    return "";
  }
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
  state.auditLogEvents = [];
  state.auditLogCursor = null;
  state.activeTimeTimer = null;
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
  state.activeTimeTimer = loadTaskTimer();
  updateTaskTimerDisplay();
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

  document.getElementById("team-member-list").addEventListener("submit", async (event) => {
    const roleForm = event.target.closest(".member-role-form");
    if (roleForm) {
      event.preventDefault();
      const status = roleForm.querySelector(".form-status");
      try {
        await api(`/api/product/team-members/${roleForm.dataset.memberRole}/role`, {
          method: "PATCH",
          body: { role: new FormData(roleForm).get("role") }
        });
        await loadWorkspace();
        showToast("Workspace role updated.");
      } catch (error) {
        status.textContent = error.message;
      }
      return;
    }
    const form = event.target.closest(".member-rate-form");
    if (!form) return;
    event.preventDefault();
    const status = form.querySelector(".form-status");
    const fields = new FormData(form);
    try {
      await api(`/api/product/team-members/${form.dataset.memberRates}/rates`, {
        method: "POST",
        body: {
          defaultInternalCostRate: fields.get("internalCostRate"),
          defaultBillableRate: fields.get("billableRate")
        }
      });
      status.textContent = "Hourly rates saved. Existing time-entry snapshots are unchanged.";
    } catch (error) {
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
  const requestId = ++workspaceLoadRequestId;
  const data = await api("/api/product/workspace");
  if (requestId !== workspaceLoadRequestId) return false;
  if (dirtyScopes.size && !confirmDiscardChanges()) return false;
  data.processes = data.processes.filter((process) => !deletedProcessIds.has(Number(process.id)));
  state.data = data;
  if (state.selectedProcessId !== null
    && !data.processes.some((process) => Number(process.id) === Number(state.selectedProcessId))) {
    clearSelectedProcess();
  }
  renderWorkspace();
  if (data.role === "executive_viewer") {
    setView(data.plan?.features.financialProtection && data.capabilities?.viewFinancials ? "financials" : "guide");
  }
  const integrationResult = new URLSearchParams(window.location.search).get("integration");
  if (integrationResult) {
    const messages = {
      hubspot_connected: "HubSpot connected. New and updated implementations will sync during event processing.",
      salesforce_connected: "Salesforce connected. Map product SKUs to Relay templates to start onboarding from new Closed Won opportunities.",
      connect_failed: "The integration could not be connected. Check its OAuth app settings and try again."
    };
    document.getElementById("integration-status").textContent = messages[integrationResult] || "Integration connection completed.";
    setView("integrations");
    window.history.replaceState(null, "", window.location.pathname);
  }
  return true;
}

function clearSelectedProcess() {
  state.selectedProcessId = null;
  state.process = null;
  state.editingStepId = null;
  document.getElementById("process-meta-form").hidden = true;
  document.getElementById("step-form").hidden = true;
  document.getElementById("process-actions").hidden = true;
  document.getElementById("process-editor-title").textContent = "Select a process";
  document.getElementById("process-test-result").hidden = true;
  document.getElementById("process-step-list").innerHTML =
    '<strong>No process selected</strong><p>Choose an existing process map or create your first one to begin.</p><button class="button secondary" type="button" data-workflow-action="create-process">Create a process map</button>';
}

function removeDeletedProcess(processId) {
  const id = Number(processId);
  deletedProcessIds.add(id);
  state.data.processes = state.data.processes.filter((process) => Number(process.id) !== id);
  if (Number(state.selectedProcessId) === id) clearSelectedProcess();
  renderProcesses();
}

async function loadOnboarding() {
  const result = await api("/api/product/onboarding");
  state.onboardingDismissed = result.dismissed;
}

function emptyStateMarkup(title, description, actionLabel, action) {
  return `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p><button class="button secondary" type="button" data-workflow-action="${escapeHtml(action)}">${escapeHtml(actionLabel)}</button>`;
}

function getNextWorkflowAction() {
  if (!state.data.capabilities?.administerWorkspace) {
    if (state.data.capabilities?.manageImplementations && state.data.templates.length) {
      return { action: "start-implementation", label: "Start an implementation" };
    }
    return { action: "view-implementations", label: "View implementations" };
  }
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
  const processWithSteps = state.data.processes.some((process) => process.steps_count > 0);
  const processChecked = state.data.processes.some((process) => process.checked);
  const next = getNextWorkflowAction();
  const steps = [
    {
      title: "Build and check a process",
      description: "Map a few real steps, give each one an owner, then run the check. No full-building wiring diagram required.",
      complete: processChecked,
      action: next.action === "check-process" ? "check-process" : "map-process",
      actionLabel: next.action === "check-process" ? "Check a process" : processWithSteps ? "Continue your process map" : "Create a process map"
    },
    {
      title: "Save a reusable template",
      description: "Save the checked process as a reusable starting point—your team's wiring diagram for customer work.",
      complete: state.data.templates.length > 0,
      action: "save-template",
      actionLabel: "Create a template"
    },
    {
      title: "Start a customer implementation",
      description: "Choose your template and enter a customer company to create its work plan.",
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
        ${index === nextIndex ? `<small>Next: ${escapeHtml(step.actionLabel)}.</small>` : waiting ? '<small>Complete the previous step to continue.</small>' : ""}
        <button class="text-button getting-started-action" type="button" data-workflow-action="${escapeHtml(step.action)}">${step.complete ? "Review step" : waiting ? "Preview this step" : "Continue this step"} <span aria-hidden="true">→</span></button>
      </div>
      <span class="getting-started-state">${step.complete ? "Complete" : waiting ? "Next" : "Up next"}</span>
    </li>`;
  }).join("");
  const status = document.getElementById("getting-started-status");
  status.textContent = nextIndex < 0
    ? "First customer path connected. Keep this guide for reference, or hide it and come back any time."
    : `${steps.filter((step) => step.complete).length} of ${steps.length} steps complete. One switch at a time; no need to rewire the building.`;
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
  const targetView = document.getElementById(`view-${name}`);
  if (!targetView || targetView.hidden) return false;
  const activeView = document.querySelector(".view.active");
  if (activeView?.id !== `view-${name}` && !confirmDiscardChanges()) return false;
  const mobileNavigationWasOpen = document.getElementById("mobile-nav-toggle").getAttribute("aria-expanded") === "true";
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((item) => {
    const isActive = item.dataset.view === name;
    item.classList.toggle("active", isActive);
    if (isActive) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  setMobileNavigationOpen(false);
  document.getElementById("view-eyebrow").textContent = titles[name][0];
  document.getElementById("view-title").textContent = titles[name][1];
  if (mobileNavigationWasOpen) document.getElementById("view-title").focus();
  document.getElementById("refresh-button").hidden = name === "settings";
  globalStatus.textContent = "";
  if (name === "settings" && state.data.role !== "executive_viewer") {
    loadAccountDeletionChoices().catch(showError);
  }
  if (name === "settings" && state.data.capabilities?.viewAuditLogs && !isWorkspaceDemo) {
    loadAuditLogs(false).catch(showError);
    loadNotificationDelivery().catch(showError);
  }
  if (name === "financials") loadFinancialDashboard().catch(showError);
  return true;
}

async function showProcessWorkspace() {
  if (!await loadWorkspace()) return false;
  if (!setView("processes")) return false;
  const process = state.data.processes.find((item) => item.id === state.selectedProcessId)
    || state.data.processes[0];
  if (!process) {
    focusProcessCreation();
    return true;
  }
  await loadProcess(process.id);
  return true;
}

function focusProcessCreation() {
  document.getElementById("process-create-details").open = true;
  document.getElementById("process-name").focus();
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
  const features = state.data.plan?.features || {};
  const attention = {
    blocked: Boolean(features.blockers && implementation.blocked_steps > 0),
    overdue: implementation.overdue_steps > 0,
    quiet: implementation.quiet_customer,
    waiting: Boolean(features.dependencies && implementation.waiting_steps > 0),
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
  const welcomeCopy = {
      "map-process": ["Start with how your team works.", "Map a few real onboarding steps, give them owners, and check the process before turning it into a reusable template. No building-wide rewiring required."],
      "check-process": ["Your process has steps. Give it a check.", "Check the path for missing instructions or owners before you save it as a template. Better to find the loose connection here."],
      "save-template": ["Your process is checked. Make it reusable.", "Save a template—your team's wiring diagram for each new customer implementation."],
    "start-implementation": [implementations.length ? "Ready for another customer plan?" : "Your first customer plan starts here.", "Choose a saved template and enter the customer company to create its work plan."],
    "view-implementations": ["Pick up the customer work.", "Open an implementation to review its tasks, owners, and next steps."]
  }[next.action];
  document.getElementById("overview-welcome-title").textContent = welcomeCopy[0];
  document.getElementById("overview-welcome-description").textContent = welcomeCopy[1];
  const firstRun = !implementations.length && !state.onboardingDismissed
    && state.data.capabilities?.administerWorkspace === true;
  document.getElementById("overview-metrics").hidden = firstRun;
  document.getElementById("overview-implementations").closest(".panel").hidden = firstRun;
  const activeCount = state.data.usage?.activeImplementations ?? implementations.length;
  const features = state.data.plan?.features || {};
  const needsAttention = implementations.filter((item) => item.missing_inputs > 0 || item.unowned_steps > 0
    || item.overdue_steps > 0 || item.quiet_customer || (features.blockers && item.blocked_steps > 0)
    || (features.dependencies && item.waiting_steps > 0)).length;
  renderWorkspaceCircuitBoard(implementations, activeCount, needsAttention);
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
      "start-implementation": ["Start your first implementation", "Choose a template and enter the customer company to create a customer-specific work plan. Every tidy circuit starts with one clear path."],
        "view-implementations": ["Your implementation work", "Open an implementation to review its tasks and communicate with the customer."]
    }[next.action];
    emptyState.innerHTML = `<strong>${escapeHtml(copy[0])}</strong><p>${escapeHtml(copy[1])}</p>`;
  }
  renderGettingStarted();
  applyPlanGates();
}

function renderWorkspaceCircuitBoard(implementations, activeCount, needsAttention) {
  const path = document.getElementById("workspace-signal-path");
  if (!path) return;
  const totals = implementations.reduce((summary, item) => ({
    tasks: summary.tasks + (Number(item.total_steps) || 0),
    done: summary.done + (Number(item.completed_steps) || 0),
    unassigned: summary.unassigned + (Number(item.unowned_steps) || 0)
  }), { tasks: 0, done: 0, unassigned: 0 });
  const taskPercent = totals.tasks ? Math.round((totals.done / totals.tasks) * 100) : 0;
  const checkpoints = [
    { label: "Customer plans", value: String(activeCount), detail: "active in this workspace", filter: "all", state: activeCount ? "connected" : "idle" },
    { label: "Task progress", value: totals.tasks ? `${totals.done}/${totals.tasks}` : "—", detail: totals.tasks ? "tasks complete" : "no tasks recorded yet", filter: "all", state: totals.done === totals.tasks && totals.tasks ? "connected" : "current", progress: taskPercent },
    { label: "Unassigned", value: String(totals.unassigned), detail: totals.unassigned === 1 ? "task needs an owner" : "tasks need an owner", filter: "unassigned", state: totals.unassigned ? "attention" : "connected" },
    { label: "Needs attention", value: String(needsAttention), detail: needsAttention === 1 ? "implementation flagged" : "implementations flagged", filter: "yes", state: needsAttention ? "attention" : "connected" }
  ];
  path.innerHTML = checkpoints.map((checkpoint, index) => `<li class="workspace-signal-step ${checkpoint.state}">
    <button type="button" data-circuit-filter="${checkpoint.filter}" aria-label="Open implementations: ${escapeHtml(checkpoint.label)}, ${escapeHtml(checkpoint.value)} ${escapeHtml(checkpoint.detail)}">
      ${index === 1
        ? '<span class="workspace-signal-light workspace-progress-light" aria-hidden="true"><svg viewBox="0 0 40 40"><circle class="workspace-progress-track" cx="20" cy="20" r="16"></circle><circle class="workspace-progress-value" cx="20" cy="20" r="16" style="stroke-dashoffset: ' + (100 - checkpoint.progress) + ';"></circle></svg><span>' + checkpoint.progress + '%</span></span>'
        : '<span class="workspace-signal-light" aria-hidden="true">' + (checkpoint.state === "connected" ? "✓" : checkpoint.state === "attention" ? "!" : index + 1) + '</span>'}
      <span class="workspace-signal-copy"><strong>${escapeHtml(checkpoint.value)}</strong><span>${escapeHtml(checkpoint.label)}</span><small>${escapeHtml(checkpoint.detail)}</small></span>
      <span class="workspace-signal-open" aria-hidden="true">↗</span>
    </button>
  </li>`).join("");
  const status = document.getElementById("workspace-circuit-status");
  status.textContent = needsAttention
    ? `${needsAttention} ${needsAttention === 1 ? "implementation needs" : "implementations need"} a look`
    : "No tracked flags to check";
  status.dataset.level = needsAttention ? "attention" : "clear";
  document.getElementById("workspace-circuit-footnote").textContent = isWorkspaceDemo
    ? "Fictional sample records · clicking a checkpoint opens the matching sample list."
    : "Based on the workspace records currently loaded · click a checkpoint to open its implementation list.";
}

function renderPortfolio() {
  const workload = state.data.teamWorkload || [];
  document.getElementById("portfolio-workload").innerHTML = workload.length
    ? workload.map((member) => `<article class="metric">
        <strong>${member.open_tasks}</strong>
        <span>${escapeHtml(member.email)} · open tasks · ${member.overdue_tasks} overdue</span>
      </article>`).join("")
    : '<p class="empty-state">No team workload to show yet. Assign tasks on an implementation to see who owns the next connection.</p>';
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
    : '<p class="empty-state">Start an implementation to see portfolio health. The dashboard needs a little current before it can show a signal.</p>';
}

function renderNotificationSettings() {
  const settings = state.data.notificationSettings || { email_enabled: false, reminder_days_before: 2 };
  document.getElementById("notifications-email-enabled").checked = settings.email_enabled;
  document.getElementById("notifications-reminder-days").value = settings.reminder_days_before;
  const form = document.getElementById("notification-settings-form");
  const owner = state.data.capabilities?.administerWorkspace === true;
  for (const control of form.elements) control.disabled = !owner;
  document.getElementById("notifications-demo-note").hidden = !isWorkspaceDemo;
}

function renderIntegrations() {
  const integrations = state.data.integrations || [];
  const connected = new Set(integrations.map((item) => item.provider));
  const hubspot = integrations.find((item) => item.provider === "hubspot");
  const salesforce = integrations.find((item) => item.provider === "salesforce");
  const jira = integrations.find((item) => item.provider === "jira");
  const linear = integrations.find((item) => item.provider === "linear");
  document.getElementById("integration-status").textContent = hubspot?.hubspot_onboarding_last_error
    ? `HubSpot handoff needs attention: ${hubspot.hubspot_onboarding_last_error}`
    : state.data.capabilities?.administerWorkspace ? "" : "Only workspace admins can connect or disconnect integrations.";
  document.getElementById("integrations-demo-note").hidden = !isWorkspaceDemo;
  const integrationNames = {
    hubspot: "HubSpot",
    salesforce: "Salesforce",
    jira: "Jira Cloud",
    linear: "Linear"
  };
  const providers = ["hubspot", ...(state.data.plan?.features?.enterpriseIntegrations
    ? ["salesforce", "jira", "linear"] : [])];
  document.getElementById("integration-list").innerHTML = providers.map((provider) => {
    const name = integrationNames[provider];
    const isConnected = connected.has(provider);
    const stateLabel = isWorkspaceDemo
      ? isConnected ? "Preview connected · no external service linked" : "Not connected"
      : provider === "jira" && isConnected
        ? `Connected · ${jira.configuration_json?.projectKey || "Jira project"}`
        : provider === "linear" && isConnected
          ? `Connected · ${linear.configuration_json?.teamName || "Linear team"}`
          : isConnected ? "Connected" : "Not connected";
    const oauthProvider = provider === "hubspot" || provider === "salesforce";
    return `<div class="list-row"><div><strong>${name}</strong><small>${escapeHtml(stateLabel)}</small></div>
      ${connected.has(provider)
        ? `<button class="text-button" type="button" data-disconnect-integration="${provider}" ${!state.data.capabilities?.administerWorkspace ? "disabled" : ""}>${isWorkspaceDemo ? "Clear preview" : "Disconnect"}</button>`
        : oauthProvider
          ? `<button class="button secondary" type="button" data-connect-integration="${provider}" ${!state.data.capabilities?.administerWorkspace ? "disabled" : ""}>${isWorkspaceDemo ? "Preview connection" : `Connect ${name}`}</button>`
          : `<span class="muted">${isWorkspaceDemo ? "Preview only" : "Configure below"}</span>`}</div>`;
  }).join("");
  const handoffPanel = document.getElementById("hubspot-handoff-panel");
  handoffPanel.hidden = isWorkspaceDemo || !connected.has("hubspot");
  for (const control of document.getElementById("hubspot-handoff-form").elements) {
    control.disabled = !state.data.capabilities?.administerWorkspace;
  }
  const salesforcePanel = document.getElementById("salesforce-sku-panel");
  salesforcePanel.hidden = isWorkspaceDemo || !state.data.plan?.features?.enterpriseIntegrations
    || !state.data.capabilities?.administerWorkspace || !connected.has("salesforce");
  const salesforceError = salesforce?.last_sync_error || "";
  document.getElementById("salesforce-sync-status").textContent = salesforceError
    ? `Salesforce sync needs attention: ${salesforceError}`
    : salesforce?.last_synced_at
      ? `Last checked ${new Date(salesforce.last_synced_at).toLocaleString()}. New Closed Won opportunities are checked every five minutes.`
      : "Connected. Save SKU mappings to start checking new Closed Won opportunities.";
  if (!salesforcePanel.hidden && !salesforceCatalogCache && !salesforceCatalogLoading) {
    loadSalesforceCatalog().catch((error) => {
      document.getElementById("salesforce-sku-status").textContent = error.message;
      salesforceCatalogLoading = false;
    });
  }
  for (const panelId of ["jira-settings-panel", "linear-settings-panel"]) {
    document.getElementById(panelId).hidden = isWorkspaceDemo
      || !state.data.plan?.features?.enterpriseIntegrations
      || !state.data.capabilities?.administerWorkspace;
  }
  const jiraConfig = jira?.configuration_json || {};
  document.getElementById("jira-site").value = jiraConfig.baseUrl || "";
  document.getElementById("jira-email").value = jiraConfig.email || "";
  document.getElementById("jira-project-key").value = jiraConfig.projectKey || "";
  document.getElementById("jira-issue-type").value = jiraConfig.issueType || "Task";
  document.getElementById("jira-api-token").value = "";
  document.getElementById("jira-api-token").required = !connected.has("jira");
  document.getElementById("jira-disconnect").disabled = !connected.has("jira")
    || !state.data.capabilities?.administerWorkspace;
  document.getElementById("jira-settings-status").textContent = jira?.last_sync_error
    ? `Last issue sync failed: ${jira.last_sync_error}`
    : connected.has("jira") ? "Connected. Enter a new token only when replacing the saved one." : "";
  const linearConfig = linear?.configuration_json || {};
  document.getElementById("linear-team-id").value = linearConfig.teamId || "";
  document.getElementById("linear-api-token").value = "";
  document.getElementById("linear-api-token").required = !connected.has("linear");
  document.getElementById("linear-disconnect").disabled = !connected.has("linear")
    || !state.data.capabilities?.administerWorkspace;
  document.getElementById("linear-settings-status").textContent = linear?.last_sync_error
    ? `Last issue sync failed: ${linear.last_sync_error}`
    : connected.has("linear") ? "Connected. Enter a new key only when replacing the saved one." : "";
  const slack = integrations.find((item) => item.provider === "slack");
  const slackConnected = slack?.has_slack_webhook === true;
  const slackPanel = document.getElementById("slack-alert-panel");
  slackPanel.hidden = !state.data.plan?.features?.slackAlerts
    || !state.data.capabilities?.administerWorkspace;
  document.getElementById("slack-preview-note").hidden = !isWorkspaceDemo;
  document.getElementById("slack-alert-description").hidden = isWorkspaceDemo;
  document.getElementById("slack-webhook-state").textContent = isWorkspaceDemo
    ? "Preview only: Slack is not connected; no webhook is saved and no alert can be sent."
    : slackConnected
    ? "A webhook is saved. Its URL is encrypted and cannot be viewed again."
    : "No webhook is configured.";
  document.getElementById("slack-test-alert").disabled = !slackConnected;
  document.getElementById("slack-disconnect").disabled = !slackConnected;
  for (const control of document.getElementById("slack-alert-form").elements) {
    control.disabled = isWorkspaceDemo || !state.data.capabilities?.administerWorkspace;
  }
  document.getElementById("slack-test-alert").disabled ||= !slackConnected;
  document.getElementById("slack-disconnect").disabled ||= !slackConnected;
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

async function loadSalesforceCatalog() {
  salesforceCatalogLoading = true;
  document.getElementById("salesforce-sku-status").textContent = "Loading Salesforce products and Relay templates...";
  try {
    const result = await api("/api/product/integrations/salesforce/catalog");
    salesforceCatalogCache = result;
    document.getElementById("salesforce-import-errors").innerHTML = (result.failedImports || []).length
      ? `<p class="status warning"><strong>Opportunities needing attention</strong></p>${result.failedImports.map((item) => `
        <article class="list-row"><div><strong>${escapeHtml(item.opportunity_name || `Opportunity ${item.opportunity_id}`)}</strong>
          <small>${escapeHtml(item.last_error)} · Updated ${escapeHtml(new Date(item.updated_at).toLocaleString())}</small></div></article>`).join("")}`
      : "";
    const mapped = new Map((result.mappings || []).map((item) => [item.sku, item]));
    const products = [...(result.products || [])];
    for (const mapping of result.mappings || []) {
      if (!products.some((product) => product.sku === mapping.sku)) {
        products.push({ sku: mapping.sku, name: `${mapping.sku} (not in active catalog)` });
      }
    }
    const mappingList = document.getElementById("salesforce-sku-mapping-list");
    mappingList.innerHTML = products.length
      ? products.map((product) => {
        const selectedTemplateId = mapped.get(product.sku)?.template_id;
        return `<label class="field">${escapeHtml(product.name)} · SKU ${escapeHtml(product.sku)}
          <select data-salesforce-sku="${escapeHtml(product.sku)}">
            <option value="">Do not map</option>
            ${(result.templates || []).map((template) =>
              `<option value="${template.id}" ${Number(template.id) === Number(selectedTemplateId) ? "selected" : ""}>${escapeHtml(template.name)}</option>`
            ).join("")}
          </select>
        </label>`;
      }).join("")
      : '<p class="empty-state">No active Salesforce product SKUs were found.</p>';
    document.getElementById("salesforce-sku-status").textContent = result.templates?.length
      ? "Choose a Relay template for each SKU that should start an implementation."
      : "Create a Relay template with tasks before saving SKU mappings.";
    return result;
  } finally {
    salesforceCatalogLoading = false;
  }
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
    !plan.features.blockers && "Blocker tracking",
    !plan.features.templateHistory && "Template history and restore",
    !plan.features.criticalPath && "Critical-path go-live shifting",
    !plan.features.changeOrders && "Change-order approvals",
    !plan.features.portfolioFull && "Full team-workload portfolio view",
    !plan.features.hubspot && "HubSpot handoff",
    !plan.features.enterpriseIntegrations && "Salesforce SKU and Jira/Linear task sync",
    !plan.features.financialProtection && "Time tracking, budget caps, and margin reporting"
  ].filter(Boolean);
  document.getElementById("plan-features").textContent = featureLabels.length
    ? `Not included: ${featureLabels.join(", ")}. Growth adds workflow, portfolio, and HubSpot features; Custom adds financial controls and enterprise integrations.`
    : "Your plan includes the Growth workflow, portfolio, HubSpot, and enterprise integrations, plus financial controls.";
  panel.hidden = false;
}

function applyPlanGates() {
  updateSaveTemplateButton();
  const features = state.data.plan?.features;
  for (const element of document.querySelectorAll("[data-growth-only], [data-plan-feature], [data-role-capability]")) {
    const feature = element.dataset.planFeature || element.dataset.growthOnly;
    const roleCapability = element.dataset.roleCapability;
    const planAllowed = !feature || Boolean(features?.[feature]);
    const roleAllowed = !roleCapability || state.data.capabilities?.[roleCapability] === true;
    element.hidden = !planAllowed || !roleAllowed;
  }
  applyRoleGates();
  if (!features) return;
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

function applyRoleGates() {
  const isExecutive = (state.data.role || state.workspace?.role) === "executive_viewer";
  const accountDeletionPanel = document.getElementById("account-deletion-panel");
  if (accountDeletionPanel) accountDeletionPanel.hidden = isExecutive;
  const auditPanel = document.getElementById("audit-log-panel");
  if (auditPanel && isWorkspaceDemo) auditPanel.hidden = true;
  for (const viewName of ["overview", "implementations", "portfolio"]) {
    const view = document.getElementById(`view-${viewName}`);
    const button = document.querySelector(`.nav-item[data-view="${viewName}"]`);
    if (view) view.hidden = isExecutive;
    if (button) button.hidden = isExecutive;
  }
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
    { title: "Add and order steps", detail: stepCount ? `${stepCount} ${stepCount === 1 ? "step" : "steps"} saved` : "Add the first task" },
    { title: "Check and create a template", detail: templateCreated ? "Template created" : checked ? "Ready to create" : "Check the process first" }
  ];

  container.innerHTML = steps.map((step, index) => {
    const complete = index < currentStep || (currentStep === -1);
    const current = index === currentStep;
    const stateClass = complete ? "is-complete" : current ? "is-current" : "is-upcoming";
    const status = complete ? "Done" : current ? "Next" : "Up next";
    const number = complete ? "✓" : index + 1;
    return `<li class="process-progress-step ${stateClass}" ${current ? 'aria-current="step"' : ""}>
      <button class="process-progress-action" type="button" data-process-stage="${index}" aria-label="${escapeHtml(step.title)}. ${escapeHtml(current ? step.detail : status)}">
        <span class="process-progress-number" aria-hidden="true">${number}</span>
        <span class="process-progress-copy"><strong>${step.title}</strong><small>${current ? step.detail : status}</small></span>
      </button>
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

async function focusProcessStage(stage) {
  const process = state.data.processes.find((item) => item.id === state.selectedProcessId)
    || state.data.processes[0];
  if (stage === 0) {
    if (!process) {
      focusProcessCreation();
    } else if (state.process?.id === process.id) {
      document.getElementById("process-edit-name").focus();
    } else {
      document.querySelector(`[data-select-process="${process.id}"]`)?.focus();
    }
    return;
  }
  if (!process) {
    focusProcessCreation();
    return;
  }
  if (state.process?.id !== process.id && !await loadProcess(process.id)) return;
  if (dirtyScopes.has(document.getElementById("process-meta-form"))) {
    document.getElementById("process-edit-name").focus();
    return;
  }
  if (dirtyScopes.has(document.getElementById("step-form"))) {
    document.getElementById("step-title").focus();
    return;
  }
  if (stage === 1) {
    document.getElementById(state.process.steps.length ? "process-step-list" : "step-title").focus();
    return;
  }
  if (!state.process.steps.length) {
    document.getElementById("step-title").focus();
  } else if (!state.process.checked) {
    document.getElementById("test-process").focus();
  } else {
    document.getElementById("save-template").focus();
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
    return `<div class="empty-state"><strong>No customer circuits are live yet</strong><p>${state.data.templates.length
      ? "Start from a saved template to create the first customer-specific work plan. Every tidy circuit starts with one clear path."
      : "Follow the next setup step to prepare a reusable starting point before customer work. No wiring diagram required—and no electrician's toolkit needed."}</p><button class="button secondary" type="button" data-workflow-action="${next.action}">${escapeHtml(next.label)}</button></div>`;
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
    const selected = process.id === state.selectedProcessId;
    return `
      <article class="process-list-card ${selected ? "selected" : ""}">
        <div class="process-list-main">
          <strong>${escapeHtml(process.name)}</strong>
          <small>${escapeHtml(process.description || "Onboarding process")}</small>
          <div class="process-card-meta">
            <span>${stepCount} ${stepCount === 1 ? "step" : "steps"}</span>
            <span class="process-card-status ${checked ? "ready" : ""}">${checked ? "Check passed" : stepCount ? "Needs a check" : "Add a step"}</span>
          </div>
        </div>
        <div class="process-card-actions">
          <button type="button" class="process-open-button" data-select-process="${process.id}" aria-current="${selected ? "true" : "false"}" ${selected ? "disabled" : ""}>${selected ? "Selected" : "Open"}</button>
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
  const canAdministerWorkspace = state.data.capabilities?.administerWorkspace === true;
  const canViewRates = state.data.capabilities?.viewRates === true
    && state.data.plan?.features.financialProtection === true;
  document.getElementById("team-member-list").innerHTML = state.data.members.length
    ? state.data.members.map((member) => `
      <article class="member-rate-row">
        <div class="member-rate-heading"><strong>${escapeHtml(member.email)}</strong><span class="badge">${escapeHtml(member.role)}</span></div>
        ${canAdministerWorkspace && member.role !== "owner" && Number(member.id) !== Number(state.user?.id) ? `
          <form class="member-role-form" data-member-role="${member.id}">
            <label>Workspace role<select name="role">
              ${[
                ["admin", "Admin"],
                ["implementation_manager", "Implementation Manager"],
                ["contributor", "Contributor"],
                ["executive_viewer", "Executive Viewer"]
              ].map(([value, label]) => `<option value="${value}" ${member.role === value ? "selected" : ""}>${label}</option>`).join("")}
            </select></label>
            <button class="text-button" type="submit">Save role</button>
            <p class="form-status" role="status" aria-live="polite"></p>
          </form>` : ""}
        ${canViewRates ? `
          <form class="member-rate-form" data-member-rates="${member.id}">
            <label>Internal cost / hour<input name="internalCostRate" type="number" min="0" max="1000000" step="0.01" value="${escapeHtml(member.default_internal_cost_rate || 0)}" required></label>
            <label>Client bill / hour<input name="billableRate" type="number" min="0" max="1000000" step="0.01" value="${escapeHtml(member.default_billable_rate || 0)}" required></label>
            <button class="text-button" type="submit">Save rates</button>
            <p class="form-status" role="status" aria-live="polite"></p>
          </form>` : ""}
      </article>`).join("")
    : '<p class="empty-state">No workspace members are available.</p>';
  document.getElementById("team-invite-list").innerHTML = state.data.invites.length
    ? state.data.invites.map((invite) => `<div class="list-row"><div><strong>${escapeHtml(invite.invited_email)}</strong><small>${escapeHtml(invite.role || "contributor")} · Expires ${escapeHtml(invite.expires_at)}</small></div><button class="text-button" type="button" data-revoke-invite="${invite.id}">Revoke</button></div>`).join("")
    : '<p class="empty-state">No pending invitations.</p>';
  const inviteForm = document.getElementById("team-invite-form");
  const memberLimit = state.data.plan?.memberLimit;
  const seatsUsed = state.data.usage ? state.data.usage.members + state.data.usage.pendingInvites : state.data.members.length;
  const seatsFull = memberLimit !== null && memberLimit !== undefined && seatsUsed >= memberLimit;
  inviteForm.hidden = !canAdministerWorkspace || seatsFull;
  const capNotice = document.getElementById("team-cap-notice");
  capNotice.hidden = !canAdministerWorkspace || !seatsFull;
  capNotice.textContent = seatsFull ? `Your plan allows ${memberLimit} team members, including pending invitations. Upgrade the plan or revoke an invitation to add someone.` : "";
  const result = document.getElementById("invite-result");
  result.hidden = !state.inviteUrl;
  if (state.inviteUrl) {
    result.innerHTML = `<strong>One-time teammate invitation</strong><br><a href="${escapeHtml(state.inviteUrl)}">${escapeHtml(state.inviteUrl)}</a><br><button class="text-button" type="button" data-copy-invite="${escapeHtml(state.inviteUrl)}">Copy invitation link</button>`;
  }
  const auditPanel = document.getElementById("audit-log-panel");
  if (auditPanel) auditPanel.hidden = !state.data.capabilities?.viewAuditLogs || isWorkspaceDemo;
  const assigneeOptions = state.data.members.map((member) => `<option value="${member.id}">${escapeHtml(member.email)} (${escapeHtml(member.role)})</option>`).join("");
  const processAssignee = document.getElementById("step-assignee");
  processAssignee.innerHTML = `<option value="">Choose a workspace member</option>${assigneeOptions}`;
  if (state.user?.id && state.data.members.some((member) => member.id === state.user.id)) {
    processAssignee.value = String(state.user.id);
  }
}

function renderAuditLogs() {
  const container = document.getElementById("audit-log-list");
  if (!container) return;
  container.innerHTML = state.auditLogEvents.length
    ? state.auditLogEvents.map((event) => {
      const diff = typeof event.diff_json === "string"
        ? event.diff_json : JSON.stringify(event.diff_json || {});
      return `<details class="list-row">
        <summary><strong>${escapeHtml(event.action)}</strong><small>${escapeHtml(event.timestamp)} · ${escapeHtml(event.actor_email || event.actor_id)} · ${escapeHtml(event.ip_address || "IP unavailable")}</small></summary>
        <pre>${escapeHtml(diff)}</pre>
      </details>`;
    }).join("")
    : '<p class="empty-state">No audit events have been recorded yet.</p>';
  document.getElementById("load-more-audit-logs").hidden = !state.auditLogCursor;
}

function renderNotificationDelivery() {
  const container = document.getElementById("notification-delivery-list");
  if (!container) return;
  const canRetry = state.data.capabilities?.administerWorkspace === true;
  container.innerHTML = state.notificationDeliveryEvents.length
    ? state.notificationDeliveryEvents.map((event) => `
      <article class="list-row">
        <div>
          <strong>${escapeHtml(event.event_type)} · ${escapeHtml(event.status)}</strong>
          <small>${escapeHtml(event.last_attempted_at || event.created_at)} · ${escapeHtml(event.attempts)} attempt(s)</small>
          <small>${escapeHtml(event.last_error || "Delivery is waiting for its next retry.")}</small>
        </div>
        ${event.status === "failed" && canRetry
          ? `<button class="text-button" type="button" data-retry-notification="${event.id}">Retry</button>`
          : ""}
      </article>`).join("")
    : '<p class="empty-state">No notification delivery failures or retried events.</p>';
}

async function loadAuditLogs(append = false) {
  if (isWorkspaceDemo || !state.data.capabilities?.viewAuditLogs) return;
  if (!append) {
    state.auditLogEvents = [];
    state.auditLogCursor = null;
  }
  const query = new URLSearchParams({ limit: "50" });
  if (append && state.auditLogCursor) query.set("cursor", state.auditLogCursor);
  const { events, nextCursor } = await api(`/api/product/audit-logs?${query}`);
  state.auditLogEvents = append ? [...state.auditLogEvents, ...events] : events;
  state.auditLogCursor = nextCursor;
  renderAuditLogs();
}

async function loadNotificationDelivery() {
  if (isWorkspaceDemo || !state.data.capabilities?.viewAuditLogs) return;
  const { events } = await api("/api/product/notification-delivery");
  state.notificationDeliveryEvents = events;
  renderNotificationDelivery();
}

function renderFinancialDashboard() {
  const dashboard = state.financialDashboard;
  if (!dashboard) return;
  const summary = dashboard.summary;
  document.getElementById("financial-kpis").innerHTML = [
    ["Total portfolio revenue", summary.total_portfolio_revenue],
    ["Total delivery cost", summary.total_delivery_cost],
    ["Average gross margin", `${(Number(summary.average_gross_margin_pct) || 0).toFixed(1)}%`],
    ["Unbilled overage leakage", summary.total_unbilled_overage_leakage]
  ].map(([label, value]) => `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${typeof value === "number" ? formatMoney(value) : escapeHtml(value)}</strong></article>`).join("");
  const unpricedMinutes = Number(summary.unpriced_minutes) || 0;
  const dataQuality = document.getElementById("financial-data-quality");
  dataQuality.hidden = unpricedMinutes === 0;
  dataQuality.textContent = unpricedMinutes > 0
    ? `${(unpricedMinutes / 60).toFixed(1)} hours have no historical cost-rate snapshot. They are excluded from delivery cost and margin rather than estimated using today's rates.`
    : "";
  const filter = document.getElementById("financial-risk-filter").value;
  const sortBy = document.getElementById("financial-sort").value;
  const projects = dashboard.projects.filter((project) => {
    const atRisk = project.gross_margin_pct < 0 || project.gross_margin_pct < 20
      || project.burn_pct >= 90 || project.unbilled_overage_leakage > 0 || project.unpriced_minutes > 0;
    return filter === "all" || (filter === "at-risk" ? atRisk : !atRisk);
  }).sort((left, right) => {
    const key = { margin: "gross_margin_pct", profit: "gross_profit", revenue: "contract_value", cost: "delivery_cost" }[sortBy];
    return Number(left[key]) - Number(right[key]);
  });
  document.getElementById("financial-project-table").innerHTML = projects.length ? `
    <table class="data-table financial-table">
      <thead><tr><th>Implementation</th><th>Contract value</th><th>Delivery cost</th><th>Gross profit</th><th>Margin</th><th>Budget burn</th><th>Unpriced time</th><th>Overage leakage</th><th>Next step</th></tr></thead>
      <tbody>${projects.map((project) => {
        const atRisk = project.gross_margin_pct < 0 || project.gross_margin_pct < 20
          || project.burn_pct >= 90 || project.unbilled_overage_leakage > 0 || project.unpriced_minutes > 0;
        const burn = project.burn_pct === null ? "—" : `${Number(project.burn_pct).toFixed(1)}%`;
        return `<tr class="${atRisk ? "financial-risk-row" : ""}">
          <th scope="row">${escapeHtml(project.customer_name)}</th>
          <td>${formatMoney(project.contract_value)}</td><td>${formatMoney(project.delivery_cost)}</td>
          <td>${formatMoney(project.gross_profit)}</td><td>${Number(project.gross_margin_pct).toFixed(1)}%</td>
          <td>${burn}</td><td>${(Number(project.unpriced_minutes || 0) / 60).toFixed(1)}h</td>
          <td>${formatMoney(project.unbilled_overage_leakage)}</td>
          <td><div class="button-row"><button class="text-button" type="button" data-financial-open="${project.id}">Open</button>
          <button class="text-button" type="button" data-financial-change-order="${project.id}">Create change order</button></div></td>
        </tr>`;
      }).join("")}</tbody>
    </table>` : '<p class="empty-state">No active implementations match these filters.</p>';
  document.getElementById("financial-alerts").innerHTML = dashboard.alerts.length
    ? dashboard.alerts.map((alert) => `<article class="list-row"><div><strong>${escapeHtml(alert.payload.severity)} · ${escapeHtml(alert.payload.customerName)}</strong><small>${escapeHtml(alert.payload.burnPercent)}% burn · ${escapeHtml(alert.created_at)} · ${escapeHtml(alert.status)}</small></div><button class="text-button" type="button" data-financial-open="${alert.implementation_id}">Open implementation</button></article>`).join("")
    : '<p class="muted">No budget alerts have been triggered.</p>';
}

async function loadFinancialDashboard() {
  const dashboard = await api("/api/product/analytics/portfolio-margins");
  state.financialDashboard = dashboard;
  renderFinancialDashboard();
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
          <small>${escapeHtml(step.stage)} · Role: ${escapeHtml(step.owner || "Not assigned")} · Due ${step.due_offset_days} days after start · Estimated duration ${step.estimated_duration_days || 1} days · ${step.responsible_party === "client" ? "Client-owned" : "Relay-owned"}</small>
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
    : `<div class="empty-state"><strong>This process map has no steps yet</strong><p>Add one task your team completes for a new customer, with clear instructions and a responsible role. One step is enough to start; no full wiring diagram required.</p><button class="button secondary" type="button" data-workflow-action="focus-step">Add the first step</button></div>`;
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
    container.innerHTML = `<div class="empty-state"><strong>No templates on the shelf yet</strong><p>Check a process, then save it as the wiring diagram you can reuse for each new customer implementation.</p><button class="button secondary" type="button" data-workflow-action="${next.action}">${escapeHtml(next.label)}</button></div>`;
    return;
  }
  container.innerHTML = state.data.templates.map((template) => {
    const implementationCount = state.data.implementations.filter((implementation) =>
      Number(implementation.template_id) === Number(template.id)
    ).length;
    const selectedForHubSpot = state.data.integrations.some((integration) =>
      integration.provider === "hubspot"
      && Number(integration.hubspot_onboarding_template_id) === Number(template.id)
    );
    const deleteReasons = [];
    if (implementationCount) {
      deleteReasons.push(`Used by ${implementationCount} existing implementation${implementationCount === 1 ? "" : "s"}; Relay keeps it linked to preserve those records.`);
    }
    if (selectedForHubSpot) {
      deleteReasons.push("Selected for HubSpot onboarding; choose a different template in Integrations first.");
    }
    const deleteReason = deleteReasons.join(" ");
    const versionLabel = state.data.plan?.features.templateHistory
      ? `Revision ${template.revision}`
      : "Current version";
    const implementationUsageLabel = implementationCount
      ? ` · Used by ${implementationCount} implementation${implementationCount === 1 ? "" : "s"}`
      : "";
    const deleteButtonAttributes = deleteReason
      ? `disabled aria-describedby="template-delete-note-${template.id}" title="${escapeHtml(deleteReason)}"`
      : "";
    return `
    <article class="template-card">
      <div class="template-card-summary">
        <span class="badge ready">Reusable workflow</span>
        <h3>${escapeHtml(template.name)}</h3>
        <p>${template.step_count} steps · ${versionLabel}${implementationUsageLabel}</p>
        <p>Customer work gets its own copy.</p>
      </div>
      <button class="button primary" type="button" data-start-template="${template.id}">Use template</button>
      <details class="template-management">
        <summary>Manage template</summary>
        <div class="template-management-content">
          <form data-edit-template="${template.id}">
            <label for="template-name-${template.id}">Template name</label>
            <input id="template-name-${template.id}" name="name" maxlength="100" value="${escapeHtml(template.name)}" required>
            <button class="button secondary" type="submit">Save name</button>
          </form>
          <button class="text-button" type="button" data-refresh-template="${template.id}">Refresh from tested process</button>
          <details data-template-history="${template.id}" data-growth-only="templateHistory">
            <summary>Version history</summary>
            <button class="text-button" type="button" data-load-template-versions="${template.id}">Load versions</button>
            <ol data-template-version-list="${template.id}"></ol>
          </details>
          ${deleteReason ? `<p id="template-delete-note-${template.id}" class="template-delete-note" role="note">${escapeHtml(deleteReason)}</p>` : ""}
          <button class="text-button" type="button" data-delete-template="${template.id}" ${deleteButtonAttributes}>${deleteReason ? "Delete unavailable" : "Delete template"}</button>
        </div>
      </details>
    </article>`;
  }).join("");
}

function renderImplementations() {
  const form = document.getElementById("implementation-form");
  const prerequisite = document.getElementById("implementation-prerequisite");
  const canManageImplementations = state.data.capabilities?.manageImplementations === true;
  form.hidden = !canManageImplementations || state.data.templates.length === 0;
  prerequisite.hidden = !canManageImplementations || state.data.templates.length > 0;
  if (!prerequisite.hidden) {
    if (state.data.capabilities?.administerWorkspace) {
      const next = getNextWorkflowAction();
      prerequisite.innerHTML = emptyStateMarkup(
        "A template is needed first",
        "Templates are checked process snapshots. Create a process map, save its steps, run the check, then create a template.",
        next.label,
        next.action
      );
    } else {
      prerequisite.innerHTML = "<strong>No reusable template is available yet</strong><p>Ask a workspace admin to prepare a template before starting an implementation.</p>";
    }
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
  const archived = state.data.archivedImplementations || [];
  document.getElementById("show-archived-implementations").textContent = `View archived (${archived.length})`;
  document.getElementById("archived-implementation-list").innerHTML = archived.length
    ? `<table class="data-table"><thead><tr><th>Customer</th><th>Template</th><th>Archived</th><th></th></tr></thead><tbody>${archived.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.customer_name)}</strong></td>
        <td>${escapeHtml(item.template_name)}</td>
        <td>${escapeHtml(new Date(item.archived_at).toLocaleDateString())}</td>
        <td><div class="button-row">${state.data.capabilities?.administerWorkspace ? `<button class="row-button" type="button" data-restore-implementation="${item.id}">Restore</button><button class="text-button danger-text" type="button" data-delete-archived-implementation="${item.id}">Permanently delete</button>` : "Workspace admin can restore or delete"}</div></td>
      </tr>`).join("")}</tbody></table>`
    : '<div class="empty-state"><strong>No archived implementations</strong><p>When you archive a customer implementation, it will appear here and can be restored.</p></div>';
  document.getElementById("show-archived-implementations").hidden = !state.data.capabilities?.administerWorkspace;
  document.getElementById("archive-implementation").hidden = !state.data.capabilities?.administerWorkspace;
  document.getElementById("delete-implementation").hidden = !state.data.capabilities?.administerWorkspace;
  document.getElementById("archived-implementations-panel").hidden = state.implementationListMode !== "archived";
  document.getElementById("implementation-list-panel").hidden = state.implementationListMode === "archived";
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
  renderNotificationDelivery();
  renderIntegrations();
  renderAutomationAndCapacity();
  renderGettingStarted();
}

async function openImplementation(implementationId) {
  if (dirtyScopes.size && !confirmDiscardChanges()) return false;
  const { implementation } = await api(`/api/product/implementations/${implementationId}`);
  if (state.selectedImplementationId !== implementation.id) {
    document.querySelectorAll("#implementation-detail details").forEach((section) => {
      section.open = false;
    });
  }
  state.selectedImplementationId = implementation.id;
  const panel = document.getElementById("implementation-detail");
  panel.hidden = false;
  document.getElementById("implementation-detail-title").textContent = implementation.customer_name;
  document.getElementById("implementation-detail-subtitle").textContent = `Started from ${implementation.template_name}`;
  const sampleStory = document.getElementById("sample-story-card");
  sampleStory.hidden = !isWorkspaceDemo;
  if (isWorkspaceDemo) {
    const completed = implementation.steps.filter((step) => step.status === "done").length;
    const total = implementation.steps.length;
    const progress = total ? Math.round(completed / total * 100) : 0;
    const blockers = implementation.steps.filter((step) => step.is_blocked && step.status !== "done");
    const blocker = blockers[0];
    const ring = document.getElementById("sample-progress-ring");
    ring.style.setProperty("--progress", `${progress}%`);
    ring.setAttribute("aria-valuenow", String(progress));
    document.getElementById("sample-progress-value").textContent = `${progress}%`;
    document.getElementById("sample-story-title").textContent = implementation.customer_name;
    document.getElementById("sample-story-progress").textContent =
      `${completed} of ${total} tasks done. ${blockers.length} ${blockers.length === 1 ? "blocker remains" : "blockers remain"} open.`;
    const sampleStages = [
      { key: "kickoff", label: "Plan" },
      { key: "configuration", label: "Connect" },
      { key: "testing", label: "Check" },
      { key: "launch", label: "Launch" }
    ];
    const currentStage = sampleStages.find(({ key }) =>
      implementation.steps.some((step) => String(step.stage || "").toLowerCase() === key && step.status !== "done"))?.key;
    document.getElementById("sample-stage-path").innerHTML = sampleStages.map((stage, index) => {
      const tasks = implementation.steps.filter((step) => String(step.stage || "").toLowerCase() === stage.key);
      const done = tasks.length > 0 && tasks.every((step) => step.status === "done");
      const current = stage.key === currentStage;
      const stateLabel = done ? "Done" : current ? "In progress" : tasks.length ? "Up next" : "No sample tasks";
      return `<li class="sample-stage ${done ? "is-complete" : current ? "is-current" : "is-upcoming"}">
        <button type="button" data-sample-stage="${stage.key}" ${tasks.length ? "" : "disabled"} ${current ? 'aria-current="step"' : ""}>
          <span class="sample-stage-node" aria-hidden="true">${done ? "✓" : index + 1}</span>
          <span><strong>${stage.label}</strong><small>${stateLabel}</small></span>
        </button>
      </li>`;
    }).join("");
    const blockerOwner = blocker?.is_blocked
      ? blocker.owner || blocker.waiting_on || "the next owner"
      : blocker?.waiting_on || blocker?.owner || "the next owner";
    const waitDays = blocker?.updated_at
      ? Math.max(0, Math.floor((Date.now() - Date.parse(blocker.updated_at)) / 86400000))
      : 0;
    document.getElementById("sample-blocker-title").textContent = blocker
      ? `Waiting on ${blockerOwner} · ${blocker.title}`
      : "No open blocker in this sample";
    document.getElementById("sample-blocker-description").textContent = blocker
      ? `Day ${waitDays} · ${blocker.blocker_reason || "The next item is still open."} ${blocker.blocker_next_action || ""}`.trim()
      : "The current sample has no blocked task. No follow-up is needed.";
    document.getElementById("sample-story-explanation").textContent = blocker
      ? `The sample task is assigned to ${blockerOwner}. This status is fictional local data; no reminder was scheduled and no customer activity was recorded.`
      : "This sample view is fictional local data. No reminder was scheduled and no customer activity was recorded.";
    const blockerAction = document.getElementById("sample-blocker-action");
    blockerAction.hidden = !blocker;
    if (blocker) blockerAction.dataset.sampleTask = String(blocker.id);
    else delete blockerAction.dataset.sampleTask;

    const item = blocker
      ? blocker.title.toLowerCase().replace(/^(?:add|configure|prepare|approve)\s+/i, "").replace(/\bdns\b/gi, "DNS")
      : "the next onboarding step";
    const customer = implementation.customer_name;
    const messages = {
      soft: `Hi ${blockerOwner}, hope your week is going well. We’re waiting on ${item} to continue ${customer}’s onboarding. Could you share an update when you have a moment? Happy to clarify anything that would help.`,
      firm: `Hi ${blockerOwner}, to keep ${customer}’s onboarding moving, we need ${item}. Please let us know by [date] whether you can provide it or if another owner should help.`,
      escalation: `Hi ${blockerOwner}, ${customer}’s onboarding is waiting on ${item}. If someone else owns this, please forward this note or share their name so we can agree on the next step and a realistic timeline.`
    };
    const draft = document.getElementById("sample-nudge-draft");
    const toneButtons = [...sampleStory.querySelectorAll("[data-sample-tone]")];
    for (const button of toneButtons) {
      button.onclick = () => {
        for (const toneButton of toneButtons) {
          toneButton.setAttribute("aria-pressed", String(toneButton === button));
        }
        draft.value = messages[button.dataset.sampleTone];
        document.getElementById("sample-nudge-status").textContent = "";
      };
    }
    const selectedTone = sampleStory.querySelector('[data-sample-tone][aria-pressed="true"]')?.dataset.sampleTone || "soft";
    draft.value = messages[selectedTone];
    document.getElementById("copy-sample-nudge").onclick = async () => {
      try {
        await navigator.clipboard.writeText(draft.value);
        document.getElementById("sample-nudge-status").textContent = "Copied. No message was sent.";
      } catch {
        document.getElementById("sample-nudge-status").textContent =
          "Copy unavailable. Select the draft and copy it manually.";
      }
    };
  }
  const budgetBurn = implementation.budgetBurn || {};
  const budgetTypeNames = {
    fixed_hours: "Fixed hours",
    fixed_fee: "Fixed fee",
    time_and_materials: "Time and materials"
  };
  const burnPanel = document.getElementById("implementation-budget-burn");
  const hasFinancialProtection = state.data.plan?.features.financialProtection === true
    && state.data.capabilities?.viewFinancials === true;
  burnPanel.hidden = !hasFinancialProtection;
  if (!hasFinancialProtection) {
    burnPanel.replaceChildren();
  } else if (budgetBurn.burn_pct === null) {
    burnPanel.innerHTML = `<strong>${escapeHtml(budgetTypeNames[implementation.budget_type] || "Budget")} · no fixed cap</strong><span>Logged ${Math.round((budgetBurn.logged_minutes || 0) / 60 * 10) / 10} hours</span>`;
  } else {
    const burn = Number(budgetBurn.burn_pct) || 0;
    const burnLevel = burn >= 90 ? "danger" : burn >= 75 ? "warning" : "healthy";
    const consumed = implementation.budget_type === "fixed_hours"
      ? `${(budgetBurn.logged_minutes / 60).toFixed(1)} / ${Number(implementation.budget_limit).toLocaleString()} hours`
      : `${formatMoney(budgetBurn.delivery_cost)} / ${formatMoney(implementation.budget_limit)} delivery cost`;
    burnPanel.innerHTML = `<div class="budget-burn-copy"><strong>${escapeHtml(budgetTypeNames[implementation.budget_type] || "Budget")} · ${burn.toFixed(1)}%</strong><span>${escapeHtml(consumed)}</span></div>
      <div class="budget-burn-track" role="progressbar" aria-label="Project budget burn" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(burn))}"><span class="budget-burn-fill ${burnLevel}" style="width:${Math.min(100, burn)}%"></span></div>
      <span class="budget-burn-description">${burn >= 100 ? "Budget exceeded" : burn >= 90 ? "Critical budget burn" : burn >= 75 ? "Budget warning" : "Within budget"}</span>`;
  }
  const budgetForm = document.getElementById("budget-cap-form");
  budgetForm.hidden = !hasFinancialProtection || !state.data.capabilities?.manageFinancials;
  document.getElementById("budget-base-fee").value = implementation.base_onboarding_fee || 0;
  document.getElementById("budget-type").value = implementation.budget_type || "fixed_hours";
  document.getElementById("budget-limit").value = implementation.budget_limit || 0;
  document.getElementById("budget-hard-lock").checked = Boolean(implementation.hard_lock_on_exceed);
  const overrideForm = document.getElementById("budget-override-form");
  overrideForm.hidden = !hasFinancialProtection || !state.data.capabilities?.manageFinancials || !implementation.hard_lock_on_exceed
    || budgetBurn.burn_pct === null || budgetBurn.burn_pct < 100;
  document.getElementById("budget-cap-status").textContent = "";
  document.getElementById("budget-override-status").textContent = "";
  document.getElementById("archive-implementation").dataset.archiveImplementation = implementation.id;
  document.getElementById("delete-implementation").dataset.deleteImplementation = implementation.id;
  const customerAccessSummary = document.getElementById("customer-access-summary");
  customerAccessSummary.hidden = !implementation.has_customer_link;
  customerAccessSummary.textContent = implementation.has_customer_link ? "Shared link active" : "";
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
  const timeEntries = implementation.timeEntries || [];
  const canTrackTime = state.data.plan?.features.financialProtection === true
    && state.data.capabilities?.logTime === true;
  const canDeleteTimeEntry = (entry) => state.data.capabilities?.manageImplementations
    || Number(entry.user_id) === Number(state.user?.id);
  const deliveryItems = [];
  deliveryItems.push(...timeEntries.slice(0, 5).map((entry) =>
    `<article class="list-row"><div><strong>${Math.floor(entry.minutes / 60)}h ${entry.minutes % 60}m</strong><small>${escapeHtml(entry.work_date)} · ${entry.billable ? "Billable" : "Non-billable"} · ${escapeHtml(entry.user_email || "Team member")}${entry.labor_cost === undefined ? "" : ` · ${entry.rate_snapshot_present === false ? "Cost snapshot unavailable" : `${formatMoney(entry.labor_cost)} labor`}`}</small></div>${canDeleteTimeEntry(entry) ? `<button class="text-button danger-text" type="button" data-delete-time-entry="${entry.id}">Delete</button>` : ""}</article>`));
  deliveryItems.push(...(implementation.approvals || []).map((approval) =>
    `<article class="list-row"><div><strong>${escapeHtml(approval.title)}</strong><small>${escapeHtml(approval.approval_type)} · ${escapeHtml(approval.status)} · Required before leaving ${escapeHtml(approval.stage_gate || "kickoff")}${approval.due_at ? ` · Due ${escapeHtml(approval.due_at)}` : ""}</small></div><div class="button-row">${approval.status !== "approved" ? `<button class="text-button" type="button" data-approval-status="${approval.id}">Approve</button>` : ""}<button class="text-button danger-text" type="button" data-delete-approval="${approval.id}">Delete</button></div></article>`));
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
  const completedSteps = implementation.steps.filter((step) => step.status === "done").length;
  document.getElementById("implementation-step-summary").textContent = implementation.steps.length
    ? `${completedSteps} of ${implementation.steps.length} tasks done`
    : "No tasks yet";
  const taskStatuses = {
    not_started: { label: "Not started", className: "status-not_started" },
    in_progress: { label: "In progress", className: "status-in_progress" },
    done: { label: "Done", className: "ready" }
  };
  document.getElementById("implementation-step-list").innerHTML = implementation.steps.length
    ? implementation.steps.map((step, index) => {
      const taskStatus = Object.hasOwn(taskStatuses, step.status)
        ? taskStatuses[step.status]
        : taskStatuses.not_started;
      const taskEntries = timeEntries.filter((entry) => entry.task_id === step.id);
      const taskTimerIsActive = state.activeTimeTimer?.implementationId === implementation.id
        && state.activeTimeTimer?.taskId === step.id;
      const credentialProvider = step.credential_verification_json?.provider || "";
      const engineeringIssues = Array.isArray(step.engineering_issues) ? step.engineering_issues : [];
      const engineeringProviders = state.data.engineeringProviders || [];
      return `
      <article class="step-card" id="${isWorkspaceDemo ? `sample-task-${step.id}` : `implementation-task-${step.id}`}" tabindex="-1">
        <span class="step-number">${index + 1}</span>
        <div class="task-main"><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p>
          <small>${escapeHtml(step.stage)} · Role: ${escapeHtml(step.owner || "Not assigned")} · Due ${escapeHtml(step.due_at || "not scheduled")}</small>
          <small>Assigned to: ${escapeHtml(step.assignee_email || "No workspace member assigned")}</small>
          ${state.data.plan?.features.dependencies && step.waiting_on ? `<small>Waiting on: ${escapeHtml(step.waiting_on)}</small>` : ""}
          ${state.data.plan?.features.blockers && step.is_blocked ? `<p class="status warning"><strong>Blocked:</strong> ${escapeHtml(step.blocker_reason)}<br><strong>Next action:</strong> ${escapeHtml(step.blocker_next_action)}</p>` : ""}
        </div>
        <span class="badge task-status-badge ${taskStatus.className}">${taskStatus.label}</span>
        <details class="task-engineering-details" ${state.data.plan?.features.enterpriseIntegrations ? "" : "hidden"}>
          <summary>Engineering sync</summary>
          <div class="task-engineering-controls">
            ${engineeringIssues.map((issue) => {
              const issueUrl = safeEngineeringIssueUrl(issue);
              const issueName = `${issue.provider === "jira" ? "Jira" : issue.provider === "linear" ? "Linear" : "Issue"} ${escapeHtml(issue.issue_key)}`;
              return `<p class="status">
              ${issueUrl ? `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">${issueName}</a>` : issueName}
              · ${escapeHtml(issue.last_status || "Pending")}${issue.last_error ? `<br><small>${escapeHtml(issue.last_error)}</small>` : ""}
            </p>`;
            }).join("")}
            ${state.data.capabilities?.manageTasks && taskStatus.label !== "Done" ? `
              ${engineeringProviders.some((provider) => !engineeringIssues.some((issue) => issue.provider === provider)) ? `
                <label>Send task to
                  <select data-engineering-provider="${step.id}">
                    ${engineeringProviders.filter((provider) => !engineeringIssues.some((issue) => issue.provider === provider))
                      .map((provider) => `<option value="${provider}">${provider === "jira" ? "Jira" : "Linear"}</option>`).join("")}
                  </select>
                </label>
                <button class="text-button" type="button" data-engineering-escalate="${step.id}" data-engineering-implementation="${implementation.id}">Escalate to engineering</button>
                <small>Only the task, customer name, due date, and projected go-live date are sent. Financial details are excluded.</small>
              ` : engineeringProviders.length ? "" : "<small>Ask a workspace admin to configure Jira or Linear.</small>"}
            ` : ""}
            <p data-engineering-status="${step.id}" role="status" aria-live="polite"></p>
          </div>
        </details>
        <details class="task-time-details" ${canTrackTime ? "" : "hidden"}>
          <summary>Time &amp; effort</summary>
          <div class="task-time-controls">
            <p data-time-elapsed="${step.id}" data-time-implementation="${implementation.id}" role="status" aria-live="polite">${taskTimerIsActive ? `Running · ${formatElapsed(Date.now() - state.activeTimeTimer.startedAt)}` : "Timer stopped"}</p>
            <div class="button-row">
              <button class="button secondary" type="button" data-time-start="${step.id}" data-time-implementation="${implementation.id}" ${taskTimerIsActive ? "hidden" : ""}>Start timer</button>
              <button class="button secondary" type="button" data-time-stop="${step.id}" data-time-implementation="${implementation.id}" ${taskTimerIsActive ? "" : "hidden"}>Stop &amp; log</button>
              <button class="text-button" type="button" data-time-preset="15" data-time-task="${step.id}">+15m</button>
              <button class="text-button" type="button" data-time-preset="30" data-time-task="${step.id}">+30m</button>
              <button class="text-button" type="button" data-time-preset="60" data-time-task="${step.id}">+1h</button>
              <button class="text-button" type="button" data-time-preset="120" data-time-task="${step.id}">+2h</button>
            </div>
            <div class="task-time-custom">
              <label>Custom minutes<input data-time-custom="${step.id}" type="number" min="1" max="1440" step="1" value="30"></label>
              <label>Note<input data-time-note="${step.id}" maxlength="500"></label>
              <label class="check-field"><input data-time-billable="${step.id}" type="checkbox" ${step.change_order_approved ? "checked" : ""}> Billable</label>
              <button class="text-button" type="button" data-time-log-custom="${step.id}">Log custom time</button>
            </div>
            ${taskEntries.length ? `<div class="task-time-history">${taskEntries.slice(0, 3).map((entry) =>
              `<small>${Math.floor(entry.minutes / 60)}h ${entry.minutes % 60}m · ${escapeHtml(entry.work_date)}${entry.labor_cost === undefined ? "" : ` · ${entry.rate_snapshot_present === false ? "Cost snapshot unavailable" : `${formatMoney(entry.labor_cost)} labor`}`} · ${escapeHtml(entry.user_email || "Team member")}</small>`
            ).join("")}</div>` : ""}
          </div>
        </details>
        <details class="task-edit-details">
          <summary aria-label="Edit task: ${escapeHtml(step.title)}">Edit task</summary>
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
            ${state.data.plan?.features.csvSchemaValidation ? `<label data-plan-feature="csvSchemaValidation" data-role-capability="administerWorkspace">
              CSV validation schema (JSON)
              <textarea data-task-csv-schema="${step.id}" maxlength="16000" spellcheck="false">${escapeHtml(JSON.stringify(step.csv_schema_json || [], null, 2))}</textarea>
              <small>Use column_name, data_type (email, iso_date, currency, string), required, and optional regex. Use [] to disable validation.</small>
            </label>` : ""}
            ${state.data.plan?.features.credentialVerification ? `<label data-plan-feature="credentialVerification" data-role-capability="administerWorkspace">
              Credential verification for customer task
              <select data-task-credential-provider="${step.id}">
                <option value="" ${credentialProvider ? "" : "selected"}>Not a credential verification task</option>
                <option value="hubspot" ${credentialProvider === "hubspot" ? "selected" : ""}>HubSpot</option>
                <option value="jira" ${credentialProvider === "jira" ? "selected" : ""}>Jira Cloud (OAuth token)</option>
                <option value="linear" ${credentialProvider === "linear" ? "selected" : ""}>Linear</option>
                <option value="salesforce" ${credentialProvider === "salesforce" ? "selected" : ""}>Salesforce</option>
                <option value="slack" ${credentialProvider === "slack" ? "selected" : ""}>Slack</option>
              </select>
              <small>Relay tests only fixed, allowlisted provider endpoints. Customer credentials are not stored.</small>
            </label>` : ""}
            <button class="button secondary" type="button" data-save-task="${step.id}">Save changes</button>
          </div>
        </details>
      </article>`;
    }).join("")
    : '<p class="empty-state">This implementation has no work steps. Start a new one from a template with steps.</p>';
  document.getElementById("implementation-requirements").innerHTML = implementation.requirements.length
    ? implementation.requirements.map((requirement) => `
      <article class="info-row"><strong>${escapeHtml(requirement.name)}</strong>
        <p>${escapeHtml(requirement.description || "No extra instructions.")}</p>
        <span class="badge ${requirement.value.trim() ? "ready" : requirement.required ? "attention" : ""}">${requirement.value.trim() ? "Received" : requirement.required ? "Required · not received" : "Optional · not received"}</span>
        ${requirement.value ? `<p>${escapeHtml(requirement.value)}</p>` : ""}
      </article>`).join("")
    : '<div class="empty-state"><strong>No customer information requested</strong><p>Add a specific request if this customer needs to provide setup details.</p><button class="button secondary" type="button" data-workflow-action="add-requirement">Create an information request</button></div>';
  document.getElementById("change-order-task-ids").innerHTML = implementation.steps
    .filter((step) => step.customer_visible)
    .map((step) => `<option value="${step.id}">${escapeHtml(step.title)}</option>`).join("");
  document.getElementById("change-order-list").innerHTML = (implementation.changeOrders || []).length
    ? implementation.changeOrders.map((order) => `
      <article class="list-row">
        <div><strong>${escapeHtml(order.title)}</strong><small>${escapeHtml(order.scope_description)}</small>
          <small>${escapeHtml(order.status)} · $${Number(order.additional_fee || 0).toLocaleString()} · ${order.timeline_extension_days || 0} day extension</small></div>
        ${order.status === "draft" ? `<button class="button secondary" type="button" data-send-change-order="${order.id}">Send to customer</button>` : ""}
      </article>`).join("")
    : '<p class="muted">No change orders yet.</p>';
  document.getElementById("delegation-task-ids").innerHTML = implementation.steps
    .filter((step) => step.customer_visible && step.status !== "done")
    .map((step) => `<option value="${step.id}">${escapeHtml(step.title)}</option>`).join("");
  document.getElementById("delegation-list").innerHTML = (implementation.delegations || []).length
    ? implementation.delegations.map((delegation) => `
      <article class="list-row">
        <div><strong>${escapeHtml(delegation.display_name || delegation.email)}</strong><small>${escapeHtml(delegation.email)} · ${escapeHtml(delegation.stakeholder_role)}</small>
          <small>${delegation.revoked_at ? "Revoked" : Date.parse(delegation.expires_at) <= Date.now() ? "Expired" : `Active until ${new Date(delegation.expires_at).toLocaleDateString()}`}</small>
          ${delegation.task_titles?.length ? `<small>Tasks: ${escapeHtml(delegation.task_titles.join(", "))}</small>` : ""}</div>
        ${!delegation.revoked_at && Date.parse(delegation.expires_at) > Date.now() ? `<button class="text-button danger-text" type="button" data-revoke-delegation="${delegation.id}">Revoke</button>` : ""}
      </article>`).join("")
    : '<p class="muted">No scoped task delegations yet.</p>';
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
    ? implementation.customerFiles.map((file) => {
      const scanStatus = file.demo ? "Sample file"
        : file.scan_status === "clean" ? "Security scan passed"
          : file.scan_status === "infected" ? "Blocked: security scan failed"
            : file.scan_status === "pending" ? "Security scan pending" : "Scan status unavailable";
      return `
        <article class="list-row">
          <div>${file.demo ? `<strong>${escapeHtml(file.filename)}</strong>` : `<a href="/api/product/implementations/${implementation.id}/files/${file.id}">${escapeHtml(file.filename)}</a>`}
            <small>${escapeHtml(file.uploaded_by_name || "Customer team")} · ${Math.ceil(file.size_bytes / 1024)} KB · ${escapeHtml(scanStatus)}</small></div>
          <button class="text-button danger-text" type="button" data-delete-customer-file="${file.id}">Delete</button>
        </article>`;
    }).join("")
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
  updateTaskTimerDisplay();
  return true;
}

function openImplementationFromButton(button) {
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Opening...";
  openImplementation(button.dataset.openImplementation)
    .catch(showError)
    .finally(() => {
      if (!button.isConnected) return;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = label;
    });
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
      body: {
        email: document.getElementById("invite-email").value,
        role: document.getElementById("invite-role").value
      }
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

document.getElementById("refresh-audit-logs").addEventListener("click", () => {
  loadAuditLogs(false).catch(showError);
});
document.getElementById("load-more-audit-logs").addEventListener("click", () => {
  loadAuditLogs(true).catch(showError);
});
document.getElementById("refresh-notification-delivery").addEventListener("click", () => {
  loadNotificationDelivery().catch(showError);
});
document.getElementById("notification-delivery-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-retry-notification]");
  if (!button || !state.data.capabilities?.administerWorkspace) return;
  button.disabled = true;
  try {
    await api(`/api/product/notification-delivery/${button.dataset.retryNotification}/retry`, {
      method: "POST"
    });
    await loadNotificationDelivery();
    showToast("Notification retry queued.");
  } catch (error) {
    button.disabled = false;
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
    if (disconnect.dataset.disconnectIntegration === "salesforce") salesforceCatalogCache = null;
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
document.getElementById("salesforce-sku-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById("salesforce-sku-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const mappings = [...form.querySelectorAll("[data-salesforce-sku]")]
      .filter((select) => select.value)
      .map((select) => ({ sku: select.dataset.salesforceSku, templateId: select.value }));
    const result = await api("/api/product/integrations/salesforce/sku-mappings", {
      method: "PUT",
      body: { mappings }
    });
    salesforceCatalogCache = null;
    await refreshWorkspace();
    status.textContent = `${result.count} SKU mapping${result.count === 1 ? "" : "s"} saved. New matching Closed Won opportunities will be checked by the scheduled sync.`;
  } catch (error) {
    status.textContent = error.message;
    status.setAttribute("role", "alert");
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace;
  }
});
document.getElementById("jira-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById("jira-settings-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const result = await api("/api/product/integrations/jira", {
      method: "PUT",
      body: {
        baseUrl: document.getElementById("jira-site").value,
        email: document.getElementById("jira-email").value,
        projectKey: document.getElementById("jira-project-key").value,
        issueType: document.getElementById("jira-issue-type").value,
        apiToken: document.getElementById("jira-api-token").value
      }
    });
    document.getElementById("jira-api-token").value = "";
    await refreshWorkspace();
    status.textContent = `Jira connection verified for ${result.projectName}.`;
  } catch (error) {
    status.textContent = error.message;
    status.setAttribute("role", "alert");
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace;
  }
});
document.getElementById("linear-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById("linear-settings-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const result = await api("/api/product/integrations/linear", {
      method: "PUT",
      body: {
        teamId: document.getElementById("linear-team-id").value,
        apiToken: document.getElementById("linear-api-token").value
      }
    });
    document.getElementById("linear-api-token").value = "";
    await refreshWorkspace();
    status.textContent = `Linear connection verified for ${result.teamName}.`;
  } catch (error) {
    status.textContent = error.message;
    status.setAttribute("role", "alert");
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace;
  }
});
document.getElementById("jira-disconnect").addEventListener("click", async (event) => {
  if (!window.confirm("Disconnect Jira engineering sync for this workspace?")) return;
  const button = event.currentTarget;
  const status = document.getElementById("jira-settings-status");
  button.disabled = true;
  try {
    await api("/api/product/integrations/jira", { method: "DELETE" });
    await refreshWorkspace();
    status.textContent = "Jira disconnected. Existing issue links remain in Relay and will sync again if reconnected.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace;
  }
});
document.getElementById("linear-disconnect").addEventListener("click", async (event) => {
  if (!window.confirm("Disconnect Linear engineering sync for this workspace?")) return;
  const button = event.currentTarget;
  const status = document.getElementById("linear-settings-status");
  button.disabled = true;
  try {
    await api("/api/product/integrations/linear", { method: "DELETE" });
    await refreshWorkspace();
    status.textContent = "Linear disconnected. Existing issue links remain in Relay and will sync again if reconnected.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace;
  }
});
document.getElementById("slack-alert-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isWorkspaceDemo) return;
  const form = event.currentTarget;
  const status = document.getElementById("slack-alert-status");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  status.textContent = "";
  try {
    await api("/api/product/integrations/slack", {
      method: "PUT",
      body: { webhookUrl: document.getElementById("slack-webhook-url").value }
    });
    document.getElementById("slack-webhook-url").value = "";
    status.textContent = "Slack webhook saved securely.";
    await refreshWorkspace();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace;
  }
});
document.getElementById("slack-test-alert").addEventListener("click", async (event) => {
  if (isWorkspaceDemo) return;
  const button = event.currentTarget;
  const status = document.getElementById("slack-alert-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const result = await api("/api/product/integrations/slack/test", { method: "POST", body: {} });
    status.textContent = result.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace
      || !(state.data.integrations || []).some((item) => item.provider === "slack" && item.has_slack_webhook);
  }
});
document.getElementById("slack-disconnect").addEventListener("click", async (event) => {
  if (isWorkspaceDemo) return;
  if (!window.confirm("Disconnect Slack alerts for this workspace?")) return;
  const button = event.currentTarget;
  const status = document.getElementById("slack-alert-status");
  button.disabled = true;
  status.textContent = "";
  try {
    await api("/api/product/integrations/slack", { method: "DELETE" });
    await refreshWorkspace();
    status.textContent = "Slack disconnected.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !state.data.capabilities?.administerWorkspace;
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
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.view === "processes") showProcessWorkspace().catch(showError);
  else setView(button.dataset.view);
}));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.go)));
document.getElementById("refresh-button").addEventListener("click", () => refreshWorkspace().catch(showError));
document.getElementById("refresh-financials").addEventListener("click", () => loadFinancialDashboard().catch(showError));
document.getElementById("financial-risk-filter").addEventListener("change", renderFinancialDashboard);
document.getElementById("financial-sort").addEventListener("change", renderFinancialDashboard);
document.getElementById("financial-project-table").addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-financial-open], [data-financial-change-order]");
  if (!openButton) return;
  if (!setView("implementations")) return;
  const implementationId = Number(openButton.dataset.financialOpen || openButton.dataset.financialChangeOrder);
  try {
    await openImplementation(implementationId);
    if (openButton.hasAttribute("data-financial-change-order")) {
      const section = document.getElementById("change-orders-section");
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      section.querySelector("input, textarea, select, button")?.focus({ preventScroll: true });
    }
  } catch (error) {
    showError(error);
  }
});
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

document.getElementById("workspace-signal-path").addEventListener("click", (event) => {
  const checkpoint = event.target.closest("[data-circuit-filter]");
  if (!checkpoint || !setView("implementations")) return;
  clearImplementationFilters();
  const filter = checkpoint.dataset.circuitFilter;
  if (filter !== "all") {
    state.implementationFilters.attention = filter;
    document.getElementById("implementation-attention-filter").value = filter;
    renderImplementations();
  }
  const summary = document.getElementById("implementation-filter-summary");
  summary.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "center"
  });
  summary.focus({ preventScroll: true });
});

document.getElementById("implementation-list").addEventListener("click", (event) => {
  if (event.target.closest("[data-clear-implementation-filters]")) clearImplementationFilters();
});
document.getElementById("dismiss-getting-started").addEventListener("click", async () => {
  const status = document.getElementById("getting-started-status");
  try {
    const result = await api("/api/product/onboarding", { method: "PATCH", body: { dismissed: true } });
    state.onboardingDismissed = result.dismissed;
    renderOverview();
  } catch (error) {
    status.textContent = error.message;
  }
});
document.getElementById("show-getting-started").addEventListener("click", async () => {
  const status = document.getElementById("getting-started-status");
  try {
    const result = await api("/api/product/onboarding", { method: "PATCH", body: { dismissed: false } });
    state.onboardingDismissed = result.dismissed;
    renderOverview();
  } catch (error) {
    status.textContent = error.message;
  }
});
appShell.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-workflow-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.workflowAction;
  if (action === "view-implementations") {
    setView("implementations");
    return;
  }
  if (action === "create-process") {
    if (!setView("processes")) return;
    focusProcessCreation();
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
      focusProcessCreation();
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
      focusProcessCreation();
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
    document.getElementById("process-create-details").open = false;
    await loadWorkspace();
    await loadProcess(process.id);
    document.getElementById("step-title").focus();
    showToast("Process map created.");
  } catch (error) {
    showError(error);
  }
});

document.getElementById("process-progress").addEventListener("click", (event) => {
  const button = event.target.closest("[data-process-stage]");
  if (!button) return;
  const stage = Number(button.dataset.processStage);
  if (!Number.isInteger(stage) || stage < 0 || stage > 2) return;
  focusProcessStage(stage).catch(showError);
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
      removeDeletedProcess(deleteButton.dataset.deleteProcess);
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
        estimatedDurationDays: Number(document.getElementById("step-estimated-duration").value),
        responsibleParty: document.getElementById("step-responsible-party").value,
        customerVisible: document.getElementById("step-customer-visible").checked,
        dependsOn: [...document.querySelectorAll("#step-dependencies input:checked")].map((input) => Number(input.value))
      }
    });
    clearDirtyScope(form);
    const displayedStepId = savedStepId || result.step.id;
    state.editingStepId = null;
    form.reset();
    document.getElementById("step-options").open = false;
    document.getElementById("step-stage").value = "Implementation";
    document.getElementById("step-due-offset").value = "0";
    document.getElementById("step-estimated-duration").value = "1";
    document.getElementById("step-responsible-party").value = "relay";
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
  document.getElementById("step-options").open = false;
  document.getElementById("step-stage").value = "Implementation";
  document.getElementById("step-due-offset").value = "0";
  document.getElementById("step-estimated-duration").value = "1";
  document.getElementById("step-responsible-party").value = "relay";
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
    document.getElementById("step-estimated-duration").value = step.estimated_duration_days || 1;
    document.getElementById("step-responsible-party").value = step.responsible_party || (step.customer_visible ? "client" : "relay");
    document.getElementById("step-customer-visible").checked = step.customer_visible === true;
    document.getElementById("step-options").open = step.stage !== "Implementation"
      || Number(step.due_offset_days) > 0
      || Number(step.estimated_duration_days || 1) !== 1
      || (step.responsible_party || "relay") !== "relay"
      || step.customer_visible === true
      || Boolean(step.dependsOn?.length);
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
    if (!setView("implementations")) return;
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
    if (deleteButton.disabled) return;
    const template = state.data.templates.find((item) => String(item.id) === deleteButton.dataset.deleteTemplate);
    if (!window.confirm(`Delete "${template?.name || "this template"}"? Existing customer implementations will not be deleted.`)
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
    event.target.querySelector(".implementation-start-optional").open = false;
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
  if (button) openImplementationFromButton(button);
});
document.getElementById("show-archived-implementations").addEventListener("click", () => {
  if (dirtyScopes.size && !confirmDiscardChanges()) return;
  state.selectedImplementationId = null;
  document.getElementById("implementation-detail").hidden = true;
  state.implementationListMode = "archived";
  renderImplementations();
});
document.getElementById("show-active-implementations").addEventListener("click", () => {
  state.implementationListMode = "active";
  renderImplementations();
});
document.getElementById("archived-implementation-list").addEventListener("click", async (event) => {
  const restore = event.target.closest("[data-restore-implementation]");
  const remove = event.target.closest("[data-delete-archived-implementation]");
  if (restore) {
    try {
      await api(`/api/product/implementations/${restore.dataset.restoreImplementation}/restore`, { method: "PATCH" });
      await loadWorkspace();
      showToast("Implementation restored to active work.");
    } catch (error) {
      showError(error);
    }
    return;
  }
  if (!remove) return;
  const implementation = state.data.archivedImplementations.find((item) =>
    String(item.id) === remove.dataset.deleteArchivedImplementation);
  if (!implementation || !window.confirm(
    `Permanently delete "${implementation.customer_name}"? This cannot be undone and removes its tasks, customer information, portal messages, and uploaded files.`
  )) return;
  try {
    await api(`/api/product/implementations/${implementation.id}`, { method: "DELETE" });
    await loadWorkspace();
    showToast("Implementation and its customer data permanently deleted.");
  } catch (error) {
    showError(error);
  }
});
document.getElementById("overview-implementations").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-implementation]");
  if (button) {
    if (!setView("implementations")) return;
    openImplementationFromButton(button);
  }
});
document.getElementById("close-implementation").addEventListener("click", () => {
  if (dirtyScopes.size && !confirmDiscardChanges()) return;
  state.selectedImplementationId = null;
  document.getElementById("implementation-detail").hidden = true;
});
document.getElementById("archive-implementation").addEventListener("click", async (event) => {
  const implementation = state.data.implementations.find((item) =>
    String(item.id) === event.currentTarget.dataset.archiveImplementation);
  if (!implementation || !window.confirm(
    `Archive "${implementation.customer_name}"? It will leave active work and customer portal access will pause. You can restore it later.`
  ) || !confirmDiscardChanges()) return;
  try {
    await api(`/api/product/implementations/${implementation.id}/archive`, { method: "PATCH" });
    state.selectedImplementationId = null;
    document.getElementById("implementation-detail").hidden = true;
    await loadWorkspace();
    showToast("Implementation archived. You can restore it from View archived.");
  } catch (error) {
    showError(error);
  }
});
document.getElementById("delete-implementation").addEventListener("click", async (event) => {
  const implementation = state.data.implementations.find((item) =>
    String(item.id) === event.currentTarget.dataset.deleteImplementation);
  if (!implementation || !window.confirm(
    `Permanently delete "${implementation.customer_name}"? This cannot be undone and removes its tasks, customer information, portal messages, and uploaded files.`
  ) || !confirmDiscardChanges()) return;
  try {
    await api(`/api/product/implementations/${implementation.id}`, { method: "DELETE" });
    state.selectedImplementationId = null;
    document.getElementById("implementation-detail").hidden = true;
    await loadWorkspace();
    showToast("Implementation and its customer data permanently deleted.");
  } catch (error) {
    showError(error);
  }
});
document.getElementById("implementation-section-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-implementation-jump]");
  if (!button) return;
  const target = document.getElementById(button.dataset.implementationJump);
  if (!target || !document.getElementById("implementation-detail").contains(target)) {
    showError(new Error("This implementation section is unavailable. Refresh and try again."));
    return;
  }
  if (target.matches("details")) target.open = true;
  document.querySelectorAll("#implementation-section-nav [data-implementation-jump]").forEach((item) => {
    if (item === button) item.setAttribute("aria-current", "location");
    else item.removeAttribute("aria-current");
  });
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  if (target.matches("details")) target.querySelector("summary")?.focus({ preventScroll: true });
  else target.focus({ preventScroll: true });
});
document.getElementById("sample-story-card").addEventListener("click", (event) => {
  if (!isWorkspaceDemo) return;
  const stageButton = event.target.closest("[data-sample-stage]");
  const taskButton = event.target.closest("[data-sample-task]");
  const stage = stageButton?.dataset.sampleStage;
  const currentImplementation = state.data.implementations.find((item) =>
    String(item.id) === String(state.selectedImplementationId));
  const stageTasks = stage ? currentImplementation?.steps.filter((step) =>
    String(step.stage || "").toLowerCase() === stage) || [] : [];
  const taskId = taskButton?.dataset.sampleTask
    || stageTasks.find((step) => step.status !== "done")?.id
    || stageTasks.at(-1)?.id;
  if (!taskId) return;
  const target = document.getElementById(`sample-task-${taskId}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
});
document.addEventListener("click", (event) => {
  if (!isWorkspaceDemo || !event.target.closest("[data-reset-sample]")) return;
  window.localStorage.removeItem("relay-workspace-demo-portals");
  window.localStorage.removeItem(`${TASK_TIMER_STORAGE_KEY}:9000:9001`);
  window.location.reload();
});
document.getElementById("implementation-step-list").addEventListener("click", async (event) => {
  const timeAction = event.target.closest("[data-time-start], [data-time-stop], [data-time-preset], [data-time-log-custom]");
  if (timeAction && state.selectedImplementationId) {
    const root = timeAction.closest(".step-card");
    const taskId = Number(timeAction.dataset.timeStart || timeAction.dataset.timeStop
      || timeAction.dataset.timeTask || timeAction.dataset.timeLogCustom);
    try {
      if (timeAction.hasAttribute("data-time-start")) {
        if (state.activeTimeTimer && (state.activeTimeTimer.implementationId !== state.selectedImplementationId
          || state.activeTimeTimer.taskId !== taskId)) {
          showToast("Stop the active task timer before starting another.");
          return;
        }
        saveTaskTimer({ implementationId: state.selectedImplementationId, taskId, startedAt: Date.now() });
        showToast("Task timer started.");
      } else {
        const billable = root.querySelector(`[data-time-billable="${taskId}"]`).checked;
        const note = root.querySelector(`[data-time-note="${taskId}"]`).value;
        const minutes = timeAction.hasAttribute("data-time-stop")
          ? Math.max(1, Math.ceil((Date.now() - state.activeTimeTimer.startedAt) / 60000))
          : Number(timeAction.dataset.timePreset
            || root.querySelector(`[data-time-custom="${taskId}"]`).value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          throw new Error("Enter a custom duration between 1 and 1440 minutes.");
        }
        await api(`/api/product/implementations/${state.selectedImplementationId}/steps/${taskId}/time-entries`, {
          method: "POST",
          body: {
            minutes,
            workDate: new Date().toISOString().slice(0, 10),
            isBillable: billable,
            note
          }
        });

        window.setInterval(updateTaskTimerDisplay, 1000);
        if (timeAction.hasAttribute("data-time-stop")) saveTaskTimer(null);
        await openImplementation(state.selectedImplementationId);
        showToast(`Logged ${minutes} minutes.`);
      }
    } catch (error) {
      showError(error);
    }
    return;
  }
  const escalation = event.target.closest("[data-engineering-escalate]");
  if (escalation) {
    const root = escalation.closest(".step-card");
    const taskId = escalation.dataset.engineeringEscalate;
    const implementationId = escalation.dataset.engineeringImplementation;
    const provider = root.querySelector(`[data-engineering-provider="${taskId}"]`)?.value;
    const status = root.querySelector(`[data-engineering-status="${taskId}"]`);
    escalation.disabled = true;
    status.textContent = "";
    try {
      const result = await api(`/api/product/implementations/${implementationId}/tasks/${taskId}/escalate`, {
        method: "POST",
        body: { provider }
      });
      await openImplementation(implementationId);
      showToast(`Created ${result.issueKey} in ${provider === "jira" ? "Jira" : "Linear"}.`);
    } catch (error) {
      status.textContent = error.message;
      status.setAttribute("role", "alert");
      escalation.disabled = false;
    }
    return;
  }
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
    if (state.data.plan?.features.csvSchemaValidation && state.data.capabilities?.administerWorkspace) {
      try {
        taskUpdate.csvSchema = JSON.parse(root.querySelector(`[data-task-csv-schema="${stepId}"]`).value);
      } catch {
        failForm(root, new Error("Enter a valid JSON schema before saving."));
        return;
      }
    }
    if (state.data.plan?.features.credentialVerification && state.data.capabilities?.administerWorkspace) {
      taskUpdate.credentialProvider = root.querySelector(`[data-task-credential-provider="${stepId}"]`).value;
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

document.getElementById("budget-cap-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("budget-cap-status");
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/budget`, {
      method: "PATCH",
      body: {
        baseOnboardingFee: document.getElementById("budget-base-fee").value,
        budgetType: document.getElementById("budget-type").value,
        budgetLimit: document.getElementById("budget-limit").value,
        hardLockOnExceed: document.getElementById("budget-hard-lock").checked
      }
    });
    await openImplementation(state.selectedImplementationId);
    status.textContent = "Budget cap saved.";
  } catch (error) {
    status.textContent = error.message;
  }
});

document.getElementById("budget-override-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("budget-override-status");
  try {
    await api(`/api/product/implementations/${state.selectedImplementationId}/budget-overrides`, {
      method: "POST",
      body: {
        reason: document.getElementById("budget-override-reason").value,
        durationHours: Number(document.getElementById("budget-override-hours").value)
      }
    });
    event.currentTarget.reset();
    status.textContent = "Time-entry override granted.";
  } catch (error) {
    status.textContent = error.message;
  }
});

document.getElementById("approval-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedImplementationId) return;
  const status = document.getElementById("approval-status");
  try { await api(`/api/product/implementations/${state.selectedImplementationId}/approvals`, { method: "POST", body: { title: document.getElementById("approval-title").value, stageGate: document.getElementById("approval-stage").value, approvalType: document.getElementById("approval-type").value, approverName: document.getElementById("approval-name").value, approverEmail: document.getElementById("approval-email").value, dueAt: document.getElementById("approval-due").value } }); event.currentTarget.reset(); await openImplementation(state.selectedImplementationId); status.textContent = "Approval requested."; } catch (error) { status.textContent = error.message; }
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

      document.getElementById("change-order-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!state.selectedImplementationId) return;
        const status = document.getElementById("change-order-status");
        const taskIds = [...document.getElementById("change-order-task-ids").selectedOptions].map((option) => Number(option.value));
        status.textContent = "";
        try {
          await api(`/api/product/implementations/${state.selectedImplementationId}/change-orders`, {
            method: "POST",
            body: {
              title: document.getElementById("change-order-title").value,
              scopeDescription: document.getElementById("change-order-description").value,
              additionalFee: document.getElementById("change-order-fee").value,
              timelineExtensionDays: Number(document.getElementById("change-order-days").value),
              taskIds
            }
          });
          event.currentTarget.reset();
          await openImplementation(state.selectedImplementationId);
          status.textContent = "Change order draft created.";
        } catch (error) {
          status.textContent = error.message;
        }
      });

      document.getElementById("change-order-list").addEventListener("click", async (event) => {
        const button = event.target.closest("[data-send-change-order]");
        if (!button || !state.selectedImplementationId) return;
        try {
          await api(`/api/product/implementations/${state.selectedImplementationId}/change-orders/${button.dataset.sendChangeOrder}/send`, {
            method: "POST"
          });
          await openImplementation(state.selectedImplementationId);
          showToast("Change order sent to the primary customer contact.");
        } catch (error) {
          showError(error);
        }
      });

      document.getElementById("customer-delegation-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!state.selectedImplementationId) return;
        const status = document.getElementById("delegation-status");
        const taskIds = [...document.getElementById("delegation-task-ids").selectedOptions].map((option) => Number(option.value));
        status.textContent = "";
        try {
          const result = await api(`/api/product/implementations/${state.selectedImplementationId}/delegations`, {
            method: "POST",
            body: {
              displayName: document.getElementById("delegation-name").value,
              email: document.getElementById("delegation-email").value,
              stakeholderRole: document.getElementById("delegation-role").value,
              taskIds
            }
          });
          event.currentTarget.reset();
          await openImplementation(state.selectedImplementationId);
          status.textContent = result.invitationSent
            ? `Scoped invitation sent to ${result.delegation.email}.`
            : `${result.message || "Invitation email was not sent."}${result.delegationPortalUrl ? ` Copy this private link: ${result.delegationPortalUrl}` : ""}`;
        } catch (error) {
          status.textContent = error.message;
        }
      });

      document.getElementById("delegation-list").addEventListener("click", async (event) => {
        const button = event.target.closest("[data-revoke-delegation]");
        if (!button || !state.selectedImplementationId
          || !window.confirm("Revoke this teammate’s task-specific portal access immediately?")) return;
        try {
          await api(`/api/product/implementations/${state.selectedImplementationId}/delegations/${button.dataset.revokeDelegation}/revoke`, {
            method: "POST"
          });
          await openImplementation(state.selectedImplementationId);
          showToast("Scoped task access revoked.");
        } catch (error) {
          showError(error);
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
      "Sample workspace: fictional records only. Most edits are local and reset on refresh; customer portal previews may keep a sample snapshot in this browser. No Relay account or backend is used, and no customer message is sent. Ray uses built-in answers; no external AI service is contacted.";
    await loadPreferences();
    await loadOnboarding();
    showProduct();
    await loadWorkspace();
    setView("implementations");
    await openImplementation(9040);
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
