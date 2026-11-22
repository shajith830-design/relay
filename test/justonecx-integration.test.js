"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { createJustOneCXIdentity } = require("../justonecx-identity");

const root = path.join(__dirname, "..");
const bootstrapSource = readFileSync(path.join(root, "public", "relay-justonecx.js"), "utf8");

function loadBootstrap(pathname, search = "") {
  const scripts = [];
  const listeners = new Map();
  const window = { location: { pathname, search }, JustOneCX: null };
  const document = {
    createElement: () => ({
      dataset: {},
      addEventListener: (event, listener) => listeners.set(event, listener)
    }),
    head: { append: (script) => scripts.push(script) }
  };
  runInNewContext(bootstrapSource, {
    window,
    document,
    URLSearchParams,
    console: { warn() {} }
  });
  return {
    window,
    scripts,
    fire: (event) => listeners.get(event)?.()
  };
}

test("JustOneCX identity uses server-side HMAC signatures and is disabled without a secret", () => {
  assert.deepEqual(createJustOneCXIdentity("42", "7", "unit-test-secret"), {
    userHash: "fab40985ea5b8b1cde337e82d37ea9bb41f9a5e4913f1271a03c467b40b115f7",
    accountHash: "f1aae3cada14b08e81c67ad1b2a5d3f22bcd8566f119ed809f77c98a2159d433"
  });
  assert.equal(createJustOneCXIdentity("42", "7", "  "), null);
});

test("JustOneCX is excluded from sample previews and configured for Relay production pages", async () => {
  for (const search of ["?demo=workspace", "?demo=ray", "?invite=example-token", "?reset=example-token"]) {
    const preview = loadBootstrap("/product.html", search);
    assert.equal(preview.scripts.length, 0);
    assert.equal(preview.window.RelayJustOneCX, undefined);
  }

  const workspace = loadBootstrap("/product.html");
  assert.equal(workspace.scripts.length, 1);
  assert.equal(workspace.scripts[0].src, "https://app.justonecx.com/sdk/justonecx-sdk.global.js");
  assert.equal(workspace.scripts[0].dataset.publicKey, "pk_DG_Xs99WSKoO2bjcRhQ5IfsHgEXMUehm");
  assert.equal(workspace.scripts[0].dataset.apiUrl, "https://api.justonecx.com");
  assert.equal(workspace.scripts[0].dataset.disableChat, "true");
  assert.match(readFileSync(path.join(root, "public", "product.html"), "utf8"), /id="app-shell"[^>]*data-jcx-private/);

  const calls = [];
  workspace.window.JustOneCX = {
    async identify(...args) { calls.push(["identify", ...args]); },
    async group(...args) { calls.push(["group", ...args]); },
    async init(options) { calls.push(["init", options]); },
    async reset() { calls.push(["reset"]); }
  };
  workspace.fire("load");
  await workspace.window.RelayJustOneCX.identify({
    userId: 42,
    userHash: "user-signature",
    userTraits: { role: "owner", plan: "growth" },
    accountId: 7,
    accountHash: "account-signature",
    accountTraits: { plan: "growth" }
  });
  await workspace.window.RelayJustOneCX.reset();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["identify", "42", { role: "owner", plan: "growth" }, { userHash: "user-signature" }],
    ["group", "7", { plan: "growth" }, { accountHash: "account-signature" }],
    ["init", {
      publicKey: "pk_DG_Xs99WSKoO2bjcRhQ5IfsHgEXMUehm",
      apiUrl: "https://api.justonecx.com",
      disableChat: true
    }],
    ["reset"]
  ]);
});

test("JustOneCX loads on marketing pages but not token-bearing or private admin pages", () => {
  for (const page of [
    "index.html", "about.html", "features-services.html", "pricing.html", "contact.html",
    "demo.html", "founder.html", "privacy.html", "terms.html", "product.html"
  ]) {
    assert.match(readFileSync(path.join(root, "public", page), "utf8"), /relay-justonecx\.js/);
  }
  for (const page of ["customer.html", "dashboard.html", "relay-owner-console.html"]) {
    assert.doesNotMatch(readFileSync(path.join(root, "public", page), "utf8"), /relay-justonecx\.js/);
  }
  assert.match(readFileSync(path.join(root, ".env.example"), "utf8"), /^JUSTONECX_SECRET_KEY=$/m);
  assert.match(readFileSync(path.join(root, "cloudflare-worker.mjs"), "utf8"), /"JUSTONECX_SECRET_KEY"/);
});
