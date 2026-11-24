"use strict";

const db = require("../db");
const { makePasswordHash } = require("../product-auth");
const { getPlanDetails } = require("../product-plans");
const { createStarterTemplates } = require("../product-starter-templates");

async function seedSmokeWorkspace() {
  await db.ready;
  const email = "smoke@example.test";
  const password = "ci-smoke-password-long";
  const plan = getPlanDetails("starter");
  const passwordHash = await makePasswordHash(password);

  await db.database.transaction(async () => {
    const user = await db.database.prepare(
      "INSERT INTO product_users (email, password_hash) VALUES ($1, $2) RETURNING id"
    ).get(email, passwordHash);
    const workspace = await db.database.prepare(
      "INSERT INTO product_workspaces (name) VALUES ($1) RETURNING id"
    ).get("CI smoke workspace");
    await db.database.prepare(
      "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')"
    ).run(workspace.id, user.id);
    await db.database.prepare(`
      INSERT INTO product_workspace_subscriptions
        (workspace_id, activated_at, expires_at, plan, member_limit, active_implementation_limit, template_limit)
      VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 month', $2, $3, $4, $5)
    `).run(
      workspace.id,
      plan.code,
      plan.memberLimit,
      plan.activeImplementationLimit,
      plan.templateLimit
    );
    await createStarterTemplates(db.database, workspace.id, user.id, plan);
  });
}

seedSmokeWorkspace()
  .catch((error) => {
    console.error(`CI smoke workspace setup failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
