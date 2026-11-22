"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const publicDir = path.join(__dirname, "..", "public");
const productHtml = readFileSync(path.join(publicDir, "product.html"), "utf8");
const productJs = readFileSync(path.join(publicDir, "product.js"), "utf8");

test("Relay has an in-product guide with working navigation to its main workflows", () => {
  assert.match(productHtml, /data-view="guide"[^>]*>[\s\S]*?How to use Relay/);
  assert.match(productHtml, /id="view-guide"[\s\S]*?id="guide-process-title"/);
  assert.match(productHtml, /id="guide-template-title"/);
  assert.match(productHtml, /id="guide-launch-title"/);
  assert.match(productHtml, /id="guide-info-title"/);
  assert.match(productHtml, /id="guide-delivery-title"/);
  assert.match(productHtml, /id="guide-monitor-title"/);
  assert.match(productHtml, /id="guide-connect-title"/);
  assert.match(productHtml, /id="guide-help-title"/);
  assert.match(productHtml, /data-go="processes"/);
  assert.match(productHtml, /data-go="templates"/);
  assert.match(productHtml, /data-go="implementations"/);
  assert.match(productHtml, /data-go="requirements"/);
  assert.match(productHtml, /data-go="portfolio"/);
  assert.match(productHtml, /data-go="settings"/);
  assert.match(productJs, /guide:\s*\["Learn Relay",\s*"How to use Relay"\]/);
  assert.match(productHtml, /does not generate invoices, collect payments/);
  assert.match(productHtml, /fictional example data/);
  assert.match(productHtml, /Never ask customers to submit passwords/);
});
