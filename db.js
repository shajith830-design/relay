"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool, types } = require("pg");

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL is required. Configure a PostgreSQL connection string before starting Relay.");
}

const connectionUrl = new URL(connectionString);
const usesSupabase = /supabase\.(co|com)$/i.test(connectionUrl.hostname);
const requiresTls = usesSupabase || ["require", "verify-ca", "verify-full"].includes(connectionUrl.searchParams.get("sslmode"));
const poolConnectionUrl = new URL(connectionString);
if (usesSupabase) {
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "uselibpqcompat"]) {
    poolConnectionUrl.searchParams.delete(parameter);
  }
}
const pool = new Pool({
  connectionString: poolConnectionUrl.toString(),
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ...(requiresTls ? { ssl: { rejectUnauthorized: true } } : {})
});
const transactionContext = new AsyncLocalStorage();

types.setTypeParser(20, (value) => Number(value));

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
  const client = transactionContext.getStore() || pool;
  return client.query(sql, values);
}

async function transaction(callback) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await transactionContext.run(client, callback);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function initialize() {
  const client = await pool.connect();
  try {
    const migrations = fs.readdirSync(path.join(__dirname, "migrations"))
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
          const migration = fs.readFileSync(path.join(__dirname, "migrations", migrationName), "utf8");
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
    client.release();
  }
}

const ready = initialize().catch((error) => {
  console.error(JSON.stringify({ event: "database_initialization_failed", message: error.message }));
  throw error;
});

module.exports = {
  pool,
  ready,
  database: {
    prepare: prepared,
    transaction,
    query,
    async close() {
      await pool.end();
    }
  },
  async createInquiry({ name, phone, message }) {
    await ready;
    const result = await query(`
      INSERT INTO inquiries (name, phone, message)
      VALUES ($1, $2, $3)
      RETURNING id, name, phone, status, message, created_at
    `, [name, phone, message]);
    return result.rows[0];
  },
  async getInquiries() {
    await ready;
    const result = await query(`
      SELECT id, name, phone, status, message, created_at
      FROM inquiries
      ORDER BY created_at DESC, id DESC
    `);
    return result.rows;
  },
  async close() {
    await pool.end();
  }
};
