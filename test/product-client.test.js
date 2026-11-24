"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const productScript = readFileSync(path.join(__dirname, "..", "public", "product.js"), "utf8");
const loadWorkspaceSource = productScript.match(/async function loadWorkspace\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(loadWorkspaceSource, "product.js should define loadWorkspace");
const showProcessWorkspaceSource = productScript.match(/async function showProcessWorkspace\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(showProcessWorkspaceSource, "product.js should define showProcessWorkspace");
const removeDeletedProcessSource = productScript.match(/function removeDeletedProcess\(processId\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(removeDeletedProcessSource, "product.js should define removeDeletedProcess");

function createWorkspaceLoader() {
  const requests = [];
  const rendered = [];
  const state = { data: { version: "initial", processes: [] }, selectedProcessId: null };
  const dirtyScopes = new Set();
  const deletedProcessIds = new Set();
  const document = { getElementById: () => ({ textContent: "" }) };
  const context = {
    URLSearchParams,
    document,
    deletedProcessIds,
    dirtyScopes,
    confirmDiscardChanges: () => dirtyScopes.size === 0,
    clearSelectedProcess: () => {},
    api: () => new Promise((resolve) => requests.push(resolve)),
    renderWorkspace: () => rendered.push(state.data),
    setView: () => {},
    state,
    window: { location: { search: "" }, history: { replaceState: () => {} } }
  };
  runInNewContext(`let workspaceLoadRequestId = 0;\n${loadWorkspaceSource}; globalThis.loadWorkspace = loadWorkspace;`, context);
  return { deletedProcessIds, dirtyScopes, loadWorkspace: context.loadWorkspace, rendered, requests, state };
}

test("a late workspace refresh cannot overwrite newer data", async () => {
  const loader = createWorkspaceLoader();
  const olderRefresh = loader.loadWorkspace();
  const newerRefresh = loader.loadWorkspace();
  const newestData = { version: "newest", processes: [] };

  loader.requests[1](newestData);
  await newerRefresh;
  loader.requests[0]({ version: "stale", processes: [] });
  await olderRefresh;

  assert.equal(loader.state.data, newestData);
  assert.deepEqual(loader.rendered, [newestData]);
});

test("a workspace refresh does not overwrite edits made while it was loading", async () => {
  const loader = createWorkspaceLoader();
  const originalData = loader.state.data;
  const pendingRefresh = loader.loadWorkspace();
  loader.dirtyScopes.add("process-step");

  loader.requests[0]({ version: "remote", processes: [] });
  assert.equal(await pendingRefresh, false);

  assert.equal(loader.state.data, originalData);
  assert.deepEqual(loader.rendered, []);
});

test("the process workspace refreshes its map list before opening it", async () => {
  const events = [];
  const state = {
    data: { processes: [{ id: 7 }] },
    selectedProcessId: 7,
    process: null
  };
  const context = {
    state,
    loadWorkspace: async () => {
      events.push("refresh");
      state.data.processes = [];
      state.selectedProcessId = null;
      return true;
    },
    setView: (name) => {
      events.push(`view:${name}`);
      return true;
    },
    focusProcessCreation: () => events.push("focus-create"),
    loadProcess: async (id) => events.push(`load:${id}`)
  };
  runInNewContext(
    `${showProcessWorkspaceSource}; globalThis.showProcessWorkspace = showProcessWorkspace;`,
    context
  );

  assert.equal(await context.showProcessWorkspace(), true);
  assert.deepEqual(events, ["refresh", "view:processes", "focus-create"]);
});

test("reopening the process workspace reloads the selected map details", async () => {
  const events = [];
  const process = { id: 7 };
  const context = {
    state: {
      data: { processes: [process] },
      selectedProcessId: 7,
      process
    },
    loadWorkspace: async () => {
      events.push("refresh");
      return true;
    },
    setView: (name) => {
      events.push(`view:${name}`);
      return true;
    },
    focusProcessCreation: () => events.push("focus-create"),
    loadProcess: async (id) => events.push(`load:${id}`)
  };
  runInNewContext(
    `${showProcessWorkspaceSource}; globalThis.showProcessWorkspace = showProcessWorkspace;`,
    context
  );

  assert.equal(await context.showProcessWorkspace(), true);
  assert.deepEqual(events, ["refresh", "view:processes", "load:7"]);
});

test("a successful process deletion removes it even if later workspace data is stale", () => {
  const state = {
    data: { processes: [{ id: 7 }, { id: 8 }] },
    selectedProcessId: 7,
    process: { id: 7 },
    editingStepId: 3
  };
  const deletedProcessIds = new Set();
  const rendered = [];
  const context = {
    state,
    deletedProcessIds,
    clearSelectedProcess: () => {
      state.selectedProcessId = null;
      state.process = null;
      state.editingStepId = null;
    },
    renderProcesses: () => rendered.push(state.data.processes.map((process) => process.id))
  };
  runInNewContext(
    `${removeDeletedProcessSource}; globalThis.removeDeletedProcess = removeDeletedProcess;`,
    context
  );

  context.removeDeletedProcess(7);

  assert.deepEqual(state.data.processes.map((process) => process.id), [8]);
  assert.equal(state.selectedProcessId, null);
  assert.equal(state.process, null);
  assert.equal(deletedProcessIds.has(7), true);
  assert.deepEqual(rendered, [[8]]);
});

test("a stale workspace response cannot restore a process deleted in this session", async () => {
  const loader = createWorkspaceLoader();
  loader.deletedProcessIds.add(7);
  const refresh = loader.loadWorkspace();
  loader.requests[0]({ version: "stale", processes: [{ id: 7 }, { id: 8 }] });

  assert.equal(await refresh, true);
  assert.deepEqual(loader.state.data.processes, [{ id: 8 }]);
});
