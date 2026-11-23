"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  canAccessWorkspaceRequest,
  getRoleCapabilities,
  isWorkspaceAdmin
} = require("../product-authorization");

test("legacy workspace roles map to the approved role capabilities", () => {
  assert.deepEqual(getRoleCapabilities("owner"), getRoleCapabilities("admin"));
  assert.deepEqual(getRoleCapabilities("member"), getRoleCapabilities("contributor"));
  assert.equal(isWorkspaceAdmin("owner"), true);
  assert.equal(isWorkspaceAdmin("admin"), true);
  assert.equal(isWorkspaceAdmin("implementation_manager"), false);
  assert.throws(() => getRoleCapabilities("unknown"), /Unknown workspace role/);
});

test("implementation managers can manage project workflows but not workspace administration or rates", () => {
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "POST", "/api/product/implementations"), true);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "POST", "/api/product/implementations/10/change-orders"), true);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "POST", "/api/product/invites"), false);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "POST", "/api/product/team-members/4/rates"), false);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "POST", "/api/product/templates"), false);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "PATCH", "/api/product/implementations/10/budget"), false);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "POST", "/api/product/implementations/10/budget-overrides"), true);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "GET", "/api/product/analytics/portfolio-margins"), true);
  assert.equal(canAccessWorkspaceRequest("implementation_manager", "GET", "/api/product/audit-logs"), false);
});

test("contributors can work tasks, communicate, and log time without financial visibility", () => {
  assert.equal(canAccessWorkspaceRequest("contributor", "PATCH", "/api/product/implementations/10/steps/12"), true);
  assert.equal(canAccessWorkspaceRequest("contributor", "POST", "/api/product/implementations/10/messages"), true);
  assert.equal(canAccessWorkspaceRequest("contributor", "POST", "/api/product/implementations/10/tasks/12/escalate"), true);
  assert.equal(canAccessWorkspaceRequest("contributor", "POST", "/api/product/implementations/10/time-entries"), true);
  assert.equal(canAccessWorkspaceRequest("contributor", "POST", "/api/product/implementations"), false);
  assert.equal(canAccessWorkspaceRequest("contributor", "GET", "/api/product/analytics/portfolio-margins"), false);
  assert.equal(canAccessWorkspaceRequest("contributor", "GET", "/api/product/portfolio.csv"), false);
  assert.equal(canAccessWorkspaceRequest("contributor", "GET", "/api/product/team-members/4/rates"), false);
  assert.equal(canAccessWorkspaceRequest("contributor", "DELETE", "/api/product/time-entries/12"), true);
});

test("executive viewers are limited to read-only portfolio and financial routes", () => {
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "GET", "/api/product/workspace"), true);
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "GET", "/api/product/analytics/portfolio-margins"), true);
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "GET", "/api/product/implementations/10"), false);
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "GET", "/api/product/implementations/10/files/2"), false);
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "GET", "/api/product/portfolio.csv"), false);
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "GET", "/api/product/account-deletion/workspaces"), false);
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "POST", "/api/product/implementations/10/time-entries"), false);
  assert.equal(canAccessWorkspaceRequest("executive_viewer", "PATCH", "/api/product/preferences"), true);
});

test("enterprise role migration converts existing members and stores invitation roles", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "015_enterprise_roles.sql"),
    "utf8"
  );
  assert.match(migration, /SET role = 'contributor'[\s\S]+WHERE role = 'member'/);
  assert.match(migration, /implementation_manager/);
  assert.match(migration, /executive_viewer/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'contributor'/);
});
