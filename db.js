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
    status TEXT NOT NULL DEFAULT 'missed_call',
    issue TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const upsertMissedCallStatement = database.prepare(`
  INSERT INTO leads (customer_phone, status, issue, updated_at)
  VALUES (@customerPhone, 'missed_call', NULL, CURRENT_TIMESTAMP)
  ON CONFLICT(customer_phone) DO UPDATE SET
    status = 'missed_call',
    issue = NULL,
    updated_at = CURRENT_TIMESTAMP
  RETURNING id, customer_phone, status, issue, updated_at
`);

const markLeadRepliedStatement = database.prepare(`
  UPDATE leads
  SET status = 'replied',
      issue = @issue,
      updated_at = CURRENT_TIMESTAMP
  WHERE customer_phone = @customerPhone
`);

const getLeadsStatement = database.prepare(`
  SELECT customer_phone, status, issue, updated_at
  FROM leads
  ORDER BY updated_at DESC, id DESC
`);

module.exports = {
  databasePath,
  upsertMissedCall(customerPhone) {
    return upsertMissedCallStatement.get({ customerPhone });
  },
  markLeadReplied(customerPhone, issue) {
    return markLeadRepliedStatement.run({ customerPhone, issue });
  },
  getLeads() {
    return getLeadsStatement.all();
  },
  close() {
    database.close();
  }
};
