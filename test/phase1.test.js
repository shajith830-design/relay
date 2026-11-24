"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { criticalPathTaskIds, overdueCriticalClientTaskIds } = require("../implementation-scheduling");
const { stagesRequiringApprovalBeforeMove } = require("../stage-gates");

test("critical path identifies the longest unfinished path and overdue client tasks", () => {
  const tasks = [
    { id: 1, status: "done", due_at: "2026-11-01", responsible_party: "client", estimated_duration_days: 1 },
    { id: 2, status: "in_progress", due_at: "2026-11-20", responsible_party: "client", estimated_duration_days: 3 },
    { id: 3, status: "not_started", due_at: "2026-11-25", responsible_party: "relay", estimated_duration_days: 2 },
    { id: 4, status: "not_started", due_at: "2026-11-20", responsible_party: "client", estimated_duration_days: 4 }
  ];
  const dependencies = [
    { implementation_step_id: 2, depends_on_step_id: 1 },
    { implementation_step_id: 3, depends_on_step_id: 2 },
    { implementation_step_id: 4, depends_on_step_id: 2 }
  ];
  const critical = criticalPathTaskIds(tasks, dependencies);
  assert.deepEqual([...critical].sort((a, b) => a - b), [2, 4]);
  assert.deepEqual(
    [...overdueCriticalClientTaskIds(tasks, dependencies, "2026-11-23")].sort((a, b) => a - b),
    [2, 4]
  );
});

test("Phase 1 migration adds scoped delegation, change orders, shift ledger, and audit retention", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "013_phase1_critical_path_change_orders_delegation.sql"), "utf8");
  assert.match(migration, /product_change_orders/);
  assert.match(migration, /product_customer_task_delegations/);
  assert.match(migration, /product_implementation_go_live_shifts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS audit_logs/);
  assert.match(migration, /prevent_audit_log_mutation/);
  assert.match(migration, /pending_client/);
});

test("rejected change orders release their linked tasks", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "product-routes.js"), "utf8");
  assert.doesNotMatch(routes, /co\.status IN \('pending_client', 'rejected'\)/);
  assert.match(routes, /co\.status = 'pending_client'/);
});

test("stage gates require approvals only for stages being passed", () => {
  assert.deepEqual(stagesRequiringApprovalBeforeMove("kickoff", "configuration"), ["kickoff"]);
  assert.deepEqual(stagesRequiringApprovalBeforeMove("testing", "launch"), ["testing"]);
  assert.deepEqual(stagesRequiringApprovalBeforeMove("kickoff", "complete"),
    ["kickoff", "configuration", "testing", "launch", "hypercare"]);
  assert.deepEqual(stagesRequiringApprovalBeforeMove("launch", "testing"), []);
  assert.equal(stagesRequiringApprovalBeforeMove("unknown", "launch"), null);
});

test("stage-gated approval migration assigns legacy approvals and validates stage values", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "019_stage_gated_approvals.sql"), "utf8");
  assert.match(migration, /SET stage_gate = implementation\.stage_gate_status/);
  assert.match(migration, /stage_gate IN \('kickoff', 'configuration', 'testing', 'launch', 'hypercare', 'complete'\)/);
  assert.match(migration, /product_approval_requests_gate_status_idx/);
});
