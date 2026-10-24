"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, "relay.db"));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new Database(databasePath);

database.pragma("journal_mode = WAL");
database.pragma("busy_timeout = 5000");
database.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT NOT NULL UNIQUE,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'missed_call',
    issue TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const leadColumns = database.pragma("table_info(leads)");
if (!leadColumns.some((column) => column.name === "name")) {
  database.exec("ALTER TABLE leads ADD COLUMN name TEXT");
}

const createLeadStatement = database.prepare(`
  INSERT INTO leads (customer_phone, name, status, issue, updated_at)
  VALUES (@phone, @name, 'new', @message, CURRENT_TIMESTAMP)
  ON CONFLICT(customer_phone) DO UPDATE SET
    name = excluded.name,
    status = 'new',
    issue = excluded.issue,
    updated_at = CURRENT_TIMESTAMP
  RETURNING id, name, customer_phone, status, issue, updated_at
`);

const getLeadsStatement = database.prepare(`
  SELECT customer_phone, name, status, issue, updated_at
  FROM leads
  ORDER BY updated_at DESC, id DESC
`);

module.exports = {
  databasePath,
  createLead({ name, phone, message }) {
    return createLeadStatement.get({ name, phone, message });
  },
  getLeads() {
    return getLeadsStatement.all();
  },
  close() {
    database.close();
  }
};
