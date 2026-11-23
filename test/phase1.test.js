"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { criticalPathTaskIds, overdueCriticalClientTaskIds } = require("../implementation-scheduling");

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
