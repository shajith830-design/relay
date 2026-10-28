"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Database = require("better-sqlite3");

const defaultDatabasePath = process.env.VERCEL === "1"
  ? path.join(os.tmpdir(), "relay.db")
  : path.join(__dirname, "relay.db");
const databasePath = path.resolve(process.env.DATABASE_PATH || defaultDatabasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new Database(databasePath);

database.pragma("foreign_keys = ON");
database.pragma("journal_mode = WAL");
database.pragma("busy_timeout = 5000");
const hasLegacyLeadsTable = database.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'leads'"
).get();
if (hasLegacyLeadsTable) {
  database.pragma("secure_delete = ON");
  database.exec("DROP TABLE leads; VACUUM");
  database.pragma("wal_checkpoint(TRUNCATE)");
}

database.exec(`
  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS product_workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_memberships (
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES product_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
    PRIMARY KEY (workspace_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS product_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES product_users(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS product_sessions_expiry_idx ON product_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS product_password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES product_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS product_password_resets_expiry_idx ON product_password_resets(expires_at);

  CREATE TABLE IF NOT EXISTS product_help_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES product_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS product_help_messages_user_idx
    ON product_help_messages(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS product_help_consents (
    user_id INTEGER PRIMARY KEY REFERENCES product_users(id) ON DELETE CASCADE,
    accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_user_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES product_users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
    accent TEXT NOT NULL DEFAULT 'blue' CHECK (accent IN ('blue', 'teal', 'violet', 'rose')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_user_onboarding (
    user_id INTEGER PRIMARY KEY REFERENCES product_users(id) ON DELETE CASCADE,
    dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_workspace_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    invited_email TEXT NOT NULL COLLATE NOCASE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_by INTEGER NOT NULL REFERENCES product_users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS product_workspace_invites_workspace_idx ON product_workspace_invites(workspace_id, expires_at);

  CREATE TABLE IF NOT EXISTS product_processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_process_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    process_id INTEGER NOT NULL REFERENCES product_processes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS product_process_steps_position_idx ON product_process_steps(process_id, position);

  CREATE TABLE IF NOT EXISTS product_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    process_id INTEGER NOT NULL REFERENCES product_processes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    steps_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_implementations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES product_templates(id) ON DELETE RESTRICT,
    customer_name TEXT NOT NULL,
    portal_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS product_implementations_workspace_idx ON product_implementations(workspace_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS product_implementation_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    implementation_id INTEGER NOT NULL REFERENCES product_implementations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'done')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS product_implementation_steps_position_idx ON product_implementation_steps(implementation_id, position);

  CREATE TABLE IF NOT EXISTS product_requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_customer_inputs (
    implementation_id INTEGER NOT NULL REFERENCES product_implementations(id) ON DELETE CASCADE,
    requirement_id INTEGER NOT NULL REFERENCES product_requirements(id) ON DELETE CASCADE,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (implementation_id, requirement_id)
  );

  CREATE TABLE IF NOT EXISTS product_setup_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES product_workspaces(id) ON DELETE CASCADE,
    process_id INTEGER NOT NULL REFERENCES product_processes(id) ON DELETE CASCADE,
    process_revision INTEGER NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('ready', 'needs_attention')),
    findings_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function addColumnIfMissing(table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("product_process_steps", "stage", "TEXT NOT NULL DEFAULT 'Implementation'");
addColumnIfMissing("product_process_steps", "due_offset_days", "INTEGER NOT NULL DEFAULT 0 CHECK (due_offset_days >= 0)");
addColumnIfMissing("product_process_steps", "assignee_user_id", "INTEGER REFERENCES product_users(id)");
addColumnIfMissing("product_templates", "updated_at", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("product_templates", "revision", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("product_requirements", "template_id", "INTEGER REFERENCES product_templates(id) ON DELETE CASCADE");
addColumnIfMissing("product_requirements", "input_type", "TEXT NOT NULL DEFAULT 'text'");
addColumnIfMissing("product_implementation_steps", "due_at", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("product_implementation_steps", "stage", "TEXT NOT NULL DEFAULT 'Implementation'");
addColumnIfMissing("product_implementation_steps", "assignee_user_id", "INTEGER REFERENCES product_users(id)");
addColumnIfMissing("product_implementation_steps", "is_blocked", "INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1))");
addColumnIfMissing("product_implementation_steps", "blocker_reason", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("product_implementation_steps", "blocker_next_action", "TEXT NOT NULL DEFAULT ''");
database.exec("CREATE INDEX IF NOT EXISTS product_implementation_steps_assignee_idx ON product_implementation_steps(assignee_user_id)");

database.exec(`
  CREATE TABLE IF NOT EXISTS product_process_step_dependencies (
    process_step_id INTEGER NOT NULL REFERENCES product_process_steps(id) ON DELETE CASCADE,
    depends_on_step_id INTEGER NOT NULL REFERENCES product_process_steps(id) ON DELETE CASCADE,
    PRIMARY KEY (process_step_id, depends_on_step_id),
    CHECK (process_step_id != depends_on_step_id)
  );

  CREATE TABLE IF NOT EXISTS product_implementation_step_dependencies (
    implementation_step_id INTEGER NOT NULL REFERENCES product_implementation_steps(id) ON DELETE CASCADE,
    depends_on_step_id INTEGER NOT NULL REFERENCES product_implementation_steps(id) ON DELETE CASCADE,
    PRIMARY KEY (implementation_step_id, depends_on_step_id),
    CHECK (implementation_step_id != depends_on_step_id)
  );

  CREATE INDEX IF NOT EXISTS product_requirements_template_idx ON product_requirements(template_id, workspace_id);
  CREATE INDEX IF NOT EXISTS product_implementation_steps_due_idx ON product_implementation_steps(due_at);

  CREATE TABLE IF NOT EXISTS product_template_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES product_templates(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    name TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (template_id, revision)
  );

  INSERT OR IGNORE INTO product_template_versions (template_id, revision, name, steps_json, created_at)
  SELECT id, revision, name, steps_json, created_at FROM product_templates;
`);

const createInquiryStatement = database.prepare(`
  INSERT INTO inquiries (name, phone, message)
  VALUES (@name, @phone, @message)
  RETURNING id, name, phone, status, message, created_at
`);

const getInquiriesStatement = database.prepare(`
  SELECT id, name, phone, status, message, created_at
  FROM inquiries
  ORDER BY created_at DESC, id DESC
`);

module.exports = {
  databasePath,
  database,
  createInquiry({ name, phone, message }) {
    return createInquiryStatement.get({ name, phone, message });
  },
  getInquiries() {
    return getInquiriesStatement.all();
  },
  close() {
    database.close();
  }
};
