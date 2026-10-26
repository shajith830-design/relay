"use strict";

const token = new URLSearchParams(window.location.search).get("token") || "";
const form = document.getElementById("customer-form");
const status = document.getElementById("customer-status");
const loading = document.getElementById("customer-loading");
let requirements = [];

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
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error("This customer link is missing or invalid.");
  const data = await request(`/api/product/customer/${encodeURIComponent(token)}`);
  requirements = data.requirements;
  document.getElementById("customer-title").textContent = `Setup information for ${data.customerName}`;
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
  window.relayRefreshMotion?.();
  loading.hidden = true;
  form.hidden = false;
}

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
