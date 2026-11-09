"use strict";

if (process.env.RELAY_CLOUDFLARE_WORKER !== "1") {
  require("dotenv").config();
}

const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { Client, Pool, types } = require("pg");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL is required. Configure a PostgreSQL connection string before starting Relay.");
}

const connectionUrl = new URL(connectionString);
const usesSupabase = /supabase\.(co|com)$/i.test(connectionUrl.hostname);
const sslMode = connectionUrl.searchParams.get("sslmode")?.toLowerCase() || (usesSupabase ? "require" : undefined);
const requiresTls = usesSupabase || ["require", "verify-ca", "verify-full"].includes(sslMode);
const poolConnectionUrl = new URL(connectionString);
if (usesSupabase) {
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "uselibpqcompat"]) {
    poolConnectionUrl.searchParams.delete(parameter);
  }
}
const clientOptions = {
  connectionString: poolConnectionUrl.toString(),
  connectionTimeoutMillis: 10_000,
  ...(requiresTls ? { ssl: { rejectUnauthorized: sslMode !== "require" } } : {})
};
const isCloudflareWorker = process.env.RELAY_CLOUDFLARE_WORKER === "1";
const poolOptions = { ...clientOptions, max: 3, idleTimeoutMillis: 10_000 };
const pool = isCloudflareWorker ? null : new Pool(poolOptions);
const transactionContext = new AsyncLocalStorage();

types.setTypeParser(20, (value) => Number(value));

async function withClient(callback) {
  const activeClient = transactionContext.getStore();
  if (activeClient) return callback(activeClient);
  if (!isCloudflareWorker) return callback(pool);

  const client = new Client(clientOptions);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function runTransaction(client, callback) {
  await client.query("BEGIN");
  try {
    const result = await transactionContext.run(client, callback);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function prepared(sql) {
  return {
    async get(...values) {
      const result = await query(sql, values);
      return result.rows[0];
    },
    async all(...values) {
      const result = await query(sql, values);
      return result.rows;
    },
    async run(...values) {
      const result = await query(sql, values);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0]?.id
      };
    }
  };
}

async function query(sql, values = []) {
  await ready;
  return withClient((client) => client.query(sql, values));
}

async function transaction(callback) {
  await ready;
  if (isCloudflareWorker) {
    return withClient((client) => runTransaction(client, callback));
  }
  const client = await pool.connect();
  try {
    return await runTransaction(client, callback);
  } finally {
    client.release();
  }
}

async function initialize() {
  const client = isCloudflareWorker ? new Client(clientOptions) : await pool.connect();
  try {
    if (isCloudflareWorker) await client.connect();
    const bundledMigrations = globalThis.__RELAY_MIGRATIONS__;
    const migrations = bundledMigrations
      ? Object.keys(bundledMigrations).sort()
      : fs.readdirSync(path.join(__dirname, "migrations"))
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .sort();
    for (const migrationName of migrations) {
      const version = Number.parseInt(migrationName, 10);
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(707082001)");
        await client.query(`
          CREATE TABLE IF NOT EXISTS relay_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        const applied = await client.query(
          "SELECT 1 FROM relay_schema_migrations WHERE version = $1",
          [version]
        );
        if (applied.rowCount === 0) {
          const migration = bundledMigrations
            ? bundledMigrations[migrationName]
            : fs.readFileSync(path.join(__dirname, "migrations", migrationName), "utf8");
          await client.query(migration);
          await client.query("INSERT INTO relay_schema_migrations (version) VALUES ($1)", [version]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } catch (error) {
    throw error;
  } finally {
    if (isCloudflareWorker) await client.end();
    else client.release();
  }
}

const ready = initialize();
ready.catch((error) => {
  console.error(JSON.stringify({ event: "database_initialization_failed", message: error.message }));
});

module.exports = {
  pool,
  ready,
  database: {
    prepare: prepared,
    transaction,
    query,
    withRequestClient(callback) {
      if (!isCloudflareWorker) return callback();
      return withClient((client) => transactionContext.run(client, callback));
    },
    async close() {
      if (pool) await pool.end();
    }
  },
  async createInquiry({ name, company, email, phone, message, inquiryType }) {
    await ready;
    const result = await query(`
      INSERT INTO inquiries (name, company, email, phone, message, inquiry_type)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, company, email, phone, status, message, inquiry_type, created_at
    `, [name, company || null, email || null, phone, message, inquiryType]);
    return result.rows[0];
  },
  async getInquiries() {
    await ready;
    const result = await query(`
      SELECT id, name, company, email, phone, status, message, inquiry_type, created_at
      FROM inquiries
      ORDER BY created_at DESC, id DESC
    `);
    return result.rows;
  },
  async close() {
    if (pool) await pool.end();
  }
};
