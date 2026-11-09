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
    onboardingDismissed: false,
    members: [
      { id: ownerId, email: "owner@demo.invalid", role: "owner" },
      { id: memberId, email: "teammate@demo.invalid", role: "member" }
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
      steps: [
        {
          id: 9011, title: "Confirm project goals", description: "Agree on success measures and the project owner.",
          owner: "Implementation lead", position: 1, stage: "Kickoff", due_offset_days: 0,
          assignee_user_id: ownerId, assignee_email: "owner@demo.invalid", customer_visible: true, dependsOn: []
        },
        {
          id: 9012, title: "Configure the workspace", description: "Set up the workspace using the confirmed project requirements.",
          owner: "Setup specialist", position: 2, stage: "Configuration", due_offset_days: 3,
          assignee_user_id: memberId, assignee_email: "teammate@demo.invalid", customer_visible: true, dependsOn: [9011]
        },
        {
          id: 9013, title: "Review launch readiness", description: "Review configuration with the customer and record open questions.",
          owner: "Implementation lead", position: 3, stage: "Launch", due_offset_days: 7,
          assignee_user_id: ownerId, assignee_email: "owner@demo.invalid", customer_visible: false, dependsOn: [9012]
        }
      ]
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
      id: 9040, template_id: 9020, customer_name: "Acme Example Co.", template_name: "Standard onboarding",
      created_at: new Date().toISOString(), has_customer_link: true,
      steps: [
        {
          id: 9041, title: "Confirm project goals", description: "Agree on success measures and the project owner.",
          owner: "Implementation lead", position: 1, status: "done", updated_at: new Date().toISOString(),
          stage: "Kickoff", assignee_user_id: ownerId, assignee_email: "owner@demo.invalid",
          customer_visible: true,
          due_at: dateOffset(-2), is_blocked: false, blocker_reason: "", blocker_next_action: "", waiting_on: ""
        },
        {
          id: 9042, title: "Configure the workspace", description: "Set up the workspace using the confirmed project requirements.",
          owner: "Setup specialist", position: 2, status: "in_progress", updated_at: new Date().toISOString(),
          stage: "Configuration", assignee_user_id: memberId, assignee_email: "teammate@demo.invalid",
          customer_visible: true,
          due_at: dateOffset(2), is_blocked: false, blocker_reason: "", blocker_next_action: "", waiting_on: "", dependsOn: [9041]
        },
        {
          id: 9043, title: "Review launch readiness", description: "Review configuration with the customer and record open questions.",
          owner: "Implementation lead", position: 3, status: "not_started", updated_at: new Date().toISOString(),
          stage: "Launch", assignee_user_id: ownerId, assignee_email: "owner@demo.invalid",
          customer_visible: false,
          due_at: dateOffset(7), is_blocked: false, blocker_reason: "", blocker_next_action: "", waiting_on: "Configure the workspace", dependsOn: [9042]
        }
      ],
      requirements: [
        { id: 9030, name: "Project contact email", description: "Who should receive setup updates?", required: true, input_type: "email", value: "" },
        { id: 9031, name: "Current website", description: "Share the website URL to use during setup.", required: false, input_type: "url", value: "https://acme.example" }
      ]
    }],
    customerTokens: new Map(),
    helpMessages: []
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
    const blocked = open.filter((step) => step.is_blocked);
    const overdue = open.filter((step) => step.due_at && step.due_at < dateOffset(0));
    const waiting = open.filter((step) => step.waiting_on);
    const unowned = open.filter((step) => !step.assignee_user_id);
    return {
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
      invalid_inputs: 0,
      invalid_input_names: "",
      blocked_steps: blocked.length,
      blocked_step_names: blocked.map((step) => step.title).join(", "),
      overdue_steps: overdue.length,
      overdue_step_names: overdue.map((step) => step.title).join(", "),
      waiting_steps: waiting.length,
      waiting_step_names: waiting.map((step) => step.title).join(", ")
    };
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
      implementations: data.implementations.map(summarizeImplementation),
      requirements: clone(data.requirements),
      members: clone(data.members),
      invites: clone(data.invites),
      teamWorkload: data.members.map((member) => {
        const tasks = data.implementations.flatMap((implementation) => implementation.steps)
          .filter((step) => step.assignee_user_id === member.id && step.status !== "done");
        return {
          id: member.id,
          email: member.email,
          open_tasks: tasks.length,
          overdue_tasks: tasks.filter((step) => step.due_at && step.due_at < dateOffset(0)).length
        };
      }),
      notificationSettings: clone(data.notificationSettings),
      integrations: [],
      role: "owner"
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

  function responseForImplementation(implementation) {
    if (!implementation) throw new Error("Implementation not found in the local demo data.");
    applyPortalValues(implementation);
    return { implementation: clone(implementation) };
  }

  function readPortalSnapshots() {
    const stored = window.localStorage.getItem(portalStorageKey);
    return stored ? JSON.parse(stored) : {};
  }

  function savePortalSnapshot(token, implementation) {
    const portals = readPortalSnapshots();
    const previousPortal = Object.values(portals)
      .find((portal) => portal.implementationId === implementation.id);
    if (previousPortal) {
      for (const savedRequirement of previousPortal.requirements) {
        const requirement = implementation.requirements.find((item) => item.id === savedRequirement.id);
        if (requirement) requirement.value = savedRequirement.value;
      }
    }
    for (const [savedToken, portal] of Object.entries(portals)) {
      if (portal.implementationId === implementation.id) delete portals[savedToken];
    }
    portals[token] = {
      implementationId: implementation.id,
      customerName: implementation.customer_name,
      requirements: clone(implementation.requirements),
      tasks: implementation.steps.filter((step) => step.customer_visible).map((step) => ({
        id: step.id,
        title: step.title,
        description: step.description,
        stage: step.stage,
        status: step.status,
        due_at: step.due_at,
        waiting: Boolean(step.waiting_on),
        dependsOn: clone(step.dependsOn || [])
      }))
    };
    window.localStorage.setItem(portalStorageKey, JSON.stringify(portals));
  }

  function findPortalSnapshot(token) {
    return readPortalSnapshots()[token] || null;
  }

  function implementationForCustomerToken(token) {
    return data.implementations.find((implementation) => data.customerTokens.get(implementation.id) === token);
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
      const invite = { id: nextId++, invited_email: email, expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), created_at: new Date().toISOString() };
      data.invites.unshift(invite);
      return Promise.resolve({ invite: { ...clone(invite), inviteUrl: `${window.location.origin}/product.html?invite=local-demo-${invite.id}` } });
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
      if (!process.steps.length) findings.push("Add at least one step before handing over this process.");
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
        steps: template.steps.map((step, index) => ({
          id: nextId++, title: step.title, description: step.description, owner: step.owner,
          position: index + 1, status: "not_started", updated_at: new Date().toISOString(),
          stage: step.stage, assignee_user_id: step.assigneeUserId || null, assignee_email: step.assigneeEmail || null,
          customer_visible: step.customerVisible === true,
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
      const token = `local-demo-${nextId++}`;
      data.customerTokens.set(implementation.id, token);
      savePortalSnapshot(token, implementation);
      implementation.has_customer_link = true;
      data.implementations.unshift(implementation);
      return Promise.resolve({ implementation: clone(implementation), customerPortalToken: token });
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)$/)) && method === "GET") {
      return Promise.resolve(responseForImplementation(findImplementation(match[1])));
    }
    if ((match = path.match(/^\/api\/product\/implementations\/(\d+)\/customer-link$/)) && method === "POST") {
      const implementation = findImplementation(match[1]);
      if (!implementation) return Promise.reject(new Error("Implementation not found."));
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
        const tasks = implementation
          ? implementation.steps.filter((step) => step.customer_visible).map((step) => ({
            id: step.id, title: step.title, description: step.description, stage: step.stage,
            status: step.status, due_at: step.due_at, waiting: Boolean(step.waiting_on)
          }))
          : (portal.tasks || []).map((step) => ({
            id: step.id, title: step.title, description: step.description, stage: step.stage,
            status: step.status, due_at: step.due_at, waiting: Boolean(step.waiting)
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
          requirements: clone(implementation?.requirements || portal.requirements),
          tasks,
          milestones,
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
          return Boolean(task?.waiting_on || task?.waiting);
        })) {
          return Promise.reject(new Error("Complete the prerequisite steps before marking this task done."));
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
        if (implementation) savePortalSnapshot(token, implementation);
        else {
          portal.tasks = availableTasks;
          window.localStorage.setItem(portalStorageKey, JSON.stringify({ ...readPortalSnapshots(), [token]: portal }));
        }
        return Promise.resolve({ success: true });
      }
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
