"use strict";

const STARTER_TEMPLATES = [
  {
    name: "Standard SaaS Implementation",
    description: "A starting point for guiding a new SaaS customer from kickoff to launch.",
    steps: [
      {
        title: "Confirm goals and success criteria",
        description: "Agree on the outcomes, project owner, and target launch window.",
        owner: "Implementation lead",
        stage: "Kickoff",
        dueOffsetDays: 0,
        customerVisible: true
      },
      {
        title: "Collect setup requirements",
        description: "Request the configuration details the team needs before setup.",
        owner: "Customer admin",
        stage: "Customer setup",
        dueOffsetDays: 2,
        customerVisible: true
      },
      {
        title: "Configure the workspace",
        description: "Set up the customer workspace using the confirmed requirements.",
        owner: "Implementation specialist",
        stage: "Configuration",
        dueOffsetDays: 5,
        customerVisible: false
      },
      {
        title: "Review launch readiness",
        description: "Walk through the setup with the customer and confirm next steps.",
        owner: "Implementation lead",
        stage: "Launch",
        dueOffsetDays: 7,
        customerVisible: true
      }
    ]
  },
  {
    name: "API Integration Onboarding",
    description: "A starting point for coordinating a customer API integration.",
    steps: [
      {
        title: "Confirm integration requirements",
        description: "Agree on the systems, data flows, and success criteria for the integration.",
        owner: "Solutions engineer",
        stage: "Discovery",
        dueOffsetDays: 0,
        customerVisible: true
      },
      {
        title: "Confirm secure access method",
        description: "Agree on an approved way to provide access; do not share secrets in Relay.",
        owner: "Customer technical lead",
        stage: "Customer setup",
        dueOffsetDays: 2,
        customerVisible: true
      },
      {
        title: "Validate the sandbox flow",
        description: "Verify the agreed data flow in a test environment and record open issues.",
        owner: "Integration engineer",
        stage: "Configuration",
        dueOffsetDays: 5,
        customerVisible: false
      },
      {
        title: "Confirm go-live checks",
        description: "Review the agreed production checklist and confirm who owns each action.",
        owner: "Solutions engineer",
        stage: "Launch",
        dueOffsetDays: 7,
        customerVisible: true
      }
    ]
  }
];

async function createStarterTemplates(database, workspaceId, ownerUserId, plan) {
  for (const starter of STARTER_TEMPLATES) {
    const process = await database.prepare(`
      INSERT INTO product_processes (workspace_id, name, description)
      VALUES ($1, $2, $3)
      RETURNING id, revision
    `).get(workspaceId, starter.name, starter.description);

    const insertStep = database.prepare(`
      INSERT INTO product_process_steps
        (process_id, title, description, owner, position, stage, due_offset_days, assignee_user_id, customer_visible)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `);
    const snapshot = starter.steps.map((step, index) => ({
      ...step,
      position: index + 1,
      assigneeUserId: ownerUserId,
      dependsOnPositions: []
    }));

    for (const step of snapshot) {
      await insertStep.get(
        process.id,
        step.title,
        step.description,
        step.owner,
        step.position,
        step.stage,
        step.dueOffsetDays,
        ownerUserId,
        step.customerVisible
      );
    }

    await database.prepare(`
      INSERT INTO product_setup_checks (workspace_id, process_id, process_revision, result, findings_json)
      VALUES ($1, $2, $3, 'ready', '[]')
    `).run(workspaceId, process.id, process.revision);

    const template = await database.prepare(`
      INSERT INTO product_templates (workspace_id, process_id, name, steps_json, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING id, name, revision
    `).get(workspaceId, process.id, starter.name, JSON.stringify(snapshot));

    if (plan.features.templateHistory) {
      await database.prepare(`
        INSERT INTO product_template_versions (template_id, revision, name, steps_json)
        VALUES ($1, $2, $3, $4)
      `).run(template.id, template.revision, template.name, JSON.stringify(snapshot));
    }
  }
}

module.exports = { STARTER_TEMPLATES, createStarterTemplates };
