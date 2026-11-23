"use strict";

/*
 * Customer portal: a linear, one-thing-at-a-time setup wizard.
 *
 * Architecture (top to bottom):
 *   1. api        – the only code that talks to the server (or the local demo adapter)
 *   2. store      – single source of truth: server data, step, drafts, errors, busy flags
 *   3. validators – mirror the server's rules so people see problems before they submit
 *   4. views      – pure functions: state in, HTML string out (no DOM reads)
 *   5. controller – event delegation + actions; every action is guarded against double-runs
 *
 * Why state is not lost: typed answers live in store.drafts (mirrored to sessionStorage),
 * never in the DOM. Re-rendering a step, refreshing from the server, or going back and
 * forth between steps simply re-reads the drafts.
 */
(() => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";
  const isDemo = Boolean(window.relayWorkspaceDemo);
  const TOKEN_OK = isDemo ? /^local-demo-[A-Za-z0-9_-]+$/.test(token) : /^[A-Za-z0-9_-]{40,60}$/.test(token);
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  // The server requires the Content-Type to match the extension exactly, so derive it from
  // the extension instead of trusting file.type (which is empty or odd on some systems).
  const FILE_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

  const $ = (id) => document.getElementById(id);
  const el = {
    title: $("wizard-title"), loading: $("customer-loading"), wizard: $("wizard"),
    steps: $("wizard-steps"), barFill: $("wizard-bar-fill"), banner: $("wizard-banner"), body: $("wizard-body"),
    recovery: $("customer-access-recovery"), conversation: $("customer-conversation-section"),
    messages: $("customer-messages"), messageCount: $("customer-message-count")
  };

  /* ───────────── helpers ───────────── */
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const humanize = (value) => String(value || "").replaceAll("_", " ");
  function formatDate(value) {
    if (!value) return "";
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
    return Number.isNaN(date.getTime()) ? String(value)
      : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;
  }
  const extensionOf = (name) => String(name).toLowerCase().split(".").pop();

  /* ───────────── 1. api ───────────── */
  const base = `/api/product/customer/${encodeURIComponent(token)}`;
  async function request(url, options) {
    if (isDemo) return window.relayWorkspaceDemo.request(url, options);
    let response;
    try {
      response = await fetch(url, {
        ...options, credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch {
      throw Object.assign(new Error("Could not connect. Check your connection and try again."), { offline: true });
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || "The request could not be completed.");
    return result;
  }
  async function uploadFile(file) {
    const contentType = FILE_TYPES[extensionOf(file.name)];
    if (isDemo) {
      return window.relayWorkspaceDemo.request(`${base}/files`,
        { method: "POST", body: { filename: file.name, contentType, size: file.size } });
    }
    let response;
    try {
      response = await fetch(`${base}/files`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": contentType, "X-File-Name": encodeURIComponent(file.name) }, body: file
      });
    } catch {
      throw Object.assign(new Error("Could not connect. Check your connection and try again."), { offline: true });
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || "The upload could not be completed.");
    return result;
  }
  async function uploadTaskCsv(taskId, file, mapping) {
    if (isDemo) throw new Error("CSV validation is not available in the sample workspace.");
    const contentTypes = {
      csv: "text/csv",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    };
    const headers = {
      "Content-Type": contentTypes[extensionOf(file.name)],
      "X-Relay-Filename": encodeURIComponent(file.name)
    };
    if (mapping) {
      const bytes = new TextEncoder().encode(JSON.stringify(mapping));
      let binary = "";
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      headers["X-Relay-Csv-Mapping"] = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    }
    let response;
    try {
      response = await fetch(`${base}/tasks/${taskId}/csv`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers, body: file
      });
    } catch {
      throw Object.assign(new Error("Could not connect. Check your connection and try again."), { offline: true });
    }
    const result = await response.json().catch(() => null);
    if (!response.ok && response.status !== 422) {
      throw new Error(result?.error || "The CSV could not be validated.");
    }
    return result;
  }

  /* ───────────── 2. store ───────────── */
  const draftKey = `relay-portal-draft:${[...token].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)}`;
  function loadDrafts() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey));
      return saved && typeof saved === "object" && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter(([id, value]) => /^\d+$/.test(id) && typeof value === "string"))
        : {};
    } catch { return {}; }
  }
  function saveDrafts() {
    try {
      if (Object.keys(store.drafts).length) sessionStorage.setItem(draftKey, JSON.stringify(store.drafts));
      else sessionStorage.removeItem(draftKey);
    } catch { /* storage can be unavailable (private mode); drafts still live in memory */ }
  }

  const store = {
    data: null,            // last server snapshot
    step: "overview",      // current step id
    visited: new Set(["overview"]),
    drafts: loadDrafts(),  // { [requirementId]: string } — only values that differ from the server
    errors: {},            // { [requirementId]: message }
    taskIndex: 0,
    busy: new Set(),       // names of in-flight actions; prevents double submission
    notice: "",            // transient success message for the current step
    sent: false,           // information was sent during this visit
    fileStatus: "",        // inline message under the upload control
    uploadOk: false,
    csvFiles: {},
    csvHeaders: {},
    csvMappings: {},
    csvResults: {},
    csvValidated: {},
    credentialResults: {},
    credentialVerified: {}
  };

  const requirements = () => store.data?.requirements || [];
  const tasks = () => store.data?.tasks || [];
  const valueOf = (req) => (String(req.id) in store.drafts ? store.drafts[String(req.id)] : (req.value || ""));
  const dirtyRequirements = () => requirements().filter((r) => String(r.id) in store.drafts
    && store.drafts[String(r.id)].trim() !== (r.value || "").trim());
  const openTasks = () => tasks().filter((t) => t.status !== "done");

  function stepList() {
    const list = [{ id: "overview", label: "Welcome" }];
    const taskOnly = store.data?.accessRole === "delegate";
    const readOnlyMaster = store.data?.accessRole === "primary" || store.data?.accessRole === "viewer";
    if (!readOnlyMaster && !taskOnly && requirements().length) list.push({ id: "info", label: "Your information" });
    if (tasks().length) list.push({ id: "tasks", label: "Your tasks" });
    if (!readOnlyMaster && !taskOnly) list.push({ id: "files", label: "Files" });
    if (!readOnlyMaster && !taskOnly) list.push({ id: "review", label: requirements().length ? "Review & send" : "All set" });
    return list;
  }

  /* ───────────── 3. validators (mirror product-routes.js) ───────────── */
  function validateValue(req, raw) {
    const value = String(raw ?? "").trim();
    if (!value) return req.required ? "This is required." : "";
    if (req.input_type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Enter a valid email address.";
    if (req.input_type === "url") {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) throw new Error();
      } catch { return "Enter a complete website address beginning with https://."; }
    }
    if (req.input_type === "number" && !Number.isFinite(Number(value))) return "Enter a valid number.";
    if (req.input_type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Enter a valid date.";
    return "";
  }
  function validateAll() {
    const errors = {};
    for (const req of requirements()) {
      const message = validateValue(req, valueOf(req));
      if (message) errors[req.id] = message;
    }
    return errors;
  }
  function validateFile(file) {
    if (!file) return "Choose a file first.";
    if (!FILE_TYPES[extensionOf(file.name)]) return "Only PDF, PNG, or JPG files can be uploaded.";
    if (file.size < 1) return "That file is empty.";
    if (file.size > MAX_FILE_BYTES) return "Choose a file no larger than 5 MB.";
    return "";
  }

  /* ───────────── 4. views ───────────── */
  function inputType(req) {
    return ["email", "number", "date", "url"].includes(req.input_type) ? req.input_type : "text";
  }
  function fieldHtml(req) {
    const id = `customer-input-${req.id}`;
    const error = store.errors[req.id];
    const common = `id="${id}" data-requirement="${req.id}" maxlength="2000" ${req.required ? "required" : ""}
      aria-invalid="${error ? "true" : "false"}" aria-describedby="${id}-hint ${id}-error"`;
    const input = req.input_type === "text"
      ? `<textarea ${common} placeholder="Type your answer">${escapeHtml(valueOf(req))}</textarea>`
      : `<input ${common} type="${inputType(req)}" ${req.input_type === "url" ? 'inputmode="url" placeholder="https://"' : ""}
          value="${escapeHtml(valueOf(req))}">`;
    return `<div class="field ${error ? "has-error" : ""}">
      <label for="${id}">${escapeHtml(req.name)} <span class="field-tag">${req.required ? "Required" : "Optional"}</span></label>
      ${input}
      <small id="${id}-hint">${escapeHtml(req.description || "")}</small>
      <small id="${id}-error" class="field-error" role="alert">${error ? escapeHtml(error) : ""}</small>
    </div>`;
  }
  function navHtml({ back, next, nextLabel = "Continue", nextAction = "next", skip }) {
    return `<div class="wizard-nav">
      ${back ? '<button class="button secondary" type="button" data-action="back">Back</button>' : "<span></span>"}
      <div class="wizard-nav-main">
        ${skip ? `<button class="button link" type="button" data-action="next">${skip}</button>` : ""}
        ${next === false ? "" : `<button class="button primary" type="button" data-action="${nextAction}">${nextLabel}</button>`}
      </div>
    </div>`;
  }
  const noticeHtml = () => (store.notice ? `<p class="wizard-notice" role="status">${escapeHtml(store.notice)}</p>` : "");

  function overviewView() {
    const d = store.data;
    const done = tasks().filter((t) => t.status === "done").length;
    const statusText = (value, defaults = []) => value && !defaults.includes(value) ? humanize(value) : "";
    const facts = [
      d.targetLaunchDate ? `<div><dt>Target launch</dt><dd>${escapeHtml(formatDate(d.targetLaunchDate))}</dd></div>` : "",
      d.customerOwnerName || d.customerOwnerEmail
        ? `<div><dt>Your contact</dt><dd>${escapeHtml(d.customerOwnerName || d.customerOwnerEmail)}${
          d.customerOwnerName && d.customerOwnerEmail ? `<br><small>${escapeHtml(d.customerOwnerEmail)}</small>` : ""}</dd></div>` : "",
      requirements().length ? `<div><dt>Information to share</dt><dd>${requirements().length} item${requirements().length === 1 ? "" : "s"}</dd></div>` : "",
      tasks().length ? `<div><dt>Tasks for you</dt><dd>${done} of ${tasks().length} done</dd></div>` : ""
    ].join("");
    const communicationOwner = [d.communicationOwnerName, d.communicationOwnerEmail].filter(Boolean).join(" · ");
    const supportOwner = [d.supportOwnerName, d.supportOwnerEmail].filter(Boolean).join(" · ");
    const planRows = [
      ["Success criteria", d.successCriteria],
      ["Test and acceptance", [d.testPlan, statusText(d.acceptanceStatus, ["not_started"])].filter(Boolean).join(" · ")],
      ["Training", statusText(d.trainingStatus, ["not_started"])],
      ["Adoption and change management", statusText(d.changeManagementStatus, ["not_started"])],
      ["Go-live", statusText(d.goLiveStatus, ["not_ready"])],
      ["Rollback plan", d.rollbackPlan],
      ["Support owner", supportOwner],
      ["Post-launch support", d.postLaunchSupportPlan],
      ["Communication", [d.communicationChannel, d.communicationCadence, communicationOwner].filter(Boolean).join(" · ")],
      ["Procurement and approvals", statusText(d.procurementStatus, ["not_started"])],
      ["Security and compliance", statusText(d.securityStatus, ["not_started"])],
      ["Integrations", statusText(d.integrationStatus, ["not_started"])],
      ["Technical setup", statusText(d.technicalSetupStatus, ["not_started"])],
      ["Early validation", statusText(d.earlyValidationStatus, ["not_started"])]
    ].filter(([, value]) => value);
    const progress = d.progress === null || d.progress === undefined ? null : Math.max(0, Math.min(100, Number(d.progress) || 0));
    const milestones = (d.milestones || []).map((m) =>
      `<li><span>${escapeHtml(m.name)}</span><span>${m.completed} of ${m.total}</span></li>`).join("");
    const goLiveBanner = d.goLiveShifts?.length
      ? `<div class="status warning" role="status"><strong>Projected go-live updated</strong><p>${d.goLiveShifts.map((shift) =>
        `${escapeHtml(shift.title)} was overdue and shifted the date ${shift.days_shifted} day${shift.days_shifted === 1 ? "" : "s"}`
      ).join(". ")}.</p></div>`
      : "";
    const changeOrders = d.accessRole === "primary"
      ? (d.changeOrders || []).filter((order) => order.status === "pending_client").map((order) => `
        <article class="wizard-task">
          <div class="wizard-task-head"><strong>${escapeHtml(order.title)}</strong><span class="badge attention">Approval needed</span></div>
          <p>${escapeHtml(order.scope_description)}</p>
          <small>${Number(order.additional_fee || 0).toLocaleString(undefined, { style: "currency", currency: "USD" })} · ${order.timeline_extension_days || 0} day timeline extension</small>
          <label class="check-field"><input type="checkbox" data-change-order-consent="${order.id}"> I confirm this scope, fee, and timeline change.</label>
          <div class="button-row">
            <button class="button primary" type="button" data-action="approve-change-order" data-change-order="${order.id}">Approve</button>
            <button class="button secondary" type="button" data-action="reject-change-order" data-change-order="${order.id}">Reject</button>
          </div>
        </article>`).join("")
      : "";
    return `<h2 id="step-heading" tabindex="-1">Welcome${d.customerName ? `, ${escapeHtml(d.customerName)}` : ""}</h2>
      <p class="muted">Your setup checklist keeps requests, tasks, and files together. Review your answers before sending them.</p>
      ${d.projectedGoLiveDate ? `<dl class="wizard-facts"><div><dt>Projected go-live</dt><dd>${escapeHtml(formatDate(d.projectedGoLiveDate))}</dd></div></dl>` : ""}
      ${goLiveBanner}
      ${changeOrders ? `<section aria-label="Change orders"><h3>Scope changes</h3>${changeOrders}</section>` : ""}
      ${facts ? `<dl class="wizard-facts">${facts}</dl>` : ""}
      ${progress === null ? "" : `<div class="wizard-progress"><label for="customer-progress-bar">Implementation progress · ${progress}%</label><progress id="customer-progress-bar" max="100" value="${progress}">${progress}%</progress></div>`}
      ${milestones ? `<ul class="wizard-milestones" aria-label="Progress by stage">${milestones}</ul>` : ""}
      ${planRows.length ? `<details class="wizard-more"><summary>Launch plan details</summary>
        <dl>${planRows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl></details>` : ""}
      ${navHtml({ nextLabel: "Get started" })}`;
  }

  function infoView() {
    const intro = requirements().length === 1 ? "Just one item to share." : "Fill these in — you’ll review everything before anything is sent.";
    return `<h2 id="step-heading" tabindex="-1">Your information</h2>
      <p class="muted">${intro}</p>
      <div class="wizard-fields">${requirements().map(fieldHtml).join("")}</div>
      <p class="customer-privacy">Never share passwords, API keys, payment card details, or other secrets here or in uploaded files.</p>
      ${navHtml({ back: true })}`;
  }

  function taskCard(task) {
    const blocked = task.is_blocked;
    const csvSchema = Array.isArray(task.csvSchema) ? task.csvSchema : [];
    const csvStatus = store.csvResults[task.id];
    const credentialStatus = store.credentialResults[task.id];
    const needsCredentialTest = Boolean(task.credentialProvider);
    const status = task.status === "done"
      ? '<span class="badge ready">Complete</span>'
      : task.locked_pending_co || task.status === "locked_pending_co"
        ? '<span class="badge attention">Locked pending approval</span>'
      : blocked ? '<span class="badge attention">Blocked</span>'
        : task.waiting ? '<span class="badge attention">Waiting</span>' : "";
    const meta = [task.stage, task.due_at ? `Due ${formatDate(task.due_at)}` : ""].filter(Boolean).map(escapeHtml).join(" · ");
    let action = "";
    if (store.data.accessRole === "delegate" && task.status !== "done" && !blocked && !task.waiting && !task.locked_pending_co) {
      action = `<button class="button primary" type="button" data-action="complete-task" data-task="${task.id}"
        ${(csvSchema.length && !store.csvValidated[task.id]) || (needsCredentialTest && !store.credentialVerified[task.id]) ? "disabled" : ""}>Mark complete</button>`;
    }
    const csvUpload = csvSchema.length ? `<section class="customer-csv" aria-label="CSV validation">
      <h3>Upload your data file</h3>
      <p class="muted">Choose a CSV or XLSX file. Relay checks its columns and every row before it can be accepted. XLSX uses the first worksheet.</p>
      <label for="customer-csv-${task.id}">CSV or XLSX file</label>
      <input id="customer-csv-${task.id}" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-csv-file="${task.id}">
      ${store.csvFiles[task.id] ? `<small>Selected: ${escapeHtml(store.csvFiles[task.id].name)}</small>` : ""}
      <button class="button secondary" type="button" data-action="map-csv" data-task="${task.id}">Read columns</button>
      ${store.csvHeaders[task.id]?.length ? `<div class="customer-csv-mapping">
        <p>Confirm which file column matches each requested field:</p>
        ${csvSchema.map((column, index) => {
          const selected = store.csvMappings[task.id]?.[column.column_name] || "";
          return `<label>${escapeHtml(column.column_name)}${column.required ? " · Required" : " · Optional"}
            <select data-csv-mapping="${task.id}" data-csv-column="${escapeHtml(column.column_name)}">
              <option value="">${column.required ? "Choose a column" : "Leave unmapped"}</option>
              ${store.csvHeaders[task.id].map((header) => `<option value="${escapeHtml(header)}" ${selected === header ? "selected" : ""}>${escapeHtml(header)}</option>`).join("")}
            </select>
          </label>`;
        }).join("")}
        <button class="button secondary" type="button" data-action="validate-csv" data-task="${task.id}">Validate &amp; upload</button>
      </div>` : ""}
      ${csvStatus?.errors?.length ? `<ul class="customer-csv-errors" role="alert">${csvStatus.errors.map((error) =>
        `<li>${error.row ? `Row ${error.row}${error.column ? `, ${escapeHtml(error.column)}` : ""}: ` : ""}${escapeHtml(error.message)}</li>`
      ).join("")}</ul>` : ""}
      ${csvStatus?.message ? `<p class="status ${csvStatus.valid ? "ok" : ""}" role="status" aria-live="polite">${escapeHtml(csvStatus.message)}</p>` : ""}
    </section>` : "";
    const credentialTest = needsCredentialTest ? `<section class="customer-credential" aria-label="Connection verification">
      <h3>Test ${escapeHtml(humanize(task.credentialProvider))} connection</h3>
      <p class="muted">Enter the provider API token. Relay sends it only to the selected provider for this test and does not save it.</p>
      <label for="customer-credential-${task.id}">API token</label>
      <input id="customer-credential-${task.id}" type="password" autocomplete="new-password" data-credential="${task.id}">
      <button class="button secondary" type="button" data-action="verify-credential" data-task="${task.id}">Test connection</button>
      ${credentialStatus?.message ? `<p class="status ${credentialStatus.success ? "ok" : "warning"}" role="status" aria-live="polite">${escapeHtml(credentialStatus.message)}${credentialStatus.status ? ` · HTTP ${credentialStatus.status}` : ""}</p>` : ""}
    </section>` : "";
    return `<article class="wizard-task">
      <div class="wizard-task-head"><strong>${escapeHtml(task.title)}</strong>${status}</div>
      ${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
      ${meta ? `<small>${meta}</small>` : ""}
      ${task.waiting && task.status !== "done" ? '<p class="customer-waiting">This unlocks after an earlier step is finished.</p>' : ""}
      ${blocked && task.status !== "done" ? `<p class="customer-waiting"><strong>Blocked:</strong> ${escapeHtml(task.blocker_reason || "The team is working through a dependency.")}<br>
        <strong>Next update:</strong> ${escapeHtml(task.blocker_next_action || "Your implementation contact will share an update.")}</p>` : ""}
      ${csvUpload}
      ${credentialTest}
      ${action}
    </article>`;
  }
  function tasksView() {
    const list = tasks();
    const index = Math.min(Math.max(store.taskIndex, 0), list.length - 1);
    const task = list[index];
    const dots = list.map((t, i) => `<button type="button" class="wizard-dot ${i === index ? "current" : ""} ${t.status === "done" ? "done" : ""}"
      data-action="goto-task" data-index="${i}" aria-label="Task ${i + 1}: ${escapeHtml(t.title)}${t.status === "done" ? " (complete)" : ""}"
      ${i === index ? 'aria-current="true"' : ""}></button>`).join("");
    return `<h2 id="step-heading" tabindex="-1">Your tasks</h2>
      <p class="muted">Task ${index + 1} of ${list.length}${openTasks().length ? ` · ${openTasks().length} still open` : " · all done"}</p>
      <div class="wizard-dots">${dots}</div>
      ${taskCard(task)}
      ${noticeHtml()}
      <div class="wizard-subnav">
        <button class="button link" type="button" data-action="prev-task" ${index === 0 ? "disabled" : ""}>← Previous task</button>
        <button class="button link" type="button" data-action="next-task" ${index === list.length - 1 ? "disabled" : ""}>Next task →</button>
      </div>
      ${navHtml({ back: true, skip: openTasks().length ? "Do the rest later" : "" })}`;
  }

  function filesView() {
    const files = store.data.files || [];
    const list = files.length ? files.map((file) => `<article class="customer-file">
        ${file.demo ? `<strong>${escapeHtml(file.filename)}</strong>`
          : `<a href="${base}/files/${file.id}">${escapeHtml(file.filename)}</a>`}
        <small>${escapeHtml(file.uploaded_by_name || "Customer team")} · ${formatSize(file.size_bytes)}</small>
      </article>`).join("") : '<p class="muted">No files shared yet. This step is optional.</p>';
    return `<h2 id="step-heading" tabindex="-1">Share a file <span class="field-tag">Optional</span></h2>
      <p class="muted">PDF, PNG, or JPG up to 5 MB each (20 files, 25 MB total). Never upload secrets or passwords.</p>
      <div class="wizard-upload">
        <label for="customer-file-input">Choose a file</label>
        <input id="customer-file-input" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg">
        <button class="button secondary" type="button" data-action="upload">Upload file</button>
        <p class="status ${store.uploadOk ? "ok" : ""}" id="customer-file-status" role="status" aria-live="polite">${escapeHtml(store.fileStatus || "")}</p>
      </div>
      <div class="list-stack">${list}</div>
      ${navHtml({ back: true, skip: files.length ? "" : "Skip" })}`;
  }

  function reviewView() {
    const reqs = requirements();
    const dirty = dirtyRequirements();
    const open = openTasks().length;
    const files = (store.data.files || []).length;
    const answers = reqs.map((req) => {
      const value = valueOf(req).trim();
      const error = validateValue(req, value);
      return `<div class="wizard-answer ${error ? "needs-fix" : ""}">
        <div><dt>${escapeHtml(req.name)}</dt><dd>${value ? escapeHtml(value) : '<em>Not provided</em>'}</dd>
        ${error ? `<small class="field-error">${escapeHtml(error)}</small>` : ""}</div>
        <button class="button link" type="button" data-action="edit-info" data-focus="${req.id}">${error ? "Fix" : "Edit"}</button>
      </div>`;
    }).join("");
    if (!reqs.length) {
      return `<h2 id="step-heading" tabindex="-1">You’re all set</h2>
        <p class="muted">${open ? `You have ${open} open task${open === 1 ? "" : "s"}.` : "Nothing else is needed from you right now."}
          Your implementation team will update this page as work progresses.</p>
        ${open ? '<button class="button secondary" type="button" data-action="goto" data-step="tasks">Review my tasks</button>' : ""}
        ${navHtml({ back: true, next: false })}`;
    }
    if (store.sent && !dirty.length) {
      return `<div class="wizard-done"><div class="wizard-check" aria-hidden="true">✓</div>
        <h2 id="step-heading" tabindex="-1">Thank you — your information is with the team</h2>
        <p class="muted">${open ? `You still have ${open} open task${open === 1 ? "" : "s"}.` : "Nothing else is needed right now."}
          Need to change something? You can edit and send again at any time.</p>
        <div class="wizard-nav-main">
          ${open ? '<button class="button secondary" type="button" data-action="goto" data-step="tasks">Review my tasks</button>' : ""}
          <button class="button secondary" type="button" data-action="edit-info">Edit my answers</button>
        </div></div>`;
    }
    return `<h2 id="step-heading" tabindex="-1">Review &amp; send</h2>
      <p class="muted">Check your answers, then send them to your implementation team.</p>
      <dl class="wizard-answers">${answers}</dl>
      <ul class="wizard-checklist">
        <li>${open ? `${open} task${open === 1 ? "" : "s"} still open (you can finish later)` : "All tasks complete"}</li>
        <li>${files ? `${files} file${files === 1 ? "" : "s"} shared` : "No files shared (optional)"}</li>
      </ul>
      ${navHtml({ back: true, nextLabel: dirty.length || !store.sent ? "Send to my team" : "Send again", nextAction: "submit" })}`;
  }

  const VIEWS = { overview: overviewView, info: infoView, tasks: tasksView, files: filesView, review: reviewView };

  /* ───────────── render ───────────── */
  function render({ focus = true } = {}) {
    const list = stepList();
    if (!list.some((s) => s.id === store.step)) store.step = "overview";
    const index = list.findIndex((s) => s.id === store.step);
    el.steps.innerHTML = list.map((s, i) => {
      const reachable = store.visited.has(s.id) && s.id !== store.step;
      const state = i === index ? "current" : store.visited.has(s.id) && i < index ? "done" : "";
      return `<li class="${state}" ${i === index ? 'aria-current="step"' : ""}>
        ${reachable ? `<button type="button" data-action="goto" data-step="${s.id}">` : "<span>"}
        <b>${i + 1}</b><i>${escapeHtml(s.label)}</i>${reachable ? "</button>" : "</span>"}</li>`;
    }).join("");
    el.barFill.style.width = `${((index + 1) / list.length) * 100}%`;
    el.body.innerHTML = `<div class="wizard-panel" data-step="${store.step}">${VIEWS[store.step]()}</div>`;
    if (focus) document.getElementById("step-heading")?.focus({ preventScroll: false });
  }

  // Updates the message log without touching the wizard or the message textarea.
  function renderMessages() {
    const messages = store.data.messages || [];
    el.conversation.hidden = false;
    el.messageCount.textContent = messages.length ? String(messages.length) : "";
    el.messageCount.hidden = !messages.length;
    el.messages.innerHTML = messages.length ? messages.map((m) => `
      <article class="customer-message ${m.sender_role === "customer" ? "from-customer" : "from-team"}">
        <strong>${escapeHtml(m.sender_name || (m.sender_role === "customer" ? "Customer" : "Implementation team"))}</strong>
        <p>${escapeHtml(m.body)}</p><small>${escapeHtml(new Date(m.created_at).toLocaleString())}</small>
      </article>`).join("") : '<p class="muted">No messages yet. Send your implementation team a question here.</p>';
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function showBanner(message, retry) {
    el.banner.hidden = !message;
    el.banner.innerHTML = message
      ? `<span>${escapeHtml(message)}</span>${retry ? '<button class="button secondary" type="button" data-action="retry-load">Try again</button>' : ""}` : "";
  }

  /* ───────────── 5. controller ───────────── */
  // One action at a time across the whole page. Buttons are disabled in place (no re-render
  // while in flight), so a failed upload keeps the chosen file and a failed save keeps the drafts.
  async function guarded(name, fn, button, busyLabel) {
    if (store.busy.size) return;
    store.busy.add(name);
    showBanner("");
    const controls = [...el.body.querySelectorAll("button, input, select, textarea"),
      ...el.steps.querySelectorAll("button")].filter((control) => !control.disabled);
    const previousDisabled = controls.map((control) => control.disabled);
    const label = button?.textContent;
    controls.forEach((control) => { control.disabled = true; });
    if (button && busyLabel) button.textContent = busyLabel;
    let ok = false;
    try { await fn(); ok = true; }
    catch (error) { showBanner(error.message); }
    finally {
      store.busy.delete(name);
      if (ok) render({ focus: false });
      else {
        controls.forEach((control, index) => {
          if (control.isConnected) control.disabled = previousDisabled[index];
        });
        if (button && label) button.textContent = label;
      }
    }
  }

  // Pulls fresh server data. Drafts are untouched, so nothing the person typed is lost.
  async function refresh() {
    const data = await request(base);
    store.data = data;
    for (const task of data.tasks || []) {
      if (Array.isArray(task.csvSchema) && task.csvSchema.length) {
        store.csvValidated[task.id] = task.csvUploadValidated === true;
      }
      if (task.credentialProvider) {
        store.credentialVerified[task.id] = task.credentialVerified === true;
      }
    }
    return data;
  }
  async function safeRefresh() {
    // The action already succeeded; a failed re-read must not look like the action failed.
    try { await refresh(); renderMessages(); return true; }
    catch { showBanner("Saved, but we couldn’t refresh this page. Reload to see the latest.", false); return false; }
  }

  function go(stepId) {
    store.step = stepId;
    store.visited.add(stepId);
    store.notice = "";
    store.fileStatus = "";
    showBanner("");
    render();
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  function move(delta) {
    const list = stepList();
    const index = list.findIndex((s) => s.id === store.step);
    const target = list[index + delta];
    if (target) go(target.id);
  }

  function validateInfoStep() {
    store.errors = validateAll();
    const firstBad = requirements().find((r) => store.errors[r.id]);
    if (firstBad) {
      render({ focus: false });
      const field = $(`customer-input-${firstBad.id}`);
      field?.focus();
      return false;
    }
    return true;
  }

  const actions = {
    "verify-credential"(target) {
      const id = Number(target.dataset.task);
      const input = $(`customer-credential-${id}`);
      const credential = input?.value || "";
      if (!credential) {
        store.credentialResults[id] = { success: false, message: "Enter the provider API token." };
        render({ focus: false });
        return;
      }
      return guarded(`credential-test-${id}`, async () => {
        try {
          const result = await request(`${base}/tasks/${id}/credentials/test`, {
            method: "POST",
            body: { credential }
          });
          store.credentialResults[id] = result;
          store.credentialVerified[id] = result.success === true;
        } finally {
          input.value = "";
        }
      }, target, "Testing…");
    },

    "map-csv"(target) {
      const id = Number(target.dataset.task);
      const file = store.csvFiles[id];
      if (!file) {
        store.csvResults[id] = { valid: false, message: "Choose a CSV file first." };
        render({ focus: false });
        return;
      }
      if (file.size < 1 || file.size > MAX_FILE_BYTES || !["csv", "xlsx"].includes(extensionOf(file.name))) {
        store.csvResults[id] = { valid: false, message: "Choose a CSV or XLSX file no larger than 5 MB." };
        render({ focus: false });
        return;
      }
      return guarded(`csv-map-${id}`, async () => {
        const result = await uploadTaskCsv(id, file);
        store.csvHeaders[id] = result.headers || [];
        store.csvMappings[id] = result.suggestions || {};
        store.csvValidated[id] = false;
        store.csvResults[id] = {
          valid: false,
          message: `${result.rowCount || 0} rows found. Confirm the column mapping, then validate the file.`,
          errors: result.errors || []
        };
      }, target, "Reading…");
    },

    "validate-csv"(target) {
      const id = Number(target.dataset.task);
      const file = store.csvFiles[id];
      if (!file) {
        store.csvResults[id] = { valid: false, message: "Choose a CSV file first." };
        render({ focus: false });
        return;
      }
      const mapping = store.csvMappings[id] || {};
      return guarded(`csv-validate-${id}`, async () => {
        const result = await uploadTaskCsv(id, file, mapping);
        store.csvValidated[id] = result.valid === true;
        store.csvResults[id] = result.valid
          ? { valid: true, message: `${result.rowCount} rows validated. Your file is ready to upload.` }
          : {
            valid: false,
            message: `${result.errorCount || 0} validation issue${result.errorCount === 1 ? "" : "s"} found. Correct the file and upload it again.`,
            errors: result.errors || []
          };
      }, target, "Validating…");
    },

    next() {
      if (store.step === "info" && !validateInfoStep()) return;
      move(1);
    },
    back() { move(-1); },
    goto(target) { go(target.dataset.step); },
    "edit-info"(target) {
      go("info");
      const id = target?.dataset.focus;
      if (id) $(`customer-input-${id}`)?.focus();
    },
    "retry-load"() { init(); },
    "prev-task"() { store.taskIndex = Math.max(0, store.taskIndex - 1); store.notice = ""; render({ focus: false }); },
    "next-task"() { store.taskIndex = Math.min(tasks().length - 1, store.taskIndex + 1); store.notice = ""; render({ focus: false }); },
    "goto-task"(target) { store.taskIndex = Number(target.dataset.index); store.notice = ""; render({ focus: false }); },

    "approve-change-order"(target) {
      const id = Number(target.dataset.changeOrder);
      const consent = document.querySelector(`[data-change-order-consent="${id}"]`);
      if (!consent?.checked) {
        showBanner("Confirm the scope, fee, and timeline before approving.");
        return;
      }
      return guarded(`change-order-${id}`, async () => {
        await request(`${base}/change-orders/${id}/decision`, {
          method: "POST",
          body: { decision: "approved", consent: true }
        });
        await safeRefresh();
      }, target, "Approving…");
    },

    "reject-change-order"(target) {
      const id = Number(target.dataset.changeOrder);
      return guarded(`change-order-${id}`, async () => {
        await request(`${base}/change-orders/${id}/decision`, {
          method: "POST",
          body: { decision: "rejected", consent: false }
        });
        await safeRefresh();
      }, target, "Rejecting…");
    },

    "complete-task"(target) {
      const id = Number(target.dataset.task);
      return guarded(`task-${id}`, async () => {
        await request(base, { method: "POST", body: { inputs: [], completedStepIds: [id] } });
        const ok = await safeRefresh();
        const next = tasks().findIndex((t) => t.status !== "done");
        store.taskIndex = next === -1 ? store.taskIndex : next;
        store.notice = ok ? (next === -1 ? "All tasks complete. Nice work." : "Marked complete. Here’s the next one.") : "";
      }, target, "Saving…");
    },

    upload() {
      const input = $("customer-file-input");
      const file = input?.files[0];
      const problem = validateFile(file);
      store.uploadOk = false;
      if (problem) { store.fileStatus = problem; render({ focus: false }); return; }
      return guarded("upload", async () => {
        await uploadFile(file);
        store.fileStatus = "File uploaded and shared with your implementation team.";
        store.uploadOk = true;
        input.value = "";
        await safeRefresh();
      }, document.querySelector('[data-action="upload"]'), "Uploading…");
    },

    submit(target) {
      store.errors = validateAll();
      const firstBad = requirements().find((r) => store.errors[r.id]);
      if (firstBad) {
        store.step = "info";
        render({ focus: false });
        $(`customer-input-${firstBad.id}`)?.focus();
        showBanner("A few answers need attention before sending.");
        return;
      }
      const inputs = requirements().map((r) => ({ requirementId: r.id, value: valueOf(r).trim() }));
      return guarded("submit", async () => {
        await request(base, { method: "POST", body: { inputs } });
        // Apply what was sent locally first, so the review stays correct even if the re-read fails.
        for (const input of inputs) {
          const req = requirements().find((r) => r.id === input.requirementId);
          if (req) req.value = input.value;
        }
        store.drafts = {};
        saveDrafts();
        store.sent = true;
        await safeRefresh();
      }, target, "Sending…");
    }
  };

  el.body.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    actions[target.dataset.action]?.(target);
  });
  // Drafts are written on every keystroke; no re-render, so focus and cursor are never disturbed.
  el.body.addEventListener("input", (event) => {
    const field = event.target.closest("[data-requirement]");
    if (!field) return;
    store.drafts[field.dataset.requirement] = field.value;
    saveDrafts();
    if (store.errors[field.dataset.requirement]) {
      const req = requirements().find((r) => String(r.id) === field.dataset.requirement);
      const message = validateValue(req, field.value);
      if (!message) {
        delete store.errors[req.id];
        field.setAttribute("aria-invalid", "false");
        field.closest(".field").classList.remove("has-error");
        $(`customer-input-${req.id}-error`).textContent = "";
      }
    }
  });
  el.body.addEventListener("change", (event) => {
    const fileInput = event.target.closest("[data-csv-file]");
    if (fileInput) {
      const id = fileInput.dataset.csvFile;
      store.csvFiles[id] = fileInput.files?.[0] || null;
      delete store.csvHeaders[id];
      delete store.csvMappings[id];
      delete store.csvResults[id];
      delete store.csvValidated[id];
      render({ focus: false });
      return;
    }
    const mappingInput = event.target.closest("[data-csv-mapping]");
    if (mappingInput) {
      const taskId = mappingInput.dataset.csvMapping;
      store.csvMappings[taskId] ||= {};
      store.csvMappings[taskId][mappingInput.dataset.csvColumn] = mappingInput.value;
      store.csvValidated[taskId] = false;
      delete store.csvResults[taskId];
    }
  });
  // Inline validation when leaving a field. Empty fields are not scolded on tab-through;
  // required-ness is enforced when the person presses Continue.
  el.body.addEventListener("focusout", (event) => {
    const field = event.target.closest("[data-requirement]");
    if (!field || !field.value.trim()) return;
    const req = requirements().find((r) => String(r.id) === field.dataset.requirement);
    const message = validateValue(req, field.value);
    if (message) store.errors[req.id] = message; else delete store.errors[req.id];
    field.setAttribute("aria-invalid", message ? "true" : "false");
    field.closest(".field").classList.toggle("has-error", Boolean(message));
    $(`customer-input-${req.id}-error`).textContent = message;
  });
  el.steps.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action='goto']");
    if (!target) return;
    const list = stepList();
    const forward = list.findIndex((s) => s.id === target.dataset.step) > list.findIndex((s) => s.id === store.step);
    if (store.step === "info" && forward && !validateInfoStep()) return;
    go(target.dataset.step);
  });
  el.banner.addEventListener("click", (event) => {
    if (event.target.closest("[data-action='retry-load']")) init();
  });

  window.addEventListener("beforeunload", (event) => {
    if (store.data && dirtyRequirements().length) { event.preventDefault(); event.returnValue = ""; }
  });

  /* messages (static form, independent of the wizard) */
  $("customer-message-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const statusEl = $("customer-message-status");
    const button = event.currentTarget.querySelector("button[type=submit]");
    const textarea = $("customer-message");
    const body = textarea.value.trim();
    if (!body) { statusEl.textContent = "Enter a message before sending."; return; }
    if (button.disabled) return;
    button.disabled = true;
    statusEl.textContent = "";
    try {
      await request(`${base}/messages`, { method: "POST", body: { body } });
      textarea.value = "";
      statusEl.textContent = "Message sent to your implementation team.";
      await safeRefresh();
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  /* expired / invalid link recovery */
  $("customer-access-recovery-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const statusEl = $("customer-access-recovery-status");
    const button = event.currentTarget.querySelector("button[type=submit]");
    const email = $("customer-recovery-email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { statusEl.textContent = "Enter the email address that received your invitation."; return; }
    button.disabled = true;
    statusEl.textContent = "";
    try {
      const result = await request(`${base}/renew`, { method: "POST", body: { email } });
      statusEl.textContent = result.message;
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  /* boot */
  async function init() {
    el.loading.hidden = false;
    el.loading.classList.remove("error");
    el.loading.textContent = "Loading your secure request…";
    try {
      if (!TOKEN_OK) throw new Error("This customer link is missing or invalid.");
      await refresh();
      el.title.textContent = store.data.customerName ? `Setup for ${store.data.customerName}` : "Help us get your implementation ready.";
      store.sent = requirements().some((requirement) => String(requirement.value || "").trim());
      // Drop drafts for requirements that no longer exist or already match the server.
      const ids = new Set(requirements().map((r) => String(r.id)));
      for (const key of Object.keys(store.drafts)) if (!ids.has(key)) delete store.drafts[key];
      saveDrafts();
      store.taskIndex = Math.max(0, tasks().findIndex((t) => t.status !== "done"));
      el.loading.hidden = true;
      el.wizard.hidden = false;
      showBanner("");
      render({ focus: false });
      renderMessages();
    } catch (error) {
      el.loading.textContent = error.message;
      el.loading.classList.add("error");
      el.recovery.hidden = !/^[A-Za-z0-9_-]{40,60}$/.test(token);
      if (error.offline && store.data) showBanner(error.message, true);
    }
  }
  init();
})();
