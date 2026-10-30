"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const databaseUrl = process.env.DATABASE_URL?.trim();
const destinationArgument = process.argv[2];
if (!databaseUrl || !destinationArgument) {
  console.error("Usage: DATABASE_URL=<postgres-url> npm run backup -- <backup-file-path>");
  process.exit(1);
}

const destination = path.resolve(destinationArgument);
if (fs.existsSync(destination)) {
  console.error(`Backup destination already exists: ${destination}`);
  process.exit(1);
}

let connection;
try {
  connection = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(connection.protocol)) throw new Error();
} catch {
  console.error("DATABASE_URL must be a PostgreSQL connection URL.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
const supabaseHost = /supabase\.(co|com)$/i.test(connection.hostname);
const sslMode = connection.searchParams.get("sslmode") || (supabaseHost ? "verify-full" : "");
const result = spawnSync("pg_dump", [
  "--format=custom",
  "--no-owner",
  "--no-acl",
  "--file",
  destination
], {
  env: {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
    ...(sslMode ? { PGSSLMODE: sslMode } : {})
  },
  stdio: "inherit"
});

if (result.error || result.status !== 0) {
  if (fs.existsSync(destination)) fs.unlinkSync(destination);
  console.error(result.error?.message || `pg_dump failed with exit code ${result.status}.`);
  process.exit(result.status || 1);
}

fs.chmodSync(destination, 0o600);
console.info(`PostgreSQL backup created: ${destination}`);
