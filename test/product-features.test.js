"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const installProductRoutes = require("../product-routes");

test("P1 product endpoints are registered as top-level routes", () => {
  const registered = [];
  const app = {};
  for (const method of ["get", "post", "put", "patch", "delete", "use"]) {
    app[method] = (route) => registered.push({ method, route });
  }
  installProductRoutes(app, { database: { prepare: () => { throw new Error("Database should not be queried while installing routes."); } } }, false);

  for (const [method, route] of [
    ["patch", "/api/product/notifications"],
    ["post", "/api/product/integrations/:provider/connect"],
    ["put", "/api/product/integrations/slack"],
    ["post", "/api/product/integrations/slack/test"],
    ["put", "/api/product/integrations/jira"],
    ["put", "/api/product/integrations/linear"],
    ["get", "/api/product/integrations/salesforce/catalog"],
    ["put", "/api/product/integrations/salesforce/sku-mappings"],
    ["post", "/api/product/implementations/:implementationId/tasks/:taskId/escalate"],
    ["get", "/api/product/integrations/callback/:provider"],
    ["delete", "/api/product/integrations/:provider"],
    ["post", "/api/product/internal/process-events"],
    ["get", "/api/product/notification-delivery"],
    ["post", "/api/product/notification-delivery/:eventId/retry"],
    ["get", "/api/product/portfolio.csv"],
    ["get", "/api/product/customer/:token"],
    ["post", "/api/product/customer/:token/tasks/:stepId/csv"],
    ["post", "/api/product/customer/:token"]
  ]) {
    assert.ok(registered.some((entry) => entry.method === method && entry.route === route), `${method.toUpperCase()} ${route} should be registered`);
  }
});
