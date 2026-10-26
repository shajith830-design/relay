"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("database backup produces a restorable SQLite snapshot and refuses overwrite", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-backup-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.db");
  const backupPath = path.join(directory, "backups", "relay-backup.db");
  const database = new Database(sourcePath);
  database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  database.prepare("INSERT INTO records (value) VALUES (?)").run("persisted test value");
  database.pragma("journal_mode = WAL");
  database.close();

  const command = path.join(__dirname, "..", "scripts", "backup-database.js");
  const backup = spawnSync(process.execPath, [command, backupPath], {
    env: { ...process.env, DATABASE_PATH: sourcePath },
    encoding: "utf8"
  });
  assert.equal(backup.status, 0, backup.stderr);
  assert.match(backup.stdout, /Verified SQLite backup created/);

  const restored = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(restored.prepare("SELECT value FROM records WHERE id = 1").get().value, "persisted test value");
  assert.equal(restored.pragma("integrity_check")[0].integrity_check, "ok");
  restored.close();

  const overwrite = spawnSync(process.execPath, [command, backupPath], {
    env: { ...process.env, DATABASE_PATH: sourcePath },
    encoding: "utf8"
  });
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /already exists/);
});
