"use strict";

const db = require("../db");

db.ready.then(async () => {
  console.info("Relay PostgreSQL schema is initialized.");
  await db.close();
}).catch(async (error) => {
  console.error(`Relay PostgreSQL schema initialization failed: ${error.message}`);
  await db.close();
  process.exitCode = 1;
});
