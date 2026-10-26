"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

async function main() {
  const destinationArgument = process.argv[2];
  if (!destinationArgument) {
    throw new Error("Usage: npm run backup -- <backup-file-path>");
  }

  const sourcePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, "..", "relay.db"));
  const destinationPath = path.resolve(destinationArgument);
  if (sourcePath === destinationPath) {
    throw new Error("Backup destination must not be the active database file.");
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(`Backup destination already exists: ${destinationPath}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let createdDestination = false;
  try {
    createdDestination = true;
    await database.backup(destinationPath);
    const backup = new Database(destinationPath, { readonly: true, fileMustExist: true });
    try {
      const result = backup.pragma("integrity_check");
      if (result.length !== 1 || result[0].integrity_check !== "ok") {
        throw new Error("SQLite integrity check failed for the completed backup.");
      }
    } finally {
      backup.close();
    }
    fs.chmodSync(destinationPath, 0o600);
    console.info(`Verified SQLite backup created: ${destinationPath}`);
  } catch (error) {
    if (createdDestination && fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);
    throw error;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
