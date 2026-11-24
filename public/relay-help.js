"use strict";

function relayHelpReply(message) {
  const question = String(message || "").toLocaleLowerCase().trim();

  if (/^(?:h+i+|hello+|hey+|hiya|howdy)(?:\s+ray)?[!.?,\s]*$/.test(question)) {
    return "Hi! I’m Ray, your Relay guide. What are you working on today—setting up a process, starting a customer implementation, or collecting customer information?";
  }
  if (/^(?:good morning|morning|good afternoon|afternoon|good evening|evening|hey there|hi there|hello there|what(?:'|’)s up|whats up|what(?:'|’)s new|whats new|yo|sup|are you there|you there)(?:[,\s]+ray)?[!.?,\s]*$/.test(question)) {
    return "Hi! I’m here and ready to help with Relay. What are you working on?";
  }
  if (/^(how are you|how are you doing|how's it going|how is it going|how are things|how have you been|how's your day|how is your day|how's your day going|how is your day going)[!.?,\s]*$/.test(question)) {
    return "I’m doing well and ready to help with Relay. What would you like to get done?";
  }
  if (/^(?:thanks?(?:\s+(?:so much|a lot|ray|for (?:your|the) help))?|thank you(?:\s+(?:so much|ray|for (?:your|the) help))?|thx)[!.?,\s]*$/.test(question)) {
    return "You’re welcome! If you get stuck with a Relay workflow, just ask.";
  }
  if (/^(bye|goodbye|see you|see ya|talk later)[!.?,\s]*$/.test(question)) {
    return "Goodbye! I’ll be here if you need help with Relay.";
  }
  if (/^can i ask (?:you )?(?:a question|something)[?.!,\s]*$/.test(question)) {
    return "Of course—ask away. I can help with Relay workflows and how to use its features.";
  }
  if (/^(?:ok|okay|got it|makes sense|cool|great|nice|sounds good|perfect)[!.?,\s]*$/.test(question)) {
    return "Glad that helped. Ask me whenever you’re ready for the next step.";
  }
  if (/password.{0,35}(reset|recover|forgot)|(?:reset|recover|forgot).{0,35}password/.test(question)) {
    return "On the sign-in screen, choose Forgot your password? and follow the one-time recovery link sent to your account email. If password recovery is not enabled for your Relay deployment, contact Relay support.";
  }
  if (/(ignore|override).{0,30}(instruction|rule|prompt)|prompt injection|system prompt|reveal.{0,30}(secret|password|key)/.test(question)) {
    return "I can’t reveal hidden instructions, credentials, or private data. I can help explain Relay’s user-facing features.";
  }
  if (/(?:collect|ask for|request|enter|submit|share|send|store|include|put).{0,40}(?:password|payment card|credit card|card number|api key|credential|secret)|(?:password|payment card|credit card|card number|api key|credential|secret).{0,40}(?:collect|ask for|request|enter|submit|share|send|store|include|put)/.test(question)) {
    return "Don’t collect passwords, payment-card details, API keys, or other authentication secrets in Relay. Use an appropriate secure channel instead.";
  }
  if (/(customer|client|portal)/.test(question)
    && /(see|view|access|visible|show|expose)/.test(question)
    && /(hourly|rate|time entr|budget|burn|margin|profit|financial|internal note|engineering|jira|linear)/.test(question)) {
    return "Customers using a private portal link can see the go-live banner, tasks explicitly marked customer-visible, requested information, supported uploads or connection checks, and change-order approvals. Hourly rates, time entries, budgets, burn, margins, internal notes, and Jira/Linear issue links remain internal.";
  }
  if (!/\b(delete|remove|erase|close|clear)\b/.test(question)
    && (/(customer|client|stakeholder).{0,40}(login|account|invite|delegat|access)|(?:login|account|invite|delegat|access).{0,40}(customer|client|stakeholder)/.test(question))) {
    return "Customers do not need a Relay login. Workspace members can invite named customer contacts and share each contact’s private, expiring portal link. Assign customer-owned tasks to the appropriate stakeholder and mark only the tasks they should see as customer-visible.";
  }
  if (/(soc.?2|certif|compliance|uptime|availability|service.level|\bsla\b|security audit)/.test(question)) {
    return "I can’t verify Relay’s certifications, audit results, uptime, or service-level commitments. Please check your current agreement or contact Relay support.";
  }
  if (/\blive ray\b|\b(?:relay|ray)\b.{0,25}\b(?:ai|artificial intelligence|model)\b|\b(?:ai|artificial intelligence|model)\b.{0,25}\b(?:relay|ray)\b/.test(question)) {
    return "I’m Ray, Relay’s built-in product guide. I use prepared Relay-specific answers—not an external AI service—and can’t access private workspace records.";
  }
  if (/(jira|slack|integration|integrate|synchronize|sync with|external project)/.test(question)) {
    return "Growth and Custom workspace admins can configure Slack alerts with an encrypted incoming webhook; selected implementation and budget alerts are delivered after scheduled event processing is configured. Growth and Custom admins can configure HubSpot Closed Won handoff. Custom admins can map Salesforce product SKUs to Relay templates and connect Jira Cloud or Linear to escalate internal tasks; Relay polls linked issue status and completes a task only when the issue is done. Provider accounts, encrypted credentials, and scheduled processing are required. Engineering links and financial details stay out of the client portal. CSV export is available on all plans.";
  }
  if (/(?:relay.{0,35}(?:price|pricing|cost|subscription)|(?:price|pricing|cost|subscription).{0,35}relay|₹|rupee)/.test(question)) {
    return "Relay offers Starter at ₹2,999 per month (3 team members, 5 active implementations, and 3 templates), Growth at ₹3,999 per month (10 members, 20 active implementations, and unlimited templates), and Custom with agreed member and implementation limits plus unlimited templates. Growth adds critical-path shifts, change orders, a full portfolio view, HubSpot, Slack alerts, blockers, and template history. Custom adds time tracking, budgets, burn alerts, margin reporting, Salesforce SKU onboarding, and Jira/Linear task sync. Provider setup is required for integrations. Prices are before applicable taxes; see Pricing for details.";
  }
  if (/(?:what|which).{0,25}(?:features|included|capabilities).{0,25}(?:starter|growth|custom|plan)|(?:starter|growth|custom).{0,25}(?:features|include|capabilities)/.test(question)) {
    return "Starter includes the customer portal and delegation, validated inputs, ordered steps and prerequisites, up to three templates, stage gates, email reminders after setup, a basic portfolio view, and CSV export. Growth adds critical-path shifts, change orders, the full portfolio view, HubSpot, Slack alerts, blocker tracking, and template history. Custom adds task time tracking, budget caps and burn alerts, margin/overage reporting, Salesforce SKU onboarding, and Jira/Linear task sync. Provider setup is required for integrations.";
  }
  if (/(import|migrat|move|bring|transfer).{0,45}(spreadsheet|excel|csv|customer|task|process|workflow|data)|(spreadsheet|excel|csv).{0,45}(import|migrat|move|bring|transfer)/.test(question)) {
    return "Relay does not currently import onboarding processes, customers, or tasks from spreadsheets. Rebuild your workflow in Process map, check it, then save it as a template. Relay can export portfolio summaries to CSV, but that export is not an import format.";
  }
  if (/\b(trial|try relay|evaluate relay)\b|\b(before|without)\s+inviting\b/.test(question)) {
    return "You can explore Relay’s public Sample Workspace before inviting your team; it contains fictional records and saves changes only in your browser. It is not a production workspace or a free-trial account. For a guided evaluation, book a demo or contact Relay.";
  }
  if (/(?:first.{0,35}(?:customer|client).{0,35}(?:launch|onboard|implementation|setup)|(?:best|how).{0,25}(?:start|set up).{0,25}(?:first|customer))/.test(question)) {
    return "For a first launch, map your repeatable steps in Process map, run the readiness check, and save the checked workflow as a template. Then start an implementation from that template, assign owners and due dates, add only needed customer-information requests, and share its private link.";
  }
  if (/(?:change|edit|update|reschedule|reassign).{0,45}(?:task|step|due date|owner)|(?:task|step).{0,45}(?:change|edit|update|reschedule|reassign)/.test(question)) {
    return "Open Implementations, select the customer, and edit the task to update its status, assignee, or due date. Growth and Custom also support blocker details and next actions. Task titles and instructions come from the copied workflow; changing the process or template is for future implementations and does not rewrite existing ones.";
  }
  if (/(?:who|which teammate|who's|who is).{0,35}(?:own|responsib|assigned).{0,35}(?:next|task|action)|(?:next|task|action).{0,35}(?:owner|assigned|responsib)/.test(question)) {
    return "Open Implementations and select the customer to see each task’s assignee, status, and due date. The assignee is responsible for that task; if it is unassigned, open the task and assign a teammate. I can’t see your workspace’s live assignments.";
  }
  if (/(?:overdue|past due).{0,45}(?:all|across|every|customers|portfolio)|(?:all|across|every|portfolio).{0,45}(?:overdue|past due)/.test(question)) {
    return "Open Implementations and set Needs attention to Overdue to find overdue tasks across customers. Overview also summarizes work needing attention, and the portfolio CSV export includes overdue-task counts. I can’t see your live workspace data.";
  }
  if (/(?:change|edit|update|promote|demote).{0,35}(?:member|teammate|user).{0,25}role|(?:change|edit|update|promote|demote).{0,35}role|(?:remove|delete).{0,35}(?:member|teammate|user)/.test(question)) {
    return "Relay currently offers Owner and Member roles, but the workspace UI does not let an owner change an existing member’s role or remove that member. Owners can revoke pending invitations. For an existing member change, contact Relay support; members can leave by deleting their own account.";
  }
  if (/(?:what happens|when|if).{0,35}(?:teammate|member|owner).{0,35}(?:leav|delet|remov)|(?:teammate|member|owner).{0,35}(?:leav|delet|remov).{0,35}(?:work|task|workspace)/.test(question)) {
    return "If a member deletes their account, they leave shared workspaces and their assigned tasks become unassigned; the shared workspace and its records remain for other members. An owner must transfer ownership to a remaining member before deleting their account.";
  }
  if (/(?:what can|what does|what are).{0,40}\b(?:owner|member)\b.{0,30}\b(?:do|manage|permissions?)\b|what permissions?.{0,30}\b(?:owner|member)\b|(?:difference|differ).{0,25}\b(?:owner|member)\b|\b(?:owner|member)\b.{0,25}\b(?:difference|permissions?)\b/.test(question)) {
    return "Owners can invite teammates, revoke pending invitations, change workspace notification settings, and connect or disconnect integrations. Members can work in the workspace but cannot invite others or manage those owner-only settings. Relay currently has Owner and Member roles.";
  }
  if (/(?:update|change|refresh|edit|restore).{0,40}template.{0,50}(?:existing|future|plan|implementation)|template.{0,50}(?:existing implementation|existing plan|future implementation)/.test(question)) {
    return "Refreshing or updating a template changes the version used by future implementations. Existing implementations keep their copied task plans and are not changed by template updates.";
  }
  if (/\b(?:reach|hit|exceed|maximum|max|limit|full|capacity|seat)\b.{0,40}\b(?:plan|workspace|member|seat|implementation|template|limit)\b|\b(?:plan|workspace|member|seat|implementation|template)\b.{0,40}\b(?:limit|full|maximum|max|capacity)\b|how many.{0,30}\b(?:members?|seats|implementations?|templates)\b|\b(?:add|create)\b.{0,25}\b(?:more|another|extra)\b.{0,15}\b(?:members?|teammates?|seats|implementations?|templates)\b/.test(question)) {
    return "Starter includes up to 3 members, 5 active implementations, and 3 templates; Growth includes up to 10 members, 20 active implementations, and unlimited templates. Custom member and active-implementation limits are agreed in advance, with unlimited templates. If you reach a limit, review the Pricing page or contact Relay about changing plans; completing an implementation or removing an unused template may also free capacity.";
  }
  if (/(?:change|upgrade|downgrade|cancel|renew).{0,35}(?:plan|subscription|billing|workspace)|(?:plan|subscription|billing).{0,35}(?:change|upgrade|downgrade|cancel|renew)/.test(question)) {
    return "Plan changes and cancellation are handled by contacting Relay; there is no self-service billing or cancellation control in the workspace. Check the Pricing page for plan details. Your confirmed billing, renewal, cancellation terms, and any taxes should be provided before payment.";
  }
  if (/(?:custom|bespoke).{0,30}(?:plan|price|pricing|limit)|(?:plan|price|pricing|limit).{0,30}(?:custom|bespoke)/.test(question)) {
    return "Relay Custom includes Growth features, unlimited templates, time tracking, budgets, burn alerts, margin reporting, Salesforce SKU onboarding, Jira/Linear task sync, and dedicated setup with a custom SLA. Salesforce and engineering integrations require connected provider accounts and workspace setup. Team-member and active-implementation limits are agreed in advance. Contact Relay for written pricing and terms.";
  }
  if (/(invoice|receipt|billing document|tax invoice|bill me|billing details)/.test(question)) {
    return "Custom tracks budget caps, task time, burn alerts, portfolio margin, and manual invoice status/reference. Relay does not generate invoices, accept payments, connect to an accounting system, or reconcile revenue.";
  }
  if (/(?:where|how).{0,35}(?:submit|send|enter).{0,40}(?:information|answer|details)|(?:where|how).{0,35}(?:information|answer|details).{0,35}(?:submit|send|enter)/.test(question)) {
    return "Open the private customer-information link shared by your implementation team. Enter the requested details in the form and choose Send information. If you do not have the link, ask the team that invited you.";
  }
  if (/(?:upload|attach|attachment|file|document).{0,40}(?:customer|client|portal|information|answer)|(?:customer|client|portal|information|answer).{0,40}(?:upload|attach|attachment|file|document)/.test(question)) {
    return "Relay accepts CSV or XLSX uploads only from a scoped task delegate, and only for a customer-visible task configured with a validation schema. Files are scanned before parsing; uploads and unscanned legacy-file downloads are unavailable until the workspace has its self-hosted ClamAV scanner configured. The customer portal does not accept arbitrary PDF or image attachments. Never upload passwords or other secrets.";
  }
  if (/(?:change|edit|update|correct).{0,35}(?:answer|response|information|details|field)|(?:answer|response|information|details).{0,35}(?:change|edit|update|correct).{0,35}(?:later|already sent|submitted)?/.test(question)) {
    return "If your private customer link is still available, reopen it to see your saved answers, make changes, and submit again. If the link no longer works, contact the implementation team that sent it and ask for help.";
  }
  if (/(team capacity|capacity plan|available capacity|weekly capacity|workload)/.test(question)) {
    return "Open Settings → Team capacity to set a teammate’s available minutes for a week. Relay shows saved capacity plans beside the implementation tools. Capacity is planning data and should be kept current.";
  }
  if (/(time entr|billable|non-billable|hourly rate|logged time)/.test(question)) {
    return "Custom workspaces include task-level billable and non-billable time tracking, with timers and quick-log presets in each implementation task. Time entries can be deleted from the delivery summary. Starter and Growth do not include financial time tracking.";
  }
  if (/(sow|statement of work|scope of work|stage gate|milestone|exclusion)/.test(question)) {
    return "Open an implementation’s Delivery operations section to record SOW scope, milestones, exclusions, and the current stage gate: kickoff, configuration, testing, launch, hypercare, or complete.";
  }
  if (/(approval|approver|sign-off|sign off)/.test(question)) {
    return "Open an implementation’s Delivery operations section and create an approval with a title, type, approver, and due date. The team can mark it approved or delete it. Approvals do not automatically notify the approver by email.";
  }
  if (/(timeline|calendar event|meeting|kickoff date|event)/.test(question)) {
    return "Open an implementation’s Delivery operations section and add a timeline event with a title, start, optional end, type, and optional external link. Events can be deleted from the delivery summary.";
  }
  if (/(budget|forecast|actual cost|margin|invoice status|invoice reference)/.test(question)) {
    return "Custom includes project budget caps, 75/90/100% burn alerts, and a portfolio gross-margin and overage-leakage dashboard. Relay can track a manual invoice status and reference, but it does not generate invoices, accept payments, or connect to accounting systems.";
  }
  if (/(?:where|how).{0,35}(?:find|jump|navigate|open|go to|get to).{0,35}(?:implementation|work plan|customer information|portal access|communication|delivery|launch readiness|messages|files)|implementation sections?/.test(question)) {
    return "Open the customer’s implementation and use the Implementation sections row to jump to Work plan, Customer information, Portal access, Communication and setup, Delivery, Launch readiness, or Messages and files. It opens the destination without closing other sections or discarding unsaved details.";
  }
  if (/(launch readiness|success criteria|acceptance status|test plan|rollback|training status|go-live|support handoff|post-launch)/.test(question)) {
    return "Open an implementation and choose Launch readiness in the Implementation sections row. There you can save success criteria, test/acceptance plans, acceptance status, training status, go-live status, rollback plans, and post-launch support ownership. The customer portal can show published readiness details.";
  }
  if (/(stakeholder|procurement|security review|compliance|technical setup|adoption|early validation|blocker risk)/.test(question)) {
    return "Use the implementation’s Launch readiness and stakeholder/risk sections to record stakeholders, procurement and security status, technical setup, change/adoption progress, early validation, and risks. Give each risk or blocker an owner, severity, due date, and next action.";
  }
  if (/(hubspot|closed won|crm handoff|sales deal)/.test(question)) {
    return "Growth and Custom workspace owners can connect HubSpot, select one pipeline, its Closed Won stage, and a Relay template. Matching Closed Won deals start one Relay implementation; Relay deduplicates imports and does not modify the original sales deal. Live authorization and Closed Won polling require provider setup and testing.";
  }
  if (/(email reminder|reminder|email notification|overdue email|customer escalation)/.test(question)) {
    return "Workspace owners can enable email notifications and choose reminder timing in Settings. Task reminders use due dates, and overdue tasks can be reminded daily. Customer escalation can email a backup customer contact after the configured quiet period. Resend and the scheduled event processor must be configured.";
  }
  if (/(?:\bprocess map\b|\bprocess maps\b|\bprocess\b.{0,20}\bmap\b)/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A process map is the reusable blueprint for how your team onboards a customer. It lays out the work as ordered steps, with instructions, responsible roles, owners, timing, and prerequisites. It’s useful for making your team’s approach consistent, spotting gaps before work starts, and turning a checked process into a template. A process map is the design; an implementation is the live copy used for one customer.";
  }
  if (/\btemplate(s)?\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A template is a checked snapshot of a process map and a dependable starting point for future customer implementations. Growth and Custom plans keep revision history and let you restore an earlier version; Starter includes up to three templates without that history feature. Custom plans have unlimited templates. Updating a template does not change customer work that has already started.";
  }
  if (/\bimplementation(s)?\b|\bonboarding\b|\bcustomer work\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "An implementation is the customer-specific workspace for one onboarding. Relay copies tasks from a template so your team can assign owners, set due dates, prerequisites, and collect the information needed from that customer. Growth and Custom also support blocker tracking. Relay helps everyone see progress; it does not automatically configure the customer’s product.";
  }
  if (/\bprivate link\b|\bcustomer link\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A customer information link lets the intended customer submit the setup details requested for their implementation without needing a Relay workspace account. Treat the link like a secret: share it only with that customer. Creating a replacement link revokes the old one.";
  }
  if (!/\b(delete|remove|erase|close|clear)\b/.test(question)
    && (/\bcustomer information\b|\bcustomer form\b|\bcustomer link\b|\brequirements\b/.test(question))
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "Customer information lets your team define the setup details a customer needs to provide, such as a contact email or website. You can make a request required or optional, choose the response type, and share a private link tied to an implementation. It keeps setup answers together with the customer’s work. Only request information needed for onboarding—never passwords, payment-card details, or other secrets.";
  }
  if (/\bprerequisite(s)?\b|\bdependenc(y|ies)\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A prerequisite is a task that must be completed before another task can proceed. Set prerequisites in the process map to show the intended order of work; Relay then highlights implementation tasks that are waiting on unfinished steps. This helps the team understand what is blocked and why.";
  }
  if (/\breadiness\b|\bsetup check\b|\bprocess check\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A readiness or process check reviews the information and task setup Relay can validate—for example, missing instructions or owners, invalid assignments, prerequisite problems, and schedule issues. Use it to catch gaps before saving a process as a template. It is a workflow check, not a certification that a customer is technically or commercially ready to launch.";
  }
  if (/\boverview\b|\bdashboard\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "Overview is the workspace’s at-a-glance summary. It brings implementations, templates, and work needing attention into one place, so you can spot where follow-up may be needed. Open an individual implementation for its task owners, due dates, blockers, prerequisites, and customer responses.";
  }
  if (/\btask(s)?\b|\bstep(s)?\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A task or step is one piece of work in an onboarding process. It can include instructions, a responsible role, an assigned teammate, a due date, and prerequisites. In a process map, steps describe the reusable workflow; in an implementation, the copied tasks track progress for one customer.";
  }
  if (/\bteam(mate)?s?\b|\binvit(e|ation|ations)\b|\bworkspace team\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "The workspace team is the group of people who collaborate on customer onboarding. Owners can invite teammates; team members can be assigned to implementation tasks so it’s clear who is responsible. Invitations expire after seven days, and members cannot invite others.";
  }
  if (/(what is this|what does this do|what is it used for|what's this for|what is this used for)/.test(question)) {
    return "I’m not sure which Relay feature you mean. Tell me the name of the section, item, or button you’re looking at—such as Process map, Templates, an implementation, or Customer information—and I’ll explain what it is and when to use it.";
  }
  if (/(live|current|my |our )?.{0,30}(customer|implementation|task|workspace).{0,30}(status|progress|data|details)|what is blocked|what is overdue/.test(question)) {
    return "I can’t see your workspace data. Open Overview for a summary, or open Implementations and select a customer to review task owners, due dates, blockers, prerequisites, and customer responses.";
  }
  if (/\b(?:archive|restore|unarchive)\b/.test(question)
    && !/\b(?:delete|permanently|erase)\b/.test(question)
    && /\b(?:implementation|customer|client|project|onboarding)\b/.test(question)) {
    return "A workspace owner can open Implementations, select the customer, and choose Archive. Archived work is hidden from active delivery and pauses customer portal access; its history is kept. Choose View archived to restore it later. Only workspace owners can archive or restore implementations.";
  }
  if (/\b(?:delete|remove|erase|clear|discard|trash)\b/.test(question)) {
    if (/\b(?:help|ray)\b.{0,25}\b(?:chat|conversation|history|messages?)\b|\b(?:chat|conversation|history|messages?)\b.{0,25}\b(?:help|ray)\b/.test(question)) {
      return "Open Ray and choose Clear my help history. This removes your saved Ray conversations from your account.";
    }
    if (/\b(?:account|workspace)\b/.test(question)) {
      return "For account deletion, open Settings → Delete your Relay account, review the workspace impact, enter your password, and type DELETE. If you’re the only workspace member, that workspace and its customer data, including its customer portal links, are deleted too. For a shared workspace you own, transfer ownership first; the workspace remains for its members. Relay has no separate workspace-delete control.";
    }
    if (/\b(?:invitation|invite)\b/.test(question)) {
      return "A workspace owner can open Settings → Workspace team, find the pending invitation, and choose Revoke. Accepted invitations are now members; the workspace does not currently have a control for an owner to remove an existing member.";
    }
    if (/\b(?:customer|portal|private)\s+(?:information\s+)?link\b|\b(?:old|expired)\s+link\b/.test(question)) {
      return "Open the customer’s implementation, then choose Rotate customer link. This invalidates the old link and creates a replacement; share the new link only with the intended customer. It does not delete the implementation or its saved answers.";
    }
    if (/\bcustomer\s+(?:information|info|data)\b/.test(question)
      && !/\b(?:request|form|field|answer|response|submission)\b/.test(question)) {
      return "Do you mean removing a Customer information request or deleting one saved customer answer? Deleting a request removes all of its saved responses; Relay has no control to delete just one answer. Tell me which one you mean and I’ll guide you.";
    }
    if (/\b(?:customer|client)\s+(?:information|info|data)\s+(?:request|form|field)\b|\b(?:information|info)\s+request\b|\b(?:customer form|requirement|request field)\b/.test(question)) {
      return "Open Customer information, find the request, and choose Delete. This permanently deletes the request and its saved customer responses, so check that you no longer need those answers before confirming.";
    }
    if (/\b(?:process|workflow)\s+(?:map\s+)?(?:step|task)\b|\b(?:step|task)\b.{0,30}\b(?:process map|workflow)\b/.test(question)) {
      return "In Process map, open the process and choose Delete beside the step. This also removes prerequisite links that use that step. It changes the reusable process; saved templates and existing customer implementations keep their copied steps.";
    }
    if (/\b(?:template|saved template)\b/.test(question)) {
      return "Open Templates and choose Delete template. Relay only allows deleting a template that is not used by an existing customer implementation; deleting a template never deletes customer implementations.";
    }
    if (/\b(?:process map|workflow|process)\b/.test(question)) {
      return "In Process map, find the map and choose Delete process. If saved templates use it, delete those templates first. A template used by an existing customer implementation cannot be deleted, and deleting a process map does not delete customer work.";
    }
    if (/\b(?:implementation|customer|client|customer record|onboarding)\b/.test(question)) {
      return "A workspace owner can open Implementations, select the customer, and choose Archive to hide it while keeping its history; archived work can be restored from View archived. To remove it permanently, choose Permanently delete and confirm. This cannot be undone and deletes the implementation’s tasks, customer information, portal messages, and uploaded files.";
    }
    if (/\b(?:answer|response|submission|customer data)\b/.test(question)) {
      return "Relay has no control to delete one saved customer answer by itself. A customer can update an answer through their active private link. Deleting the related Customer information request removes that request’s saved responses, so use that only if all of those responses should be removed.";
    }
    if (/\b(?:step|task)\b/.test(question)) {
      return "Do you mean a step in a reusable Process map or a task in an existing customer implementation? Process-map steps can be deleted from Process map; Relay does not currently let you delete an individual task from an existing implementation.";
    }
    return "What would you like to delete—a process map, process step, template, customer-information request, customer implementation, customer link, invitation, or your account? Relay can delete some of these, while others need a different action or Relay support.";
  }
  if (/(where|how).{0,40}(see|check|find|know).{0,40}(progress|status|next step|what.*next)/.test(question)) {
    return "Open Overview for a summary of implementations and items needing attention. To see the next step for one customer, open Implementations, select that customer, and review task status, owners, due dates, blockers, prerequisites, and missing information.";
  }
  if (/(what should|what do|what would).{0,35}(i|we).{0,20}(ask|collect|request|get).{0,35}(customer|client)/.test(question)) {
    return "Ask only for information needed to complete the implementation. In Customer information, add a clear request, explain why it is needed, choose a response type, and mark it required only if the work depends on it. Never request passwords or payment details.";
  }
  if (/\bmy\b(?!\s+(?:customer|client)).{0,20}\b(?:link|form)\b.{0,35}(?:expired|invalid|not working|doesn.?t work|does not work|won.?t open|will not open)/.test(question)) {
    return "Contact the implementation team that sent your link and ask them to check it or create a replacement. A replacement invalidates the old link, so use only the newest link they provide.";
  }
  if (/(customer|client).{0,35}(cannot|can't|unable to|doesn't|does not).{0,25}(open|use|submit|access).{0,35}(link|form|information)?|(?:link|form).{0,35}(expired|invalid|not working|doesn.?t work|does not work|won.?t open|will not open)/.test(question)) {
    return "Open the customer’s implementation and create a replacement customer link. This invalidates the old link, so send the new one only to the intended customer. If it still fails, contact Relay support.";
  }
  if (/(how|when).{0,30}(know|mark|consider|set).{0,30}(onboard|implementation|customer).{0,30}(complete|ready)|(?:complete|ready).{0,30}(onboard|implementation|customer)/.test(question)) {
    return "Relay marks an implementation complete when all its tasks are done. Review the attention indicators too: required customer information can still be missing, so confirm those answers before treating onboarding as finished.";
  }
  if (/(?:where|how).{0,35}(?:find|open|use|show).{0,35}(?:more options|advanced options|step options|prerequisites?|dependencies|due dates?|customer visibility)|where.{0,30}(?:prerequisites?|dependencies|due dates?|customer visibility)|(?:more options|advanced options|step options).{0,35}(?:prerequisite|due date|customer visibility|step)|(?:process step|step).{0,40}(?:more options|due dates?|timing|customer visibility|prerequisites?|dependencies)|(?:more options|due dates?|timing|customer visibility|prerequisites?|dependencies).{0,40}(?:process step|step)/.test(question)) {
    return "In Process map, while adding or editing a process step, open More options to set its stage, due timing, customer visibility, or prerequisites. Relay opens More options automatically when you edit a step that already uses those settings.";
  }
  if (/(?:must|need to|required|have to).{0,25}(?:assign|teammate)|(?:assign|assignee).{0,25}(?:optional|required|every|each)/.test(question)
    && /(?:process step|step|process map)/.test(question)) {
    return "A responsible role is required for a process step, but assigning a workspace teammate is optional. Leave the teammate unassigned or choose someone from the list; you can assign implementation tasks later.";
  }
  if (/(map|add|set|configure|define|choose).{0,35}(prerequisite|dependency)|(?:prerequisite|dependency).{0,35}(map|add|set|configure|define)|process.{0,30}(prerequisite|dependency)/.test(question)) {
    return "In Process map, add or edit a step and open More options. Select the earlier steps it depends on. Relay uses prerequisites to show the required order and flag implementation tasks waiting on unfinished work.";
  }
  if (/(prerequisite|blocked|blocker|waiting on)/.test(question)) {
    return "Open the implementation task, record the blocker and a next action, then review its prerequisites. Relay highlights tasks waiting on unfinished prerequisites.";
  }
  const asksForCustomerInfo = /(?:what|which).{0,35}(?:information|details|fields).{0,35}(?:customer|client)|(?:customer|client).{0,35}(?:what|which).{0,25}(?:information|details|fields)|(?:ask|collect|request|get).{0,30}(?:customer|client).{0,30}(?:information|details|email|website|contact)/.test(question);
  if (/(customer information|customer form|customer link|submission|requirements)/.test(question) || asksForCustomerInfo) {
    return "In Customer information, define the fields the client needs to provide. Open their implementation to create a private link, then share it with them and review their submitted answers. Never request passwords or payment-card details.";
  }
  if (/(invite|member|teammate|permission|role)/.test(question)) {
    return "A workspace owner can invite a teammate from the Workspace team panel and assign them to implementation tasks. Pending invitations can be revoked there; invitations expire after seven days.";
  }
  if (/(appearance|theme|dark mode|accent|color)/.test(question)) {
    return "Open Settings to choose light or dark mode and an accent color. Relay saves those appearance preferences to your account.";
  }
  if (/(?:update|change|refresh|edit|restore)\s+(?:a\s+|the\s+)?template.*existing|template.{0,50}existing (?:implementation|plan|customer work)/.test(question)) {
    return "Refreshing a template changes the version used by future implementations. Growth and Custom plans keep revision history and allow restoring an earlier version. Existing implementations keep their copied task plans and are not changed by template updates.";
  }
  if (/(template|version|revision|restore)/.test(question)) {
    return "To create a template, open Process map, add clear steps and responsible roles, run the process check, then choose Create template. You can start with one step and add more later. Growth and Custom plans also keep revision history and allow restoring an earlier version.";
  }
  if (/(?:add|create|write|edit).{0,35}(?:process )?(?:step|task)|(?:process )?(?:step|task).{0,35}(?:add|create|write|edit)|where.{0,25}(?:add|create).{0,20}(?:step|task)/.test(question)) {
    return "Open Process map; Relay opens your selected map automatically. If you need a new one, choose Create a new map. Add a step name, instructions, and responsible role, then choose Save step. Assigning a teammate is optional; timing, prerequisites, and customer visibility are under More options.";
  }
  if (/(?:create|start|make|new).{0,35}(?:process )?(?:map|workflow)|(?:process|workflow).{0,25}(?:map|workflow).{0,25}(?:create|start|make|new)|where.{0,25}(?:new map|process map)/.test(question)) {
    return "Open Process map. If you already have maps, expand Create a new map; if you have none, Relay opens the form for you. Name the map, then add its steps. You can start with one step and add more later.";
  }
  if (/(customer|implementation|task|assignee|due date)/.test(question)) {
    return "Open Implementations, choose a saved template, and enter the customer’s company name. Open the new implementation to assign teammates, set due dates, track prerequisites, and create a private customer-information link.";
  }
  if (/(process|map|step|readiness|check)/.test(question)) {
    return "Open Process map; Relay selects your current map automatically. Add steps with instructions and responsible roles, run the check, then choose Create template. The progress steps at the top are clickable, and optional timing, prerequisites, and customer visibility are under More options.";
  }
  if (/(what can you do|what can you help|who are you|what is relay|what does relay|can you help me|help me get started|^help$)/.test(question)) {
    return "I’m Ray, Relay’s built-in product guide. I can help with process maps, templates, customer implementation tasks, customer-information requests, workspace settings, and safe deletion or cleanup steps. What are you trying to do?";
  }
  return "I don’t have a matching built-in answer yet, and I don’t want to guess. Tell me what you’re trying to do and which Relay section or button you’re looking at. I can guide you through process maps, templates, customer work, customer information, team settings, plans, and supported deletion steps; I can’t see private workspace data or perform changes for you. For account-specific or billing help, contact Relay support.";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { relayHelpReply };
}
if (typeof window !== "undefined") {
  window.relayHelpReply = relayHelpReply;
}
