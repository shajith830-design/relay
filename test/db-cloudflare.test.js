"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

test("Cloudflare database clients are scoped to one request and closed afterward", () => {
  const script = String.raw`
    const assert = require("node:assert/strict");
    const Module = require("node:module");
    const originalLoad = Module._load;
    const state = { clients: [], poolCreated: false };

    class Client {
      constructor() {
        this.id = state.clients.length + 1;
        this.connected = false;
        this.queries = [];
        this.endCalls = 0;
        state.clients.push(this);
      }

      async connect() {
        this.connected = true;
      }

      async query(sql) {
        assert.equal(this.connected, true);
        await new Promise((resolve) => setTimeout(resolve, 5));
        this.queries.push(sql);
        return { rows: [{ clientId: this.id }], rowCount: 1 };
      }

      async end() {
        this.endCalls += 1;
        this.connected = false;
      }
    }

    class Pool {
      constructor() {
        state.poolCreated = true;
        throw new Error("Cloudflare Workers must use request-scoped clients.");
      }
    }

    Module._load = function(request, parent, isMain) {
      if (request === "pg") return { Client, Pool, types: { setTypeParser() {} } };
      return originalLoad.call(this, request, parent, isMain);
    };

    process.env.DATABASE_URL = "postgresql://test:test@hyperdrive.example.test:5432/postgres";
    process.env.RELAY_CLOUDFLARE_WORKER = "1";
    globalThis.__RELAY_MIGRATIONS__ = {};

    async function main() {
      const db = require("./db");
      await db.ready;
      assert.equal(state.poolCreated, false);

      const results = await Promise.all([
        db.database.withRequestClient(async () => {
          const first = await db.database.prepare("SELECT first").get();
          const transaction = await db.database.transaction(() =>
            db.database.prepare("SELECT transaction").get()
          );
          return { first, transaction };
        }),
        db.database.withRequestClient(() => db.database.prepare("SELECT concurrent").get())
      ]);

      assert.notEqual(results[0].first.clientId, results[1].clientId);
      assert.equal(results[0].first.clientId, results[0].transaction.clientId);
      assert.deepEqual(state.clients.map((client) => client.endCalls), [1, 1, 1]);
      assert.deepEqual(state.clients[1].queries, ["SELECT first", "BEGIN", "SELECT transaction", "COMMIT"]);
      assert.deepEqual(state.clients[2].queries, ["SELECT concurrent"]);

      await assert.rejects(
        db.database.withRequestClient(() => Promise.reject(new Error("route failed"))),
        /route failed/
      );
      assert.equal(state.clients[3].endCalls, 1);
      assert.equal(state.clients[3].connected, false);
    }

    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
