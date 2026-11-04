"use strict";

const { randomBytes } = require("node:crypto");
const { stdin, stdout } = require("node:process");
const readline = require("node:readline/promises");
const db = require("../db");
const { makePasswordHash } = require("../product-auth");
const { getPlanDetails, isPlanCode, validateCustomLimits } = require("../product-plans");

async function provisionWorkspace() {
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    const workspaceName = (await prompt.question("Client workspace name: ")).trim();
    const email = (await prompt.question("Workspace owner's email: ")).trim().toLowerCase();
    const planCode = (await prompt.question("Plan (starter, growth, custom): ")).trim().toLowerCase();
    if (!workspaceName || workspaceName.length > 100) {
      throw new Error("Workspace name must be between 1 and 100 characters.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error("Enter a valid owner email address.");
    }
    if (!isPlanCode(planCode)) throw new Error("Choose starter, growth, or custom.");
    const customLimits = {};
    if (planCode === "custom") {
      for (const [key, label] of [
        ["memberLimit", "Team-member limit"],
        ["activeImplementationLimit", "Active implementation limit"],
        ["templateLimit", "Template limit"]
      ]) {
        const answer = (await prompt.question(`${label}: `)).trim();
        customLimits[key] = /^\d+$/.test(answer) ? Number(answer) : 0;
      }
      if (!validateCustomLimits(customLimits)) {
        throw new Error("Custom limits must be positive whole numbers.");
      }
    }
    const plan = getPlanDetails(planCode, customLimits);

    const password = randomBytes(24).toString("base64url");
    const passwordHash = await makePasswordHash(password);
    const created = await db.database.transaction(async () => {
      const user = await db.database.prepare(
        "INSERT INTO product_users (email, password_hash) VALUES ($1, $2) RETURNING id, email"
      ).get(email, passwordHash);
      const workspace = await db.database.prepare(
        "INSERT INTO product_workspaces (name) VALUES ($1) RETURNING id, name"
      ).get(workspaceName);
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
      return { user, workspace };
    });

    console.info(`Created workspace "${created.workspace.name}" (${created.workspace.id}) for ${created.user.email}.`);
    console.info(`Plan: ${plan.name}.`);
    console.info("Initial paid access is active for one calendar month from now.");
    console.info(`Initial password (share securely): ${password}`);
    console.info("Configure password-recovery email so the owner can replace this password.");
  } finally {
    prompt.close();
    await db.close();
  }
}

provisionWorkspace().catch((error) => {
  console.error(`Workspace provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
