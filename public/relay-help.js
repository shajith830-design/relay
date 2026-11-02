"use strict";

function relayHelpReply(message) {
  const question = String(message || "").toLocaleLowerCase().trim();

  if (/^(?:h+i+|hello+|hey+|hiya|howdy)(?:\s+ray)?[!.?,\s]*$/.test(question)) {
    return "Hi! I’m Ray, your Relay guide. What are you working on today—setting up a process, starting a customer implementation, or collecting customer information?";
  }
  if (/^(how are you|how's it going|how is it going|how are things)[!.?,\s]*$/.test(question)) {
    return "I’m here and ready to help with Relay. What would you like to get done?";
  }
  if (/^(thanks|thank you|thanks ray|thank you ray|thx)[!.?,\s]*$/.test(question)) {
    return "You’re welcome! If you get stuck with a Relay workflow, just ask.";
  }
  if (/^(bye|goodbye|see you|talk later)[!.?,\s]*$/.test(question)) {
    return "Goodbye! I’ll be here if you need help with Relay.";
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
  if (/(soc.?2|certif|compliance|uptime|availability|service.level|\bsla\b|security audit)/.test(question)) {
    return "I can’t verify Relay’s certifications, audit results, uptime, or service-level commitments. Please check your current agreement or contact Relay support.";
  }
  if (/\blive ray\b|\b(?:relay|ray)\b.{0,25}\b(?:ai|artificial intelligence|model)\b|\b(?:ai|artificial intelligence|model)\b.{0,25}\b(?:relay|ray)\b/.test(question)) {
    return "I’m Ray, Relay’s built-in product guide. I use prepared Relay-specific answers—not an external AI service—and can’t access private workspace records.";
  }
  if (/(jira|slack|integration|integrate|synchronize|sync with|external project)/.test(question)) {
    return "Relay manages onboarding workflows in its own workspace; it doesn’t synchronize with external project-management tools such as Slack or Jira.";
  }
  if (/(?:relay.{0,35}(?:price|pricing|cost|subscription)|(?:price|pricing|cost|subscription).{0,35}relay|₹|rupee)/.test(question)) {
    return "Relay’s listed subscription price is ₹3,000 per month. Review the applicable billing and service terms before purchase.";
  }
  if (/(?:\bprocess map\b|\bprocess maps\b|\bprocess\b.{0,20}\bmap\b)/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A process map is the reusable blueprint for how your team onboards a customer. It lays out the work as ordered steps, with instructions, responsible roles, owners, timing, and prerequisites. It’s useful for making your team’s approach consistent, spotting gaps before work starts, and turning a checked process into a template. A process map is the design; an implementation is the live copy used for one customer.";
  }
  if (/\btemplate(s)?\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A template is a checked, versioned snapshot of a process map. Use it as a dependable starting point whenever you onboard another customer, instead of rebuilding the same steps each time. Updating a template creates a new version for future implementations; it does not change customer work that has already started.";
  }
  if (/\bimplementation(s)?\b|\bonboarding\b|\bcustomer work\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "An implementation is the customer-specific workspace for one onboarding. Relay copies tasks from a template so your team can assign owners, set due dates, record blockers and prerequisites, and collect the information needed from that customer. It helps everyone see progress and what needs attention; it does not automatically configure the customer’s product.";
  }
  if (/\bprivate link\b|\bcustomer link\b/.test(question)
    && /(what|why|purpose|used for|useful|explain|mean|help me understand)/.test(question)) {
    return "A customer information link lets the intended customer submit the setup details requested for their implementation without needing a Relay workspace account. Treat the link like a secret: share it only with that customer. Creating a replacement link revokes the old one.";
  }
  if (/\bcustomer information\b|\bcustomer form\b|\bcustomer link\b|\brequirements\b/.test(question)
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
  if (/(account|workspace).{0,35}(delete|deletion|remove)|(?:delete|deletion|remove).{0,35}(account|workspace)/.test(question)
    && /(customer information|customer form|customer link|submission|requirements)/.test(question)) {
    return "For account deletion, open Settings and review the workspace impact; an owner must transfer ownership before deleting. For customer onboarding, define requests in Customer information, then create and share a private link from the implementation.";
  }
  if (/(where|how).{0,40}(see|check|find|know).{0,40}(progress|status|next step|what.*next)/.test(question)) {
    return "Open Overview for a summary of implementations and items needing attention. To see the next step for one customer, open Implementations, select that customer, and review task status, owners, due dates, blockers, prerequisites, and missing information.";
  }
  if (/(what should|what do|what would).{0,35}(i|we).{0,20}(ask|collect|request|get).{0,35}(customer|client)/.test(question)) {
    return "Ask only for information needed to complete the implementation. In Customer information, add a clear request, explain why it is needed, choose a response type, and mark it required only if the work depends on it. Never request passwords or payment details.";
  }
  if (/(customer|client).{0,35}(cannot|can't|unable to|doesn't|does not).{0,25}(open|use|submit|access).{0,35}(link|form|information)?|(?:link|form).{0,35}(expired|invalid|not working)/.test(question)) {
    return "Open the customer’s implementation and create a replacement customer link. This invalidates the old link, so send the new one only to the intended customer. If it still fails, contact Relay support.";
  }
  if (/(how|when).{0,30}(know|mark|consider|set).{0,30}(onboard|implementation|customer).{0,30}(complete|ready)|(?:complete|ready).{0,30}(onboard|implementation|customer)/.test(question)) {
    return "Relay marks an implementation complete when all its tasks are done. Review the attention indicators too: required customer information can still be missing, so confirm those answers before treating onboarding as finished.";
  }
  if (/(map|add|set|configure|define|choose).{0,35}(prerequisite|dependency)|(?:prerequisite|dependency).{0,35}(map|add|set|configure|define)|process.{0,30}(prerequisite|dependency)/.test(question)) {
    return "In Process map, edit a step and select the earlier steps it depends on. Relay uses these prerequisites to show the required order and flag implementation tasks waiting on unfinished work.";
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
  if (/(delete|deletion|remove).{0,30}(account|workspace)|(?:account|workspace).{0,30}(delete|deletion|remove)/.test(question)) {
    return "Open Settings and review the effect on each workspace before deleting your account. If you own a shared workspace, choose another member as its new owner first.";
  }
  if (/(change|update|refresh|edit|restore).{0,40}template.{0,50}(existing|current|already|affect|implementation|plan)|template.{0,50}(existing implementation|existing plan|already started|future implementation)|(?:existing|current|already-created|already created).{0,40}(implementation|plan|customer work)/.test(question)) {
    return "Refreshing a template creates a new revision for future implementations. Existing implementations keep their copied task plans and are not changed by template updates.";
  }
  if (/(template|version|revision|restore)/.test(question)) {
    return "To create a template, map your process, add clear steps and owners, run the process check, and save the checked process as a template. Templates keep version history for future work.";
  }
  if (/(customer|implementation|task|assignee|due date)/.test(question)) {
    return "Open Implementations, choose a saved template, and enter the customer’s company name. Open the new implementation to assign teammates, set due dates, track prerequisites, and create a private customer-information link.";
  }
  if (/(process|map|step|readiness|check)/.test(question)) {
    return "Open Process map, create a process, and add ordered steps with instructions, responsible roles, and any prerequisites. Run the setup check before saving it as a reusable template.";
  }
  if (/(what can you do|what can you help|who are you|what is relay|what does relay|how do i|how can i|help|start)/.test(question)) {
    return "I’m Ray, Relay’s built-in product guide. I can help with process maps, templates, customer implementation tasks, customer-information requests, and workspace settings. Which one are you working on?";
  }
  return "I can help with Relay workflows, templates, customer implementations, requested information, and workspace settings. I don’t have a matching built-in answer yet—what are you trying to do in Relay?";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { relayHelpReply };
}
if (typeof window !== "undefined") {
  window.relayHelpReply = relayHelpReply;
}
