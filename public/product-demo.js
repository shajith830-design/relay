"use strict";

(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") !== "workspace") return;

  const ownerId = 9001;
  const memberId = 9002;
  const portalStorageKey = "relay-workspace-demo-portals";
  let nextId = 9100;
  const today = new Date();
  const dateOffset = (days) => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const stageGateOrder = ["kickoff", "configuration", "testing", "launch", "hypercare", "complete"];
  const approvalStageGates = stageGateOrder.slice(0, -1);
  const demoWorkflow = [
    { title: "Confirm project goals", description: "Agree on success measures and the project owner.", owner: "Implementation lead", stage: "Kickoff", customer_visible: true, responsible_party: "client" },
    { title: "Gather workspace access", description: "Collect the access details needed for setup.", owner: "Setup specialist", stage: "Kickoff", customer_visible: true, responsible_party: "client" },
    { title: "Map the current workflow", description: "Document the team's current process and handoffs.", owner: "Implementation lead", stage: "Kickoff" },
    { title: "Configure the workspace", description: "Set up the workspace using confirmed project requirements.", owner: "Setup specialist", stage: "Configuration" },
    { title: "Confirm domain requirements", description: "Review DNS and domain configuration requirements.", owner: "Technical lead", stage: "Configuration" },
    { title: "Prepare sample data", description: "Prepare representative data for a safe test.", owner: "Data specialist", stage: "Configuration" },
    { title: "Validate user roles", description: "Check access levels with the project owner.", owner: "Setup specialist", stage: "Configuration" },
    { title: "Run an integration test", description: "Validate the configured integration in the test environment.", owner: "Technical lead", stage: "Testing" },
    { title: "Review training materials", description: "Prepare role-specific guidance for the customer team.", owner: "Customer lead", stage: "Testing" },
    { title: "Confirm acceptance checklist", description: "Review the agreed launch checks and owners.", owner: "Implementation lead", stage: "Testing" },
    { title: "Schedule the launch review", description: "Agree on a time to review launch readiness.", owner: "Customer lead", stage: "Launch" },
    { title: "Add the DNS record", description: "Acme IT adds the DNS record required for the launch configuration.", owner: "Acme IT", stage: "Launch", responsible_party: "client", blocker_reason: "The DNS record has not been added yet.", blocker_next_action: "Ask Acme IT to add the record and confirm when it is ready." },
    { title: "Confirm go-live", description: "Complete the final review once the DNS record is available.", owner: "Implementation lead", stage: "Launch" }
  ];
  const stageGatesToPass = (currentStage, nextStage) => {
    const currentIndex = stageGateOrder.indexOf(currentStage);
    const nextIndex = stageGateOrder.indexOf(nextStage);
    if (currentIndex < 0 || nextIndex < 0) return null;
    return nextIndex > currentIndex ? stageGateOrder.slice(currentIndex, nextIndex) : [];
  };
  const data = {
    user: { id: ownerId, email: "owner@demo.invalid" },
    workspace: {
      id: 9000,
      name: "Northstar Demo Workspace",
      role: "owner",
      subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString()
    },
    preferences: { theme: "light", accent: "blue" },
    notificationSettings: { email_enabled: false, reminder_days_before: 2 },
    integrations: [],
    onboardingDismissed: false,
    members: [
      { id: ownerId, email: "owner@demo.invalid", role: "owner", default_internal_cost_rate: 70, default_billable_rate: 150 },
      { id: memberId, email: "teammate@demo.invalid", role: "contributor", default_internal_cost_rate: 45, default_billable_rate: 110 }
    ],
    invites: [{
      id: 9003,
      invited_email: "new.teammate@demo.invalid",
      expires_at: new Date(Date.now() + 6 * 86400000).toISOString(),
      created_at: new Date().toISOString()
    }],
    processes: [{
      id: 9010,
      name: "Customer onboarding",
      description: "A sample workflow for a new software customer.",
      revision: 1,
      updated_at: new Date().toISOString(),
      checked: true,
      steps: demoWorkflow.map((step, index) => ({
        id: 9011 + index, ...step, position: index + 1, due_offset_days: index + 2,
        assignee_user_id: index % 2 ? memberId : ownerId,
        assignee_email: index % 2 ? "teammate@demo.invalid" : "owner@demo.invalid",
        estimated_duration_days: 1,
        responsible_party: step.responsible_party || "relay",
        dependsOn: index ? [9010 + index] : []
      }))
    }],
    templates: [{
      id: 9020, process_id: 9010, name: "Standard onboarding", revision: 2,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      steps: null
    }],
    requirements: [
      { id: 9030, name: "Project contact email", description: "Who should receive setup updates?", required: true, input_type: "email", template_id: null },
      { id: 9031, name: "Current website", description: "Share the website URL to use during setup.", required: false, input_type: "url", template_id: null }
    ],
    implementations: [{
      id: 9040, template_id: 9020, customer_name: "Acme Logistics", template_name: "Standard onboarding",
      created_at: dateOffset(-24), has_customer_link: true, escalation_email: "", escalation_delay_days: 5,
      base_onboarding_fee: 12000,       budget_type: "fixed_hours", budget_limit: 120,
      hard_lock_on_exceed: false, budgetBurn: { burn_pct: 50, logged_minutes: 3600, delivery_cost: 4200 },
      budgetOverrides: [], changeOrders: [{ id: 9050, status: "approved", additional_fee: 1500, task_ids: [9043] }],
      target_launch_date: dateOffset(5), customer_owner_name: "Jordan Lee", customer_owner_email: "jordan@acme.example",
      success_criteria: "Customer team completes a successful test and confirms the launch workflow.",
      acceptance_status: "in_progress",
      test_plan: "Run the configured workspace through the customer acceptance checklist.",
      training_status: "scheduled",
      support_owner_name: "Relay Support",
      support_owner_email: "support@relay.example",
      rollback_plan: "Freeze changes, restore the previous workspace configuration, and notify the project owner.",
      go_live_status: "at_risk",
      communication_channel: "Customer portal and Tuesday project call",
      communication_cadence: "Weekly and when a blocker changes",
      communication_owner_name: "Jordan Lee",
      communication_owner_email: "jordan@acme.example",
      procurement_status: "in_progress",
      security_status: "in_progress",
      security_notes: "Security questionnaire and access review are in progress.",
      integration_inventory: "API and domain configuration",
      integration_status: "in_progress",
      technical_setup_status: "tested",
      technical_setup_notes: "DNS and sandbox setup are in progress.",
      change_management_status: "planned",
      adoption_notes: "Role-specific training and internal champions are planned.",
      early_validation_status: "in_progress",
      early_validation_notes: "Data and integration testing have started.",
      post_launch_support_plan: "Relay support owner, office hours, and escalation route.",
      duplicate_request_control: "Use the portal and shared request history; do not repeat a submitted request.",
      sow_scope: "Configure and launch the standard onboarding workflow.",
      sow_milestones: "Kickoff, configuration, acceptance testing, launch.",
      sow_exclusions: "Custom development and third-party system support.",
      stage_gate_status: "configuration",
      financialPlan: { budget_amount: 12000, forecast_amount: 12000, actual_cost: 4200, invoice_status: "draft", invoice_reference: "SAMPLE-INV-100", margin_note: "Status and reference are fictional planning fields; Relay does not generate or send invoices." },
      timeEntries: [
        { id: 9051, task_id: 9041, minutes: 3600, billable: false, work_date: dateOffset(-1), note: "Sample setup and validation", user_email: "teammate@demo.invalid", internal_cost_rate_snapshot: 70, client_bill_rate_snapshot: 150, labor_cost: 4200, logged_at: new Date().toISOString() }
      ],
      approvals: [],
      calendarEvents: [],
      launchStakeholders: [],
      launchRisks: [],
      customerContacts: [], customerMessages: [], customerFiles: [],
      steps: demoWorkflow.map((step, index) => {
        const id = 9041 + index;
        const isBlocker = index === 11;
        return {
          id, title: step.title, description: step.description, owner: step.owner, position: index + 1,
          status: index < 11 ? "done" : isBlocker ? "in_progress" : "not_started",
          updated_at: isBlocker ? new Date(Date.now() - 6 * 86400000).toISOString() : dateOffset(-1), stage: step.stage,
          assignee_user_id: index % 2 ? memberId : ownerId,
          assignee_email: index % 2 ? "teammate@demo.invalid" : "owner@demo.invalid",
          customer_visible: step.customer_visible === true,
          due_at: dateOffset(isBlocker ? -2 : index < 11 ? -1 : 4),
          is_blocked: isBlocker,
          blocker_reason: isBlocker ? step.blocker_reason : "",
          blocker_next_action: isBlocker ? step.blocker_next_action : "",
          waiting_on: isBlocker ? "Acme IT" : index === 12 ? "Add the DNS record" : "",
          ...(index ? { dependsOn: [9040 + index] } : {}),
          ...(index < 11 ? { last_completed_at: dateOffset(-Math.max(1, 11 - index)) } : {})
        };
      }),
      requirements: [
        { id: 9030, name: "Project contact email", description: "Who should receive setup updates?", required: true, input_type: "email", value: "" },
        { id: 9031, name: "Current website", description: "Share the website URL to use during setup.", required: false, input_type: "url", value: "https://acme.example" }
      ]
    }],
    customerTokens: new Map(),
    helpMessages: [],
    capacityPlans: []
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function findProcess(id) {
    return data.processes.find((process) => process.id === Number(id));
  }

  function findTemplate(id) {
    return data.templates.find((template) => template.id === Number(id));
  }

  function findImplementation(id) {
    return data.implementations.find((implementation) => implementation.id === Number(id));
  }

  function calculateDemoBurn(implementation) {
    const limit = Number(implementation.budget_limit) || 0;
    if (limit <= 0 || !["fixed_hours", "fixed_fee"].includes(implementation.budget_type)) return null;
    const loggedMinutes = (implementation.timeEntries || []).reduce((total, entry) => total + Number(entry.minutes || 0), 0);
    const deliveryCost = (implementation.timeEntries || []).reduce(
      (total, entry) => total + Number(entry.minutes || 0) / 60 * Number(entry.internal_cost_rate_snapshot || 0), 0
    );
    return (implementation.budget_type === "fixed_hours" ? loggedMinutes / 60 : deliveryCost) / limit * 100;
  }

  function updateDemoBurn(implementation) {
    const loggedMinutes = (implementation.timeEntries || []).reduce((total, entry) => total + Number(entry.minutes || 0), 0);
    const deliveryCost = (implementation.timeEntries || []).reduce(
      (total, entry) => total + Number(entry.minutes || 0) / 60 * Number(entry.internal_cost_rate_snapshot || 0), 0
    );
    implementation.budgetBurn = {
      burn_pct: calculateDemoBurn(implementation),
      logged_minutes: loggedMinutes,
      delivery_cost: deliveryCost,
      hard_lock_on_exceed: implementation.hard_lock_on_exceed
    };
  }

  function demoPortfolioMargins() {
    const projects = data.implementations.filter((implementation) => !implementation.archived_at).map((implementation) => {
      const approvedChangeOrders = (implementation.changeOrders || []).filter((order) => order.status === "approved");
      const approvedTotal = approvedChangeOrders.reduce((total, order) => total + Number(order.additional_fee || 0), 0);
      const contractValue = Number(implementation.base_onboarding_fee || 0) + approvedTotal;
      const coveredTasks = new Set(approvedChangeOrders.flatMap((order) => order.task_ids || []));
      const deliveryCost = (implementation.timeEntries || []).reduce(
        (total, entry) => total + Number(entry.minutes || 0) / 60 * Number(entry.internal_cost_rate_snapshot || 0), 0
      );
      const budgetLimit = Number(implementation.budget_limit || 0);
      const uncoveredEntries = (implementation.timeEntries || [])
        .filter((entry) => !coveredTasks.has(entry.task_id))
        .sort((left, right) => String(left.logged_at || "").localeCompare(String(right.logged_at || "")));
      let overageLeakage = 0;
      if (implementation.budget_type === "fixed_hours" && budgetLimit > 0) {
        let consumedMinutes = 0;
        for (const entry of uncoveredEntries) {
          const priorOverage = Math.max(0, consumedMinutes - budgetLimit * 60);
          consumedMinutes += Number(entry.minutes || 0);
          const currentOverage = Math.max(0, consumedMinutes - budgetLimit * 60);
          overageLeakage += (currentOverage - priorOverage) / 60 * Number(entry.client_bill_rate_snapshot || 0);
        }
      } else if (implementation.budget_type === "fixed_fee" && budgetLimit > 0) {
        let consumedCost = 0;
        for (const entry of uncoveredEntries) {
          const rate = Number(entry.internal_cost_rate_snapshot || 0);
          const cost = Number(entry.minutes || 0) / 60 * rate;
          const priorOverage = Math.max(0, consumedCost - budgetLimit);
          consumedCost += cost;
          const currentOverage = Math.max(0, consumedCost - budgetLimit);
          if (rate > 0) overageLeakage += (currentOverage - priorOverage) / rate * Number(entry.client_bill_rate_snapshot || 0);
        }
      }
      const grossProfit = contractValue - deliveryCost;
      return {
        id: implementation.id,
        customer_name: implementation.customer_name,
        budget_type: implementation.budget_type,
        budget_limit: budgetLimit,
        hard_lock_on_exceed: Boolean(implementation.hard_lock_on_exceed),
        contract_value: contractValue,
        approved_change_orders_total: approvedTotal,
        delivery_cost: deliveryCost,
        gross_profit: grossProfit,
        gross_margin_pct: contractValue > 0 ? grossProfit / contractValue * 100 : 0,
        logged_minutes: (implementation.timeEntries || []).reduce((total, entry) => total + Number(entry.minutes || 0), 0),
        burn_pct: calculateDemoBurn(implementation),
        unbilled_overage_leakage: overageLeakage
      };
    });
    const revenue = projects.reduce((total, project) => total + project.contract_value, 0);
    const marginProjects = projects.filter((project) => project.contract_value > 0);
    return {
      summary: {
        total_portfolio_revenue: revenue,
        total_delivery_cost: projects.reduce((total, project) => total + project.delivery_cost, 0),
        average_gross_margin_pct: marginProjects.length
          ? marginProjects.reduce((total, project) => total + project.gross_margin_pct, 0) / marginProjects.length : 0,
        total_unbilled_overage_leakage: projects.reduce((total, project) => total + project.unbilled_overage_leakage, 0)
      },
      projects,
      alerts: []
    };
  }

  function updateWaitingTasks(implementation) {
    for (const step of implementation.steps) {
      step.waiting_on = implementation.steps
        .filter((parent) => step.dependsOn?.includes(parent.id) && parent.status !== "done")
        .map((parent) => parent.title)
        .join(", ");
    }
  }

  function applyPortalValues(implementation) {
    for (const portal of Object.values(readPortalSnapshots())) {
      if (portal.implementationId !== implementation.id) continue;
      for (const savedRequirement of portal.requirements) {
        const requirement = implementation.requirements.find((item) => item.id === savedRequirement.id);
        if (requirement) requirement.value = savedRequirement.value;
      }
    }
  }

  function summarizeImplementation(implementation) {
    updateWaitingTasks(implementation);
    applyPortalValues(implementation);
    const steps = implementation.steps;
    const open = steps.filter((step) => step.status !== "done");
    const missing = implementation.requirements.filter((item) => item.required && !item.value.trim());
    const quietCustomerDays = Math.max(0, Math.floor(
      (Date.now() - Date.parse(implementation.created_at)) / 86400000
    ));
    const blocked = open.filter((step) => step.is_blocked);
    const overdue = open.filter((step) => step.due_at && step.due_at < dateOffset(0));
    const waiting = open.filter((step) => step.waiting_on);
    const unowned = open.filter((step) => !step.assignee_user_id);
    const summary = {
      ...implementation,
      total_steps: steps.length,
      open_steps: open.length,
      completed_steps: steps.length - open.length,
      in_progress_steps: steps.filter((step) => step.status === "in_progress").length,
      assigned_member_ids: [...new Set(steps.map((step) => step.assignee_user_id).filter(Boolean))].join(","),
      unowned_steps: unowned.length,
      unowned_step_names: unowned.map((step) => step.title).join(", "),
      missing_inputs: missing.length,
      missing_input_names: missing.map((item) => item.name).join(", "),
      quiet_customer_days: quietCustomerDays,
      quiet_customer: missing.length > 0 && quietCustomerDays >= 3,
      invalid_inputs: 0,
      invalid_input_names: "",
      blocked_steps: blocked.length,
      blocked_step_names: blocked.map((step) => step.title).join(", "),
      overdue_steps: overdue.length,
      overdue_step_names: overdue.map((step) => step.title).join(", "),
      waiting_steps: waiting.length,
      waiting_step_names: waiting.map((step) => step.title).join(", ")
    };
    const lastCompleted = steps
      .filter((step) => step.status === "done")
      .map((step) => step.last_completed_at || step.updated_at)
      .sort()
      .at(-1);
    if (summary.completed_steps > 0 && summary.open_steps > 0 && lastCompleted) {
      const elapsedDays = Math.max(1,
        (Date.parse(lastCompleted) - Date.parse(implementation.created_at)) / 86400000);
      const daysRemaining = Math.ceil((elapsedDays / summary.completed_steps) * summary.open_steps);
      summary.projected_completion = dateOffset(daysRemaining);
    } else {
      summary.projected_completion = summary.open_steps === 0 ? dateOffset(0) : "";
    }
    return summary;
  }

  function workspaceData() {
    return {
      processes: data.processes.map((process) => ({
        id: process.id,
        name: process.name,
        description: process.description,
        updated_at: process.updated_at,
        steps_count: process.steps.length,
        checked: process.checked
      })),
      templates: data.templates.map((template) => ({
        id: template.id,
        name: template.name,
        created_at: template.created_at,
        updated_at: template.updated_at,
        revision: template.revision,
        step_count: template.steps.length
      })),
      implementations: data.implementations.filter((implementation) => !implementation.archived_at).map(summarizeImplementation),
      archivedImplementations: data.implementations.filter((implementation) => implementation.archived_at).map((implementation) => ({
        id: implementation.id,
        customer_name: implementation.customer_name,
        template_name: implementation.template_name,
        archived_at: implementation.archived_at
      })),
      requirements: clone(data.requirements),
      members: clone(data.members),
      invites: clone(data.invites),
      teamWorkload: data.members.map((member) => {
        const tasks = data.implementations.filter((implementation) => !implementation.archived_at)
          .flatMap((implementation) => implementation.steps)
          .filter((step) => step.assignee_user_id === member.id && step.status !== "done");
        return {
          id: member.id,
          email: member.email,
          open_tasks: tasks.length,
          overdue_tasks: tasks.filter((step) => step.due_at && step.due_at < dateOffset(0)).length
        };
      }),
      notificationSettings: clone(data.notificationSettings),
      integrations: clone(data.integrations),
      capacityPlans: clone(data.capacityPlans || []),
      role: "owner",
      capabilities: {
        administerWorkspace: true,
        manageImplementations: true,
        manageTasks: true,
        manageCustomerCommunication: true,
        logTime: true,
        viewFinancials: true,
        manageFinancials: true,
        viewRates: true,
        viewAuditLogs: true,
        executiveView: true
      },
      plan: {
        code: "custom",
        name: "Custom",
        memberLimit: null,
        activeImplementationLimit: null,
        templateLimit: null,
        features: {
          dependencies: true,
          blockers: true,
          templateHistory: true,
          criticalPath: true,
          changeOrders: true,
          portfolioFull: true,
          hubspot: true,
          financialProtection: true,
          clientDelegation: true,
          inputValidation: true,
          stageGates: true,
          clientReminders: true,
          csvExports: true,
          slackAlerts: false,
          enterpriseIntegrations: true
        }
      },
      usage: {
        members: data.members.length,
        pendingInvites: data.invites.length,
        templates: data.templates.length,
        activeImplementations: data.implementations.filter((implementation) => !implementation.archived_at).length
      }
    };
  }

  function makeTemplate(process, name, id = nextId++) {
    const steps = process.steps.map((step, index) => ({
      title: step.title,
      description: step.description,
      owner: step.owner,
      assigneeUserId: step.assignee_user_id,
      assigneeEmail: step.assignee_email,
      stage: step.stage,
      dueOffsetDays: step.due_offset_days,
      estimatedDurationDays: step.estimated_duration_days || 1,
      responsibleParty: step.responsible_party || (step.customer_visible ? "client" : "relay"),
      position: index + 1,
      dependsOnPositions: step.dependsOn.map((dependency) =>
        process.steps.findIndex((candidate) => candidate.id === dependency) + 1
      ).filter((position) => position > 0),
      customerVisible: step.customer_visible === true
    }));
    return {
      id, process_id: process.id, name, revision: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), steps
    };
  }

  data.templates[0].steps = makeTemplate(data.processes[0], data.templates[0].name, data.templates[0].id).steps;
  data.templates[0].history = [
    { revision: 2, name: "Standard onboarding", steps: data.templates[0].steps.map((step) => step.title), created_at: data.templates[0].updated_at },
    { revision: 1, name: "Standard onboarding draft", steps: data.templates[0].steps.slice(0, 2).map((step) => step.title), created_at: data.templates[0].created_at }
  ];
  const brightwaveProcess = clone(data.processes[0]);
  brightwaveProcess.id = 9060;
  brightwaveProcess.name = "Short launch workflow";
  brightwaveProcess.steps = brightwaveProcess.steps.slice(0, 5).map((step, index) => ({
    ...step,
    id: 9061 + index,
    position: index + 1,
    dependsOn: index ? [9060 + index] : []
  }));
  const brightwaveTemplate = {
    id: 9070, process_id: brightwaveProcess.id, name: "Short launch workflow", revision: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    steps: makeTemplate(brightwaveProcess, "Short launch workflow", 9070).steps,
    history: []
  };
  const brightwave = clone(data.implementations[0]);
  brightwave.id = 9080;
  brightwave.template_id = brightwaveTemplate.id;
  brightwave.customer_name = "Brightwave";
  brightwave.template_name = brightwaveTemplate.name;
  brightwave.created_at = dateOffset(-41);
  brightwave.has_customer_link = false;
  brightwave.target_launch_date = dateOffset(9);
  brightwave.steps = brightwaveProcess.steps.map((step, index) => {
    const open = index >= 2;
    const owner = ["Brightwave IT", "Brightwave data team", "Brightwave project lead"][index - 2];
    return {
      id: 9081 + index,
      title: ["Confirm project goals", "Gather workspace access", "Configure single sign-on", "Prepare import data", "Approve launch checklist"][index],
      description: step.description,
      owner: open ? owner : step.owner,
      position: index + 1,
      status: index < 2 ? "done" : "not_started",
      updated_at: dateOffset(open ? -9 + index : -12 + index),
      stage: step.stage,
      assignee_user_id: index % 2 ? memberId : ownerId,
      assignee_email: index % 2 ? "teammate@demo.invalid" : "owner@demo.invalid",
      customer_visible: index === 1,
      due_at: dateOffset(open ? -3 : -8),
      is_blocked: open,
      blocker_reason: open ? "The required setup information has not arrived." : "",
      blocker_next_action: open ? `Follow up with ${owner} for the next update.` : "",
      waiting_on: open ? owner : "",
      ...(index ? { dependsOn: [9080 + index] } : {})
    };
  });
  data.processes.push(brightwaveProcess);
  data.templates.push(brightwaveTemplate);
  data.implementations.push(brightwave);

  function responseForImplementation(implementation) {
    if (!implementation) throw new Error("Implementation not found in the local demo data.");
    applyPortalValues(implementation);
    const result = clone(implementation);
    result.customerContacts = (result.customerContacts || []).map(({ token, ...contact }) => contact);
    return { implementation: result };
  }

  function readPortalSnapshots() {
    const stored = window.localStorage.getItem(portalStorageKey);
    return stored ? JSON.parse(stored) : {};
  }

  function savePortalSnapshot(token, implementation, preserveExisting = false) {
    const portals = readPortalSnapshots();
    const previousPortal = Object.values(portals)
      .find((portal) => portal.implementationId === implementation.id);
    if (previousPortal) {
      for (const savedRequirement of previousPortal.requirements) {
        const requirement = implementation.requirements.find((item) => item.id === savedRequirement.id);
        if (requirement) requirement.value = savedRequirement.value;
      }
    }
    if (!preserveExisting) {
      for (const [savedToken, portal] of Object.entries(portals)) {
        if (portal.implementationId === implementation.id) delete portals[savedToken];
      }
    }
    portals[token] = {
      implementationId: implementation.id,
      customerName: implementation.customer_name,
      customerOwnerName: implementation.customer_owner_name || "",
      customerOwnerEmail: implementation.customer_owner_email || "",
      targetLaunchDate: implementation.target_launch_date || "",
      successCriteria: implementation.success_criteria || "",
      acceptanceStatus: implementation.acceptance_status || "not_started",
      testPlan: implementation.test_plan || "",
      trainingStatus: implementation.training_status || "not_started",
      supportOwnerName: implementation.support_owner_name || "",
      supportOwnerEmail: implementation.support_owner_email || "",
      rollbackPlan: implementation.rollback_plan || "",
      goLiveStatus: implementation.go_live_status || "not_ready",
      communicationChannel: implementation.communication_channel || "",
      communicationCadence: implementation.communication_cadence || "",
      communicationOwnerName: implementation.communication_owner_name || "",
      communicationOwnerEmail: implementation.communication_owner_email || "",
      procurementStatus: implementation.procurement_status || "not_started",
      securityStatus: implementation.security_status || "not_started",
      integrationStatus: implementation.integration_status || "not_started",
      technicalSetupStatus: implementation.technical_setup_status || "not_started",
      changeManagementStatus: implementation.change_management_status || "not_started",
      earlyValidationStatus: implementation.early_validation_status || "not_started",
      postLaunchSupportPlan: implementation.post_launch_support_plan || "",
      contact: (implementation.customerContacts || []).find((contact) => contact.token === token)
        ? {
          id: (implementation.customerContacts || []).find((contact) => contact.token === token).id,
          name: (implementation.customerContacts || []).find((contact) => contact.token === token).display_name,
          email: (implementation.customerContacts || []).find((contact) => contact.token === token).email,
          expiresAt: (implementation.customerContacts || []).find((contact) => contact.token === token).expires_at
        } : null,
      requirements: clone(implementation.requirements),
      messages: clone(implementation.customerMessages || []),
      files: clone(implementation.customerFiles || []),
      tasks: implementation.steps.filter((step) => step.customer_visible).map((step) => ({
        id: step.id,
        title: step.title,
        description: step.description,
        stage: step.stage,
        status: step.status,
        due_at: step.due_at,
        is_blocked: step.is_blocked,
        blocker_reason: step.blocker_reason,
        blocker_next_action: step.blocker_next_action,
        waiting: Boolean(step.waiting_on),
        dependsOn: clone(step.dependsOn || [])
      }))
    };
    window.localStorage.setItem(portalStorageKey, JSON.stringify(portals));
  }

  function findPortalSnapshot(token) {
    const portal = readPortalSnapshots()[token] || null;
    if (portal?.contact?.expiresAt && Date.parse(portal.contact.expiresAt) <= Date.now()) return null;
    return portal;
  }

  function implementationForCustomerToken(token) {
    return data.implementations.find((implementation) =>
      !implementation.archived_at && (
      data.customerTokens.get(implementation.id) === token
      || (implementation.customerContacts || []).some((contact) =>
        contact.token === token && !contact.revoked_at && Date.parse(contact.expires_at) > Date.now())));
  }

  function validateCustomerValue(requirement, value) {
    if (!value) return "";
    if (requirement.input_type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return "Enter a valid email address.";
    }
    if (requirement.input_type === "url") {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) {
          return "Enter a complete website URL beginning with https://.";
        }
      } catch {
        return "Enter a complete website URL beginning with https://.";
      }
    }
    if (requirement.input_type === "number" && !Number.isFinite(Number(value))) return "Enter a valid number.";
    if (requirement.input_type === "date") {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
        return "Enter a valid date.";
      }
    }
    return "";
  }

  function request(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const body = options.body || {};
    const path = url.split("?")[0];
    let match;

    if (path === "/api/product/me") {
      return Promise.resolve({ user: clone(data.user), workspace: clone(data.workspace) });
    }
    if (path === "/api/product/auth/logout" && method === "POST") return Promise.resolve({ success: true });
    if (path === "/api/product/preferences" && method === "GET") return Promise.resolve(clone(data.preferences));
    if (path === "/api/product/preferences" && method === "PATCH") {
      if (body.theme !== undefined) data.preferences.theme = body.theme;
      if (body.accent !== undefined) data.preferences.accent = body.accent;
      return Promise.resolve(clone(data.preferences));
    }
    if (path === "/api/product/onboarding" && method === "GET") {
      return Promise.resolve({ dismissed: data.onboardingDismissed });
    }
    if (path === "/api/product/onboarding" && method === "PATCH") {
      data.onboardingDismissed = body.dismissed === true;
      return Promise.resolve({ dismissed: data.onboardingDismissed });
    }
    if (path === "/api/product/workspace") return Promise.resolve(workspaceData());
    if (path === "/api/product/analytics/portfolio-margins" && method === "GET") {
      return Promise.resolve(clone(demoPortfolioMargins()));
    }
    if ((match = path.match(/^\/api\/product\/team-members\/(\d+)\/rates$/)) && method === "POST") {
      const member = data.members.find((item) => item.id === Number(match[1]));
      if (!member) return Promise.reject(new Error("Team member not found."));
      const costRate = Number(body.defaultInternalCostRate);
      const billRate = Number(body.defaultBillableRate);
      if (!Number.isFinite(costRate) || costRate < 0 || !Number.isFinite(billRate) || billRate < 0) {
        return Promise.reject(new Error("Enter valid non-negative hourly rates."));
      }
      member.default_internal_cost_rate = costRate;
      member.default_billable_rate = billRate;
      return Promise.resolve({ member: clone(member) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/archive$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      if (implementation.archived_at) return Promise.reject(new Error("This implementation is already archived."));
      implementation.archived_at = new Date().toISOString();
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/restore$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      if (!implementation.archived_at) return Promise.reject(new Error("This implementation is not archived."));
      delete implementation.archived_at;
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      data.implementations = data.implementations.filter((item) => item.id !== implementation.id);
      data.customerTokens.delete(implementation.id);
      const portals = readPortalSnapshots();
      for (const [token, portal] of Object.entries(portals)) {
        if (portal.implementationId === implementation.id) delete portals[token];
      }
      window.localStorage.setItem(portalStorageKey, JSON.stringify(portals));
      return Promise.resolve({ success: true });
    }
    if (path === "/api/product/capacity-plans" && method === "POST") {
      const plan = {
        user_id: Number(body.userId), user_email: data.members.find((member) => member.id === Number(body.userId))?.email || "",
        week_start: String(body.weekStart || ""), available_minutes: Number(body.availableMinutes),
        capacity_note: String(body.capacityNote || ""), updated_at: new Date().toISOString()
      };
      if (!plan.week_start || !Number.isInteger(plan.available_minutes) || plan.available_minutes < 0) {
        return Promise.reject(new Error("Enter a valid team member, week, and available capacity."));
      }
      data.capacityPlans = (data.capacityPlans || []).filter((item) =>
        !(item.user_id === plan.user_id && item.week_start === plan.week_start));
      data.capacityPlans.push(plan);
      return Promise.resolve({ plan });
    }
    if (path === "/api/product/notifications" && method === "PATCH") {
      const reminderDaysBefore = Number(body.reminderDaysBefore);
      if (!Number.isInteger(reminderDaysBefore) || reminderDaysBefore < 0 || reminderDaysBefore > 30) {
        return Promise.reject(new Error("Reminder days must be a whole number between 0 and 30."));
      }
      data.notificationSettings = {
        email_enabled: body.emailEnabled === true,
        reminder_days_before: reminderDaysBefore
      };
      return Promise.resolve({
        emailEnabled: data.notificationSettings.email_enabled,
        reminderDaysBefore: data.notificationSettings.reminder_days_before
      });
    }
    if ((match = path.match(/^\/api\/product\/integrations\/(hubspot|salesforce)\/connect$/)) && method === "POST") {
      const provider = match[1];
      if (!data.integrations.some((integration) => integration.provider === provider)) {
        data.integrations.push({ provider, connected_at: new Date().toISOString(), demo: true });
      }
      return Promise.resolve({ demoConnected: true });
    }
    if ((match = path.match(/^\/api\/product\/integrations\/(hubspot|salesforce)$/)) && method === "DELETE") {
      data.integrations = data.integrations.filter((integration) => integration.provider !== match[1]);
      return Promise.resolve({ success: true });
    }
    if (path === "/api/product/account-deletion/workspaces") {
      return Promise.resolve({
        workspaces: [{
          id: data.workspace.id, name: data.workspace.name, role: "owner",
          member_count: data.members.length,
          members: data.members.filter((member) => member.id !== ownerId)
            .map((member) => ({ userId: member.id, email: member.email }))
        }]
      });
    }
    if (path === "/api/product/account" && method === "DELETE") {
      return Promise.reject(new Error("Account deletion is disabled in local demo mode; no account or data was deleted."));
    }
    if (path === "/api/product/help-chat" && method === "GET") {
      return Promise.resolve({ messages: clone(data.helpMessages) });
    }
    if (path === "/api/product/help-chat" && method === "DELETE") {
      data.helpMessages = [];
      return Promise.resolve({ success: true });
    }
    if (path === "/api/product/help-chat" && method === "POST") {
      if (!body.message?.trim()) return Promise.reject(new Error("Enter a Relay question up to 1,200 characters."));
      const answer = window.relayDemoReply(body.message);
      data.helpMessages.push(
        { id: nextId++, role: "user", content: body.message, created_at: new Date().toISOString() },
        { id: nextId++, role: "assistant", content: answer, created_at: new Date().toISOString() }
      );
      data.helpMessages = data.helpMessages.slice(-50);
      return Promise.resolve({ message: clone(data.helpMessages.at(-1)) });
    }
    if (path === "/api/product/invites" && method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Promise.reject(new Error("Enter a valid teammate email address."));
      if (data.invites.some((invite) => invite.invited_email === email)) return Promise.reject(new Error("An invitation is already pending for this email."));
      const invite = {
        id: nextId++,
        invited_email: email,
        role: body.role || "contributor",
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        created_at: new Date().toISOString()
      };
      data.invites.unshift(invite);
      return Promise.resolve({ invite: { ...clone(invite), inviteUrl: `${window.location.origin}/product.html?invite=local-demo-${invite.id}` } });
    }
    if ((match = path.match(/^\/api\/product\/team-members\/(\d+)\/role$/)) && method === "PATCH") {
      const member = data.members.find((item) => item.id === Number(match[1]));
      if (!member || member.role === "owner") return Promise.reject(new Error("Teammate not found."));
      if (!["admin", "implementation_manager", "contributor", "executive_viewer"].includes(body.role)) {
        return Promise.reject(new Error("Choose a valid workspace role."));
      }
      member.role = body.role;
      return Promise.resolve({ member: clone(member) });
    }
    if ((match = path.match(/^\/api\/product\/invites\/(\d+)$/)) && method === "DELETE") {
      data.invites = data.invites.filter((invite) => invite.id !== Number(match[1]));
      return Promise.resolve({ success: true });
    }
    if (path === "/api/product/processes" && method === "POST") {
      const name = String(body.name || "").trim();
      if (!name || name.length > 100) return Promise.reject(new Error("Enter a valid process name."));
      const process = { id: nextId++, name, description: String(body.description || "").trim(), revision: 1, updated_at: new Date().toISOString(), checked: false, steps: [] };
      data.processes.unshift(process);
      return Promise.resolve({ process: clone(process) });
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)$/)) && method === "GET") {
      const process = findProcess(match[1]);
      return process ? Promise.resolve({ process: clone(process) }) : Promise.reject(new Error("Process not found."));
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)$/)) && method === "PATCH") {
      const process = findProcess(match[1]);
      if (!process) return Promise.reject(new Error("Process not found."));
      process.name = String(body.name || "").trim();
      process.description = String(body.description || "").trim();
      process.checked = false;
      process.revision += 1;
      process.updated_at = new Date().toISOString();
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)$/)) && method === "DELETE") {
      const processId = Number(match[1]);
      if (data.templates.some((template) => template.process_id === processId)) return Promise.reject(new Error("This process is used by a saved template. Delete unused templates first."));
      data.processes = data.processes.filter((process) => process.id !== processId);
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)\/steps$/)) && method === "POST") {
      const process = findProcess(match[1]);
      if (!process) return Promise.reject(new Error("Process not found."));
      const title = String(body.title || "").trim();
      if (!title) return Promise.reject(new Error("Enter a step name."));
      const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.map(Number) : [];
      if (dependsOn.some((id) => !process.steps.some((step) => step.id === id))) return Promise.reject(new Error("A prerequisite must be another step in this process."));
      const step = {
        id: nextId++, title, description: String(body.description || "").trim(), owner: String(body.owner || "").trim(),
        position: process.steps.length + 1, stage: String(body.stage || "Implementation"),
        due_offset_days: Number(body.dueOffsetDays || 0), assignee_user_id: body.assigneeUserId ? Number(body.assigneeUserId) : null,
        assignee_email: data.members.find((member) => member.id === Number(body.assigneeUserId))?.email || null,
        customer_visible: body.customerVisible === true,
        estimated_duration_days: Number(body.estimatedDurationDays || 1),
        responsible_party: body.responsibleParty === "client" ? "client" : "relay",
        dependsOn
      };
      process.steps.push(step);
      process.revision += 1;
      process.checked = false;
      process.updated_at = new Date().toISOString();
      return Promise.resolve({ step: clone(step) });
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)\/steps\/order$/)) && method === "PUT") {
      const process = findProcess(match[1]);
      if (!process || !Array.isArray(body.stepIds) || body.stepIds.length !== process.steps.length
        || new Set(body.stepIds.map(Number)).size !== process.steps.length
        || body.stepIds.some((id) => !process.steps.some((step) => step.id === Number(id)))) {
        return Promise.reject(new Error("Choose a valid order for every process step."));
      }
      process.steps = body.stepIds.map(Number).map((id, index) => {
        const step = process.steps.find((item) => item.id === id);
        step.position = index + 1;
        return step;
      });
      process.revision += 1;
      process.checked = false;
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)\/steps\/(\d+)$/)) && method === "PATCH") {
      const process = findProcess(match[1]);
      const step = process?.steps.find((item) => item.id === Number(match[2]));
      if (!step) return Promise.reject(new Error("Process step not found."));
      const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.map(Number) : [];
      if (dependsOn.includes(step.id) || dependsOn.some((id) => !process.steps.some((item) => item.id === id))) {
        return Promise.reject(new Error("Choose valid prerequisite steps."));
      }
      Object.assign(step, {
        title: String(body.title || "").trim(), description: String(body.description || "").trim(),
        owner: String(body.owner || "").trim(), stage: String(body.stage || "Implementation"),
        due_offset_days: Number(body.dueOffsetDays || 0),
        estimated_duration_days: Number(body.estimatedDurationDays || 1),
        responsible_party: body.responsibleParty === "client" ? "client" : "relay",
        assignee_user_id: body.assigneeUserId ? Number(body.assigneeUserId) : null,
        assignee_email: data.members.find((member) => member.id === Number(body.assigneeUserId))?.email || null,
        customer_visible: body.customerVisible === true,
        dependsOn
      });
      process.revision += 1;
      process.checked = false;
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)\/steps\/(\d+)$/)) && method === "DELETE") {
      const process = findProcess(match[1]);
      if (!process) return Promise.reject(new Error("Process not found."));
      const stepId = Number(match[2]);
      process.steps = process.steps.filter((step) => step.id !== stepId);
      process.steps.forEach((step, index) => {
        step.position = index + 1;
        step.dependsOn = step.dependsOn.filter((id) => id !== stepId);
      });
      process.revision += 1;
      process.checked = false;
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/processes\/(\d+)\/test$/)) && method === "POST") {
      const process = findProcess(match[1]);
      if (!process) return Promise.reject(new Error("Process not found."));
      const findings = [];
      if (!process.steps.length) findings.push("Add at least one step before testing this process or saving it as a template. One step is enough to start.");
      process.steps.forEach((step, index) => {
        if (!step.description) findings.push(`Step ${index + 1} (“${step.title}”) needs a short instruction.`);
        if (!step.owner) findings.push(`Step ${index + 1} (“${step.title}”) needs an owner.`);
        if (!step.assignee_user_id) findings.push(`Step ${index + 1} (“${step.title}”) needs an assigned workspace member.`);
        if (step.dependsOn.some((id) => process.steps.findIndex((candidate) => candidate.id === id) >= index)) findings.push(`Step “${step.title}” must appear after its prerequisite steps.`);
      });
      process.checked = process.steps.length > 0 && findings.length === 0;
      return Promise.resolve({
        check: { id: nextId++, result: process.checked ? "ready" : "needs_attention" },
        findings, stepsChecked: process.steps.length,
        handover: process.checked ? process.steps.map((step, index) => ({
          number: index + 1, title: step.title, description: step.description, owner: step.owner,
          assigneeUserId: step.assignee_user_id, assigneeEmail: step.assignee_email,
          stage: step.stage, dueOffsetDays: step.due_offset_days,
          dependsOn: step.dependsOn.map((id) => process.steps.find((item) => item.id === id)?.title).filter(Boolean)
        })) : []
      });
    }
    if (path === "/api/product/templates" && method === "POST") {
      const process = findProcess(body.processId);
      if (!process?.checked || !process.steps.length) return Promise.reject(new Error("Run a successful setup check before saving a reusable template."));
      const template = makeTemplate(process, String(body.name || "").trim());
      data.templates.unshift(template);
      return Promise.resolve({ template: clone(template) });
    }
    if ((match = path.match(/^\/api\/product\/templates\/(\d+)\/versions$/)) && method === "GET") {
      const template = findTemplate(match[1]);
      if (!template) return Promise.reject(new Error("Template not found."));
      const versions = template.history || [{
        revision: template.revision, name: template.name, steps: template.steps.map((step) => step.title),
        created_at: template.updated_at
      }];
      return Promise.resolve({ versions: clone(versions).sort((a, b) => b.revision - a.revision) });
    }
    if ((match = path.match(/^\/api\/product\/templates\/(\d+)\/versions\/(\d+)\/restore$/)) && method === "POST") {
      const template = findTemplate(match[1]);
      const version = template?.history?.find((item) => item.revision === Number(match[2]));
      if (!template || !version) return Promise.reject(new Error("Template version not found."));
      template.name = version.name;
      template.revision += 1;
      template.history.push({ ...clone(version), revision: template.revision, created_at: new Date().toISOString() });
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/templates\/(\d+)$/)) && method === "PATCH") {
      const template = findTemplate(match[1]);
      if (!template) return Promise.reject(new Error("Template not found."));
      if (body.refreshFromProcess) {
        const process = findProcess(template.process_id);
        if (!process?.checked) return Promise.reject(new Error("Check the process before refreshing this template."));
        template.steps = makeTemplate(process, template.name, template.id).steps;
      }
      template.name = String(body.name || "").trim();
      template.revision += 1;
      template.updated_at = new Date().toISOString();
      template.history ||= [];
      template.history.push({ revision: template.revision, name: template.name, steps: template.steps.map((step) => step.title), created_at: template.updated_at });
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/templates\/(\d+)$/)) && method === "DELETE") {
      const templateId = Number(match[1]);
      if (data.implementations.some((implementation) => implementation.template_id === templateId)) return Promise.reject(new Error("This template is used by customer implementations."));
      data.templates = data.templates.filter((template) => template.id !== templateId);
      return Promise.resolve({ success: true });
    }
    if (path === "/api/product/implementations" && method === "POST") {
      const template = findTemplate(body.templateId);
      const customerName = String(body.customerName || "").trim();
      if (!template || !customerName) return Promise.reject(new Error("Choose a template and enter the customer’s company name."));
      const implementation = {
        id: nextId++, template_id: template.id, customer_name: customerName, template_name: template.name,
        created_at: new Date().toISOString(), has_customer_link: false,
        target_launch_date: String(body.targetLaunchDate || ""),
        customer_owner_name: String(body.customerOwnerName || "").trim(),
        customer_owner_email: String(body.customerOwnerEmail || "").trim().toLowerCase(),
        customerContacts: [], customerMessages: [], customerFiles: [],
        steps: template.steps.map((step, index) => ({
          id: nextId++, title: step.title, description: step.description, owner: step.owner,
          position: index + 1, status: "not_started", updated_at: new Date().toISOString(),
          stage: step.stage, assignee_user_id: step.assigneeUserId || null, assignee_email: step.assigneeEmail || null,
          customer_visible: step.customerVisible === true,
          estimated_duration_days: step.estimatedDurationDays || 1,
          responsible_party: step.responsibleParty || (step.customerVisible ? "client" : "relay"),
          due_at: dateOffset(step.dueOffsetDays || 0), is_blocked: false, blocker_reason: "", blocker_next_action: "",
          waiting_on: "", dependsOn: []
        })),
        requirements: data.requirements.filter((item) => !item.template_id || item.template_id === template.id)
          .map((item) => ({ ...clone(item), value: "" }))
      };
      implementation.steps.forEach((step, index) => {
        step.dependsOn = (template.steps[index].dependsOnPositions || [])
          .map((position) => implementation.steps[position - 1]?.id)
          .filter(Boolean);
      });
      updateWaitingTasks(implementation);
      data.implementations.unshift(implementation);
      let customerInvitation = null;
      if (implementation.customer_owner_email) {
        const token = `local-demo-${nextId++}`;
        const contact = {
          id: nextId++, email: implementation.customer_owner_email,
          display_name: implementation.customer_owner_name,
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
          invitation_sent_at: null, revoked_at: null, last_activity_at: new Date().toISOString(),
          created_at: new Date().toISOString(), token
        };
        implementation.customerContacts.push(contact);
        savePortalSnapshot(token, implementation, true);
        customerInvitation = {
          sent: false,
          link: `${window.location.origin}/customer.html?token=${encodeURIComponent(token)}&demo=workspace`,
          message: "Sample preview only. No email was sent."
        };
      }
      return Promise.resolve({ implementation: responseForImplementation(implementation).implementation, customerInvitation });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)$/)) && method === "GET") {
      const implementation = findImplementation(match[1]);
      if (!implementation || implementation.archived_at) return Promise.reject(new Error("Implementation not found."));
      return Promise.resolve(responseForImplementation(implementation));
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/customer-escalation$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      const email = String(body.escalationEmail || "").trim().toLowerCase();
      const delay = Number(body.escalationDelayDays);
      if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        || !Number.isInteger(delay) || delay < 3 || delay > 30) {
        return Promise.reject(new Error("Enter a valid backup contact email and an escalation delay from 3 to 30 days."));
      }
      implementation.escalation_email = email;
      implementation.escalation_delay_days = delay;
      return Promise.resolve({ escalationEmail: email, escalationDelayDays: delay });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/launch-plan$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.customer_owner_name = String(body.customerOwnerName || "").trim();
      implementation.customer_owner_email = String(body.customerOwnerEmail || "").trim().toLowerCase();
      implementation.target_launch_date = String(body.targetLaunchDate || "");
      for (const contact of implementation.customerContacts || []) savePortalSnapshot(contact.token, implementation, true);
      return Promise.resolve({
        customerOwnerName: implementation.customer_owner_name,
        customerOwnerEmail: implementation.customer_owner_email,
        targetLaunchDate: implementation.target_launch_date
      });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/launch-readiness$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.success_criteria = String(body.successCriteria || "").trim();
      implementation.acceptance_status = String(body.acceptanceStatus || "not_started");
      implementation.test_plan = String(body.testPlan || "").trim();
      implementation.training_status = String(body.trainingStatus || "not_started");
      implementation.support_owner_name = String(body.supportOwnerName || "").trim();
      implementation.support_owner_email = String(body.supportOwnerEmail || "").trim().toLowerCase();
      implementation.rollback_plan = String(body.rollbackPlan || "").trim();
      implementation.go_live_status = String(body.goLiveStatus || "not_ready");
      return Promise.resolve(clone(body));
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/sow$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      const nextStage = String(body.stageGateStatus || "kickoff");
      const gatesToPass = stageGatesToPass(implementation.stage_gate_status || "kickoff", nextStage);
      if (!gatesToPass) return Promise.reject(new Error("The selected stage gate is invalid."));
      const blockingApproval = (implementation.approvals || []).find((approval) =>
        gatesToPass.includes(approval.stage_gate) && approval.status !== "approved");
      if (blockingApproval) {
        return Promise.reject(new Error(`Approve all required ${blockingApproval.stage_gate} approvals before moving to ${nextStage}.`));
      }
      implementation.sow_scope = String(body.sowScope || "").trim();
      implementation.sow_milestones = String(body.sowMilestones || "").trim();
      implementation.sow_exclusions = String(body.sowExclusions || "").trim();
      implementation.stage_gate_status = nextStage;
      return Promise.resolve(clone(body));
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/financial-plan$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.financialPlan = {
        budget_amount: Number(body.budgetAmount || 0),
        forecast_amount: Number(body.forecastAmount || 0),
        actual_cost: Number(body.actualCost || 0),
        invoice_status: String(body.invoiceStatus || "not_started"),
        invoice_reference: String(body.invoiceReference || ""),
        margin_note: String(body.marginNote || "")
      };
      return Promise.resolve(clone(body));
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/budget$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.base_onboarding_fee = Number(body.baseOnboardingFee);
      implementation.budget_type = String(body.budgetType);
      implementation.budget_limit = Number(body.budgetLimit);
      implementation.hard_lock_on_exceed = body.hardLockOnExceed === true;
      updateDemoBurn(implementation);
      return Promise.resolve({
        baseOnboardingFee: implementation.base_onboarding_fee,
        budgetType: implementation.budget_type,
        budgetLimit: implementation.budget_limit,
        hardLockOnExceed: implementation.hard_lock_on_exceed,
        burn: clone(implementation.budgetBurn)
      });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/budget-overrides$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      const durationHours = Number(body.durationHours);
      const reason = String(body.reason || "").trim();
      if (!reason || !Number.isInteger(durationHours) || durationHours < 1 || durationHours > 24) {
        return Promise.reject(new Error("Enter an override reason and a duration between 1 and 24 hours."));
      }
      const override = {
        id: nextId++, reason,
        expires_at: new Date(Date.now() + durationHours * 3600000).toISOString(),
        created_at: new Date().toISOString()
      };
      implementation.budgetOverrides ||= [];
      implementation.budgetOverrides.push(override);
      return Promise.resolve({ override: clone(override) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/steps\/(\d+)\/time-entries$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      const taskId = Number(match[2]);
      const task = implementation.steps.find((step) => step.id === taskId);
      const minutes = Number(body.minutes);
      if (!task) return Promise.reject(new Error("Task not found in this implementation."));
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        return Promise.reject(new Error("Enter a valid work date and time entry."));
      }
      implementation.timeEntries ||= [];
      const member = data.members.find((item) => item.id === data.user.id) || data.members[0];
      const approvedChangeOrder = (implementation.changeOrders || []).some((order) =>
        order.status === "approved" && (order.task_ids || []).includes(taskId));
      const entry = {
        id: nextId++, implementation_id: implementation.id, task_id: taskId,
        user_id: member.id, user_email: member.email,
        work_date: String(body.workDate || dateOffset(0)), minutes,
        billable: typeof body.isBillable === "boolean" ? body.isBillable : approvedChangeOrder,
        note: String(body.note || "").slice(0, 500),
        internal_cost_rate_snapshot: Number(member.default_internal_cost_rate || 0),
        client_bill_rate_snapshot: Number(member.default_billable_rate || 0),
        labor_cost: minutes / 60 * Number(member.default_internal_cost_rate || 0),
        logged_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      implementation.timeEntries.unshift(entry);
      updateDemoBurn(implementation);
      return Promise.resolve({ entry: clone(entry), burn: clone(implementation.budgetBurn) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/time-entries$/)) && method === "GET") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      return Promise.resolve({ entries: clone(implementation.timeEntries || []) });
    }
    if ((match = path.match(/^\/api\/product\/time-entries\/(\d+)$/)) && method === "DELETE") {
      const entryId = Number(match[1]);
      const implementation = data.implementations.find((item) => item.timeEntries?.some((entry) => entry.id === entryId));
      if (!implementation) return Promise.reject(new Error("Time entry not found."));
      implementation.timeEntries = implementation.timeEntries.filter((entry) => entry.id !== entryId);
      updateDemoBurn(implementation);
      return Promise.resolve({ success: true, burn: clone(implementation.budgetBurn) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/time-entries$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.timeEntries ||= [];
      const member = data.members.find((item) => item.id === data.user.id) || data.members[0];
      const clientBillRate = body.hourlyRate === undefined || body.hourlyRate === ""
        ? Number(member.default_billable_rate || 0) : Number(body.hourlyRate);
      const entry = {
        id: nextId++, user_id: member.id, user_email: member.email, work_date: String(body.workDate || ""),
        minutes: Number(body.minutes || 0), billable: body.billable !== false,
        note: String(body.note || ""), hourly_rate: clientBillRate,
        task_id: body.taskId ? Number(body.taskId) : null,
        internal_cost_rate_snapshot: Number(member.default_internal_cost_rate || 0),
        client_bill_rate_snapshot: clientBillRate,
        labor_cost: Number(body.minutes || 0) / 60 * Number(member.default_internal_cost_rate || 0),
        logged_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      if (!entry.work_date || !Number.isInteger(entry.minutes) || entry.minutes < 1) {
        return Promise.reject(new Error("Enter a valid work date and time entry."));
      }
      implementation.timeEntries.unshift(entry);
      updateDemoBurn(implementation);
      return Promise.resolve({ entry: clone(entry), burn: clone(implementation.budgetBurn) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/approvals$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.approvals ||= [];
      const stageGate = String(body.stageGate || "");
      if (!approvalStageGates.includes(stageGate)) {
        return Promise.reject(new Error("Choose a required stage gate for this approval."));
      }
      if (stageGateOrder.indexOf(stageGate) < stageGateOrder.indexOf(implementation.stage_gate_status || "kickoff")) {
        return Promise.reject(new Error("Choose the current stage or a later stage for this approval."));
      }
      const approval = {
        id: nextId++, title: String(body.title || "").trim(),
        approval_type: String(body.approvalType || "other"),
        stage_gate: stageGate,
        approver_name: String(body.approverName || ""), approver_email: String(body.approverEmail || "").toLowerCase(),
        status: "pending", due_at: String(body.dueAt || ""), created_at: new Date().toISOString()
      };
      if (!approval.title) return Promise.reject(new Error("Enter an approval title."));
      implementation.approvals.unshift(approval);
      return Promise.resolve({ approval: clone(approval) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/approvals\/(\d+)$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      const approval = implementation?.approvals?.find((item) => item.id === Number(match[2]));
      if (!approval) return Promise.reject(new Error("Approval not found."));
      approval.status = String(body.status || approval.status);
      return Promise.resolve({ success: true, status: approval.status });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/approvals\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.approvals = (implementation.approvals || []).filter((approval) => approval.id !== Number(match[2]));
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/time-entries\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.timeEntries = (implementation.timeEntries || []).filter((entry) => entry.id !== Number(match[2]));
      updateDemoBurn(implementation);
      return Promise.resolve({ success: true, burn: clone(implementation.budgetBurn) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/calendar-events$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.calendarEvents ||= [];
      const event = { id: nextId++, title: String(body.title || "").trim(), start_at: String(body.startAt || ""), end_at: String(body.endAt || ""), event_type: String(body.eventType || "meeting"), external_url: String(body.externalUrl || ""), created_at: new Date().toISOString() };
      if (!event.title || !event.start_at) return Promise.reject(new Error("Enter an event title and start time."));
      implementation.calendarEvents.push(event);
      return Promise.resolve({ event: clone(event) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/calendar-events\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.calendarEvents = (implementation.calendarEvents || []).filter((event) => event.id !== Number(match[2]));
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/onboarding-gap-plan$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.communication_channel = String(body.communicationChannel || "").trim();
      implementation.communication_cadence = String(body.communicationCadence || "").trim();
      implementation.communication_owner_name = String(body.communicationOwnerName || "").trim();
      implementation.communication_owner_email = String(body.communicationOwnerEmail || "").trim().toLowerCase();
      implementation.procurement_status = String(body.procurementStatus || "not_started");
      implementation.security_status = String(body.securityStatus || "not_started");
      implementation.security_notes = String(body.securityNotes || "").trim();
      implementation.integration_inventory = String(body.integrationInventory || "").trim();
      implementation.integration_status = String(body.integrationStatus || "not_started");
      implementation.technical_setup_status = String(body.technicalSetupStatus || "not_started");
      implementation.technical_setup_notes = String(body.technicalSetupNotes || "").trim();
      implementation.change_management_status = String(body.changeManagementStatus || "not_started");
      implementation.adoption_notes = String(body.adoptionNotes || "").trim();
      implementation.early_validation_status = String(body.earlyValidationStatus || "not_started");
      implementation.early_validation_notes = String(body.earlyValidationNotes || "").trim();
      implementation.post_launch_support_plan = String(body.postLaunchSupportPlan || "").trim();
      implementation.duplicate_request_control = String(body.duplicateRequestControl || "").trim();
      return Promise.resolve(clone(body));
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/launch-stakeholders$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      const stakeholder = {
        id: nextId++, display_name: String(body.displayName || "").trim(),
        email: String(body.email || "").trim().toLowerCase(), role: String(body.role || "").trim(),
        approval_status: String(body.approvalStatus || "pending"), next_action: String(body.nextAction || "").trim(),
        created_at: new Date().toISOString()
      };
      implementation.launchStakeholders ||= [];
      const existing = implementation.launchStakeholders.find((item) => item.email === stakeholder.email);
      if (existing) Object.assign(existing, stakeholder);
      else implementation.launchStakeholders.push(stakeholder);
      return Promise.resolve({ stakeholder: clone(existing || stakeholder) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/launch-stakeholders\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.launchStakeholders = (implementation.launchStakeholders || [])
        .filter((stakeholder) => stakeholder.id !== Number(match[2]));
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/launch-risks$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      const risk = {
        id: nextId++, category: String(body.category || "Other"), title: String(body.title || "").trim(),
        owner_name: String(body.ownerName || "").trim(), owner_email: String(body.ownerEmail || "").trim().toLowerCase(),
        severity: String(body.severity || "medium"), status: String(body.status || "open"),
        next_action: String(body.nextAction || "").trim(), due_at: String(body.dueAt || ""),
        created_at: new Date().toISOString()
      };
      if (!risk.title) return Promise.reject(new Error("Enter a risk or blocker."));
      implementation.launchRisks ||= [];
      implementation.launchRisks.unshift(risk);
      return Promise.resolve({ risk: clone(risk) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/launch-risks\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.launchRisks = (implementation.launchRisks || [])
        .filter((risk) => risk.id !== Number(match[2]));
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/customer-contacts$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      const email = String(body.email || "").trim().toLowerCase();
      const displayName = String(body.displayName || "").trim();
      if (!implementation || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Promise.reject(new Error("Enter a valid customer contact name and email address."));
      }
      data.customerTokens.delete(implementation.id);
      implementation.has_customer_link = false;
      const token = `local-demo-${nextId++}`;
      const contact = {
        id: nextId++, email, display_name: displayName,
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        invitation_sent_at: null, revoked_at: null, last_activity_at: new Date().toISOString(),
        created_at: new Date().toISOString(), token
      };
      implementation.customerContacts ||= [];
      const existing = implementation.customerContacts.find((item) => item.email === email);
      if (existing) Object.assign(existing, contact);
      else implementation.customerContacts.push(contact);
      savePortalSnapshot(token, implementation, true);
      return Promise.resolve({
        contact: clone((({ token: _token, ...item }) => item)(contact)),
        invitationSent: false,
        customerPortalUrl: `${window.location.origin}/customer.html?token=${encodeURIComponent(token)}&demo=workspace`,
        message: "Sample preview only. No email was sent."
      });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/customer-contacts\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      const contact = implementation?.customerContacts?.find((item) => item.id === Number(match[2]));
      if (!contact) return Promise.reject(new Error("Customer contact not found."));
      contact.revoked_at = new Date().toISOString();
      const portals = readPortalSnapshots();
      delete portals[contact.token];
      window.localStorage.setItem(portalStorageKey, JSON.stringify(portals));
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/messages$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      const message = String(body.body || "").trim();
      if (!implementation || !message || message.length > 4000) return Promise.reject(new Error("Enter a message up to 4,000 characters."));
      const saved = {
        id: nextId++, sender_role: "team", sender_name: data.user.email,
        sender_email: data.user.email, body: message, created_at: new Date().toISOString()
      };
      implementation.customerMessages ||= [];
      implementation.customerMessages.push(saved);
      for (const contact of implementation.customerContacts || []) {
        if (!contact.revoked_at && Date.parse(contact.expires_at) > Date.now()) {
          savePortalSnapshot(contact.token, implementation, true);
        }
      }
      return Promise.resolve({ message: clone(saved) });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/files\/(\d+)$/)) && method === "DELETE") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
      implementation.customerFiles = (implementation.customerFiles || [])
        .filter((file) => file.id !== Number(match[2]));
      for (const contact of implementation.customerContacts || []) savePortalSnapshot(contact.token, implementation, true);
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/customer-link$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation || implementation.archived_at) return Promise.reject(new Error("Implementation not found."));
      const token = `local-demo-${nextId++}`;
      data.customerTokens.set(implementation.id, token);
      implementation.has_customer_link = true;
      savePortalSnapshot(token, implementation);
      return Promise.resolve({ customerPortalToken: token });
    }
    if ((match = path.match(/^\/api\/product\/customer\/([A-Za-z0-9_-]+)$/))) {
      const token = decodeURIComponent(match[1]);
      const implementation = implementationForCustomerToken(token);
      const portal = implementation ? null : findPortalSnapshot(token);
      if (!implementation && !portal) return Promise.reject(new Error("Customer link not found or no longer available."));
      if (method === "GET") {
        const contact = implementation?.customerContacts?.find((item) => item.token === token) || portal?.contact;
        const tasks = implementation
          ? implementation.steps.filter((step) => step.customer_visible).map((step) => ({
            id: step.id, title: step.title, description: step.description, stage: step.stage,
            status: step.status, due_at: step.due_at, is_blocked: step.is_blocked,
            blocker_reason: step.blocker_reason, blocker_next_action: step.blocker_next_action,
            waiting: Boolean(step.waiting_on)
          }))
          : (portal.tasks || []).map((step) => ({
            id: step.id, title: step.title, description: step.description, stage: step.stage,
            status: step.status, due_at: step.due_at, is_blocked: step.is_blocked,
            blocker_reason: step.blocker_reason, blocker_next_action: step.blocker_next_action,
            waiting: Boolean(step.waiting)
          }));
        const milestones = [...new Set(tasks.map((task) => task.stage))].map((stage) => {
          const stageTasks = tasks.filter((task) => task.stage === stage);
          return {
            name: stage,
            total: stageTasks.length,
            completed: stageTasks.filter((task) => task.status === "done").length
          };
        });
        return Promise.resolve({
          customerName: implementation?.customer_name || portal.customerName,
          customerOwnerName: implementation?.customer_owner_name || portal.customerOwnerName || "",
          customerOwnerEmail: implementation?.customer_owner_email || portal.customerOwnerEmail || "",
          targetLaunchDate: implementation?.target_launch_date || portal.targetLaunchDate || "",
          successCriteria: implementation?.success_criteria || portal.successCriteria || "",
          acceptanceStatus: implementation?.acceptance_status || portal.acceptanceStatus || "not_started",
          testPlan: implementation?.test_plan || portal.testPlan || "",
          trainingStatus: implementation?.training_status || portal.trainingStatus || "not_started",
          supportOwnerName: implementation?.support_owner_name || portal.supportOwnerName || "",
          supportOwnerEmail: implementation?.support_owner_email || portal.supportOwnerEmail || "",
          rollbackPlan: implementation?.rollback_plan || portal.rollbackPlan || "",
          goLiveStatus: implementation?.go_live_status || portal.goLiveStatus || "not_ready",
          communicationChannel: implementation?.communication_channel || portal.communicationChannel || "",
          communicationCadence: implementation?.communication_cadence || portal.communicationCadence || "",
          communicationOwnerName: implementation?.communication_owner_name || portal.communicationOwnerName || "",
          communicationOwnerEmail: implementation?.communication_owner_email || portal.communicationOwnerEmail || "",
          procurementStatus: implementation?.procurement_status || portal.procurementStatus || "not_started",
          securityStatus: implementation?.security_status || portal.securityStatus || "not_started",
          integrationStatus: implementation?.integration_status || portal.integrationStatus || "not_started",
          technicalSetupStatus: implementation?.technical_setup_status || portal.technicalSetupStatus || "not_started",
          changeManagementStatus: implementation?.change_management_status || portal.changeManagementStatus || "not_started",
          earlyValidationStatus: implementation?.early_validation_status || portal.earlyValidationStatus || "not_started",
          postLaunchSupportPlan: implementation?.post_launch_support_plan || portal.postLaunchSupportPlan || "",
          accessRole: contact ? "primary" : "viewer",
          projectedGoLiveDate: implementation?.projected_go_live_date || implementation?.target_launch_date || portal?.targetLaunchDate || "",
          goLiveShifts: implementation?.goLiveShifts || portal?.goLiveShifts || [],
          changeOrders: implementation?.changeOrders || portal?.changeOrders || [],
          delegations: implementation?.delegations || portal?.delegations || [],
          contact: contact ? {
            id: contact.id, name: contact.display_name || contact.name,
            email: contact.email, expiresAt: contact.expires_at || contact.expiresAt
          } : null,
          requirements: clone(implementation?.requirements || portal.requirements),
          tasks,
          milestones,
          messages: clone(implementation?.customerMessages || portal.messages || []),
          files: clone(implementation?.customerFiles || portal.files || []),
          progress: tasks.length ? Math.round((tasks.filter((task) => task.status === "done").length / tasks.length) * 100) : null
        });
      }
      if (method === "POST") {
        const inputs = body.inputs === undefined ? [] : body.inputs;
        const completedStepIds = body.completedStepIds === undefined ? [] : body.completedStepIds;
        if (!Array.isArray(inputs) || inputs.length > 50) {
          return Promise.reject(new Error("Submit a valid list of information."));
        }
        if (!Array.isArray(completedStepIds) || completedStepIds.length > 200) {
          return Promise.reject(new Error("Submit a valid list of customer tasks."));
        }
        const submitted = new Map();
        for (const input of inputs) {
          const requirementId = Number(input?.requirementId);
          const requirements = implementation?.requirements || portal.requirements;
          const requirement = requirements.find((item) => item.id === requirementId);
          if (!requirement || submitted.has(requirementId) || typeof input.value !== "string" || input.value.length > 2000) {
            return Promise.reject(new Error("One or more submitted fields are invalid."));
          }
          const value = input.value.trim();
          const error = validateCustomerValue(requirement, value);
          if (error) return Promise.reject(new Error(`${requirement.name}: ${error}`));
          submitted.set(requirementId, value);
        }
        const requirements = implementation?.requirements || portal.requirements;
        const missing = (inputs.length || completedStepIds.length === 0)
          ? requirements.find((requirement) => requirement.required
            && !(submitted.has(requirement.id) ? submitted.get(requirement.id) : requirement.value).trim())
          : null;
        if (missing) return Promise.reject(new Error(`Required information is missing: ${missing.name}.`));
        const taskIds = completedStepIds.map(Number);
        const availableTasks = implementation
          ? implementation.steps.filter((step) => step.customer_visible)
          : (portal.tasks || []);
        if (taskIds.some((id) => !Number.isSafeInteger(id) || id < 1)
          || new Set(taskIds).size !== taskIds.length
          || taskIds.some((id) => !availableTasks.some((task) => task.id === id))) {
          return Promise.reject(new Error("One or more customer tasks are unavailable."));
        }
        if (taskIds.some((id) => {
          const task = availableTasks.find((item) => item.id === id);
          return Boolean(task?.waiting_on || task?.waiting || task?.is_blocked);
        })) {
          return Promise.reject(new Error("This task is blocked or waiting for a prerequisite. Message your implementation team for the next update."));
        }
        for (const [requirementId, value] of submitted) {
          const requirement = requirements.find((item) => item.id === requirementId);
          requirement.value = value;
        }
        for (const taskId of taskIds) {
          const task = availableTasks.find((item) => item.id === taskId);
          task.status = "done";
          task.updated_at = new Date().toISOString();
          if (task.dependsOn && implementation) {
            const implementationStep = implementation.steps.find((item) => item.id === taskId);
            if (implementationStep) implementationStep.status = "done";
          }
        }
        if (implementation) updateWaitingTasks(implementation);
        if (implementation) savePortalSnapshot(token, implementation, Boolean(
          implementation.customerContacts?.some((contact) => contact.token === token)
        ));
        else {
          portal.tasks = availableTasks;
          window.localStorage.setItem(portalStorageKey, JSON.stringify({ ...readPortalSnapshots(), [token]: portal }));
        }
        return Promise.resolve({ success: true });
      }
    }
    if ((match = path.match(/^\/api\/product\/customer\/([A-Za-z0-9_-]+)\/messages$/)) && method === "POST") {
      const token = decodeURIComponent(match[1]);
      const implementation = implementationForCustomerToken(token);
      const bodyText = String(body.body || "").trim();
      if (!implementation || !bodyText || bodyText.length > 4000) {
        return Promise.reject(new Error("Enter a message up to 4,000 characters."));
      }
      const contact = implementation.customerContacts?.find((item) => item.token === token);
      const message = {
        id: nextId++, sender_role: "customer",
        sender_name: contact?.display_name || "Customer",
        body: bodyText, created_at: new Date().toISOString()
      };
      implementation.customerMessages ||= [];
      implementation.customerMessages.push(message);
      savePortalSnapshot(token, implementation, Boolean(contact));
      return Promise.resolve({ message: clone(message) });
    }
    if ((match = path.match(/^\/api\/product\/customer\/([A-Za-z0-9_-]+)\/files$/)) && method === "POST") {
      const token = decodeURIComponent(match[1]);
      const implementation = implementationForCustomerToken(token);
      const filename = String(body.filename || "");
      const type = String(body.contentType || "");
      const size = Number(body.size);
      const extension = filename.toLowerCase().split(".").pop();
      const allowed = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
      if (!implementation || allowed[extension] !== type || !Number.isInteger(size) || size < 1 || size > 5 * 1024 * 1024) {
        return Promise.reject(new Error("Upload a PDF, PNG, or JPG file no larger than 5 MB."));
      }
      const currentFiles = implementation.customerFiles || [];
      const totalBytes = currentFiles.reduce((total, file) => total + Number(file.size_bytes || 0), 0);
      if (currentFiles.length >= 20 || totalBytes + size > 25 * 1024 * 1024) {
        return Promise.reject(new Error("This implementation can store up to 20 files and 25 MB total."));
      }
      const file = {
        id: nextId++, uploaded_by_role: "customer", uploaded_by_name: "Customer",
        filename, content_type: type, size_bytes: size, created_at: new Date().toISOString(), demo: true
      };
      implementation.customerFiles ||= [];
      implementation.customerFiles.unshift(file);
      const contact = implementation.customerContacts?.find((item) => item.token === token);
      savePortalSnapshot(token, implementation, Boolean(contact));
      return Promise.resolve({ file: clone(file) });
    }
    if ((match = path.match(/^\/api\/product\/customer\/([A-Za-z0-9_-]+)\/renew$/)) && method === "POST") {
      return Promise.resolve({
        message: "Sample preview only. No email was sent; return to the workspace to copy a sample invitation link."
      });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/steps\/(\d+)$/)) && method === "PATCH") {
      const implementation = findImplementation(match[1]);
      const step = implementation?.steps.find((item) => item.id === Number(match[2]));
      if (!step) return Promise.reject(new Error("Implementation task not found."));
      if (body.isBlocked && (!String(body.blockerReason || "").trim() || !String(body.blockerNextAction || "").trim())) {
        return Promise.reject(new Error("Add blocker details and a next action before saving."));
      }
      if (body.status === "done" && step.waiting_on) return Promise.reject(new Error(`Complete prerequisite “${step.waiting_on}” before marking this task done.`));
      Object.assign(step, {
        status: body.status, owner: body.owner, assignee_user_id: body.assigneeUserId ? Number(body.assigneeUserId) : null,
        assignee_email: data.members.find((member) => member.id === Number(body.assigneeUserId))?.email || null,
        customer_visible: body.customerVisible === true,
        due_at: body.dueAt, is_blocked: body.isBlocked,
        blocker_reason: body.isBlocked ? body.blockerReason : "",
        blocker_next_action: body.isBlocked ? body.blockerNextAction : "",
        updated_at: new Date().toISOString()
      });
      updateWaitingTasks(implementation);
      return Promise.resolve({ success: true });
    }
    if (path === "/api/product/requirements" && method === "POST") {
      if (data.requirements.length >= 50) return Promise.reject(new Error("A workspace can have up to 50 customer information requests."));
      const requirement = {
        id: nextId++, name: String(body.name || "").trim(), description: String(body.description || "").trim(),
        required: body.required !== false, input_type: body.inputType || "text",
        template_id: body.templateId ? Number(body.templateId) : null
      };
      data.requirements.push(requirement);
      for (const implementation of data.implementations) {
        if (!requirement.template_id || implementation.template_id === requirement.template_id) {
          implementation.requirements.push({ ...clone(requirement), value: "" });
        }
      }
      return Promise.resolve({ requirement: clone(requirement) });
    }
    if ((match = path.match(/^\/api\/product\/requirements\/(\d+)$/)) && method === "PATCH") {
      const requirement = data.requirements.find((item) => item.id === Number(match[1]));
      if (!requirement) return Promise.reject(new Error("Customer information request not found."));
      Object.assign(requirement, {
        name: String(body.name || "").trim(), description: String(body.description || "").trim(),
        input_type: body.inputType, required: body.required
      });
      for (const implementation of data.implementations) {
        const instance = implementation.requirements.find((item) => item.id === requirement.id);
        if (instance) Object.assign(instance, clone(requirement));
      }
      return Promise.resolve({ success: true });
    }
    if ((match = path.match(/^\/api\/product\/requirements\/(\d+)$/)) && method === "DELETE") {
      const requirementId = Number(match[1]);
      data.requirements = data.requirements.filter((item) => item.id !== requirementId);
      for (const implementation of data.implementations) {
        implementation.requirements = implementation.requirements.filter((item) => item.id !== requirementId);
      }
      return Promise.resolve({ success: true });
    }
    return Promise.reject(new Error(`Local demo does not implement ${method} ${path}. No server request was sent.`));
  }

  window.relayWorkspaceDemo = { request };
})();
