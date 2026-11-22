"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const productScript = readFileSync(path.join(__dirname, "..", "public", "product.js"), "utf8");
const loadWorkspaceSource = productScript.match(/async function loadWorkspace\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(loadWorkspaceSource, "product.js should define loadWorkspace");

function createWorkspaceLoader() {
  const requests = [];
  const rendered = [];
  const state = { data: { version: "initial" } };
  const dirtyScopes = new Set();
  const document = { getElementById: () => ({ textContent: "" }) };
  const context = {
    URLSearchParams,
    document,
    dirtyScopes,
    confirmDiscardChanges: () => dirtyScopes.size === 0,
    api: () => new Promise((resolve) => requests.push(resolve)),
    renderWorkspace: () => rendered.push(state.data),
    setView: () => {},
    state,
    window: { location: { search: "" }, history: { replaceState: () => {} } }
  };
  runInNewContext(`let workspaceLoadRequestId = 0;\n${loadWorkspaceSource}; globalThis.loadWorkspace = loadWorkspace;`, context);
  return { dirtyScopes, loadWorkspace: context.loadWorkspace, rendered, requests, state };
}

test("a late workspace refresh cannot overwrite newer data", async () => {
  const loader = createWorkspaceLoader();
  const olderRefresh = loader.loadWorkspace();
  const newerRefresh = loader.loadWorkspace();
  const newestData = { version: "newest" };

  loader.requests[1](newestData);
  await newerRefresh;
  loader.requests[0]({ version: "stale" });
  await olderRefresh;

  assert.equal(loader.state.data, newestData);
  assert.deepEqual(loader.rendered, [newestData]);
});

test("a workspace refresh does not overwrite edits made while it was loading", async () => {
  const loader = createWorkspaceLoader();
  const originalData = loader.state.data;
  const pendingRefresh = loader.loadWorkspace();
  loader.dirtyScopes.add("process-step");

  loader.requests[0]({ version: "remote" });
  assert.equal(await pendingRefresh, false);

  assert.equal(loader.state.data, originalData);
  assert.deepEqual(loader.rendered, []);
});
