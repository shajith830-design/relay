"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createStarterTemplates } = require("../product-starter-templates");
const { getPlanDetails } = require("../product-plans");

function makeDatabase() {
  const statements = [];
  let nextId = 1;
  return {
    statements,
    prepare(sql) {
      return {
        async get(...values) {
          statements.push({ sql, values });
          return {
            id: nextId++,
            revision: 1,
            name: values[2],
            templateId: nextId
          };
        },
        async run(...values) {
          statements.push({ sql, values });
          return { changes: 1 };
        }
      };
    }
  };
}

test("new workspaces receive two ready-to-use onboarding templates", async () => {
  const database = makeDatabase();
  await createStarterTemplates(database, 17, 42, getPlanDetails("starter"));

  const processInserts = database.statements.filter(({ sql }) => sql.includes("INSERT INTO product_processes"));
  const templateInserts = database.statements.filter(({ sql }) => sql.includes("INSERT INTO product_templates"));
  const checkInserts = database.statements.filter(({ sql }) => sql.includes("INSERT INTO product_setup_checks"));
  const stepInserts = database.statements.filter(({ sql }) => sql.includes("INSERT INTO product_process_steps"));

  assert.deepEqual(processInserts.map(({ values }) => values[1]), [
    "Standard SaaS Implementation",
    "API Integration Onboarding"
  ]);
  assert.equal(templateInserts.length, 2);
  assert.equal(checkInserts.length, 2);
  assert.equal(stepInserts.length, 8);

  const firstTemplateSteps = JSON.parse(templateInserts[0].values[3]);
  assert.equal(firstTemplateSteps.length, 4);
  assert.ok(firstTemplateSteps.every((step) => step.assigneeUserId === 42));
  assert.ok(firstTemplateSteps.every((step) => step.dependsOnPositions.length === 0));
  assert.equal(
    database.statements.filter(({ sql }) => sql.includes("INSERT INTO product_template_versions")).length,
    0
  );
});

test("Growth starter templates include their initial revision history", async () => {
  const database = makeDatabase();
  await createStarterTemplates(database, 17, 42, getPlanDetails("growth"));

  const versionInserts = database.statements.filter(({ sql }) => sql.includes("INSERT INTO product_template_versions"));
  assert.equal(versionInserts.length, 2);
  assert.ok(versionInserts.every(({ values }) => values[1] === 1));
});
