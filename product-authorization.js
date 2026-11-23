"use strict";

const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze({
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
  }),
  admin: Object.freeze({
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
  }),
  implementation_manager: Object.freeze({
    administerWorkspace: false,
    manageImplementations: true,
    manageTasks: true,
    manageCustomerCommunication: true,
    logTime: true,
    viewFinancials: true,
    manageFinancials: false,
    viewRates: false,
    viewAuditLogs: false,
    executiveView: false
  }),
  contributor: Object.freeze({
    administerWorkspace: false,
    manageImplementations: false,
    manageTasks: true,
    manageCustomerCommunication: true,
    logTime: true,
    viewFinancials: false,
    manageFinancials: false,
    viewRates: false,
    viewAuditLogs: false,
    executiveView: false
  }),
  executive_viewer: Object.freeze({
    administerWorkspace: false,
    manageImplementations: false,
    manageTasks: false,
    manageCustomerCommunication: false,
    logTime: false,
    viewFinancials: true,
    manageFinancials: false,
    viewRates: false,
    viewAuditLogs: false,
    executiveView: true
  })
});

const PERSONAL_WRITE_PATHS = new Set([
  "/api/product/preferences",
  "/api/product/onboarding",
  "/api/product/help-chat"
]);

const ADMIN_WRITE_PATHS = [
  /^\/api\/product\/notifications$/,
  /^\/api\/product\/integrations(?:\/|$)/,
  /^\/api\/product\/invites(?:\/|$)/,
  /^\/api\/product\/team-members(?:\/|$)/,
  /^\/api\/product\/capacity-plans$/,
  /^\/api\/product\/audit-logs(?:\/|$)/,
  /^\/api\/product\/implementations\/\d+\/(?:archive|restore)$/,
  /^\/api\/product\/implementations\/\d+\/(?:financial-plan|budget)$/,
  /^\/api\/product\/implementations\/\d+$/
];

const MANAGER_WRITE_PATHS = [
  /^\/api\/product\/implementations$/,
  /^\/api\/product\/implementations\/\d+\/(?:customer-link|launch-plan|launch-readiness|sow|approvals|onboarding-gap-plan|calendar-events|launch-stakeholders|launch-risks|customer-contacts|delegations|customer-escalation)(?:\/|$)/,
  /^\/api\/product\/implementations\/\d+\/(?:change-orders)(?:\/|$)/,
  /^\/api\/product\/implementations\/\d+\/budget-overrides$/,
  /^\/api\/product\/implementations\/\d+\/files\/\d+$/
];

const CONTRIBUTOR_WRITE_PATHS = [
  /^\/api\/product\/implementations\/\d+\/steps\/\d+$/,
  /^\/api\/product\/implementations\/\d+\/tasks\/\d+\/escalate$/,
  /^\/api\/product\/implementations\/\d+\/(?:time-entries|steps\/\d+\/time-entries)$/,
  /^\/api\/product\/(?:time-entries\/\d+|implementations\/\d+\/time-entries\/\d+)$/,
  /^\/api\/product\/implementations\/\d+\/messages$/
];

const EXECUTIVE_READ_PATHS = new Set([
  "/api/product/me",
  "/api/product/workspace",
  "/api/product/analytics/portfolio-margins",
  "/api/product/onboarding",
  "/api/product/preferences",
  "/api/product/help-chat"
]);

const CONTRIBUTOR_READ_PATHS = new Set([
  "/api/product/me",
  "/api/product/workspace",
  "/api/product/onboarding",
  "/api/product/preferences",
  "/api/product/help-chat"
]);

const CONTRIBUTOR_IMPLEMENTATION_READ_PATHS = [
  /^\/api\/product\/implementations\/\d+$/,
  /^\/api\/product\/implementations\/\d+\/(?:time-entries|files\/\d+)$/
];

function getRoleCapabilities(role) {
  const normalizedRole = role === "member" ? "contributor" : role;
  const capabilities = ROLE_CAPABILITIES[normalizedRole];
  if (!capabilities) throw new Error(`Unknown workspace role: ${String(role)}.`);
  return { ...capabilities };
}

function isWorkspaceAdmin(role) {
  return role === "owner" || role === "admin";
}

function pathMatchesAny(pathname, patterns) {
  return patterns.some((pattern) => pattern.test(pathname));
}

function canAccessWorkspaceRequest(role, method, pathname) {
  const normalizedRole = role === "member" ? "contributor" : role;
  if (!ROLE_CAPABILITIES[normalizedRole]) return false;
  if (isWorkspaceAdmin(normalizedRole)) return true;

  const safePath = String(pathname || "").split("?", 1)[0];
  const verb = String(method || "GET").toUpperCase();
  const isRead = verb === "GET" || verb === "HEAD" || verb === "OPTIONS";

  if (isRead) {
    if (/^\/api\/product\/audit-logs(?:\/|$)/.test(safePath)
      || /^\/api\/product\/integrations(?:\/|$)/.test(safePath)) return false;
    if (normalizedRole === "executive_viewer") return EXECUTIVE_READ_PATHS.has(safePath);
    if (normalizedRole === "contributor") {
      return CONTRIBUTOR_READ_PATHS.has(safePath)
        || pathMatchesAny(safePath, CONTRIBUTOR_IMPLEMENTATION_READ_PATHS);
    }
    return true;
  }

  if (PERSONAL_WRITE_PATHS.has(safePath) || safePath === "/api/product/account") return true;
  if (pathMatchesAny(safePath, ADMIN_WRITE_PATHS)) return false;
  if (normalizedRole === "executive_viewer") return false;
  if (normalizedRole === "implementation_manager") {
    return pathMatchesAny(safePath, MANAGER_WRITE_PATHS)
      || pathMatchesAny(safePath, CONTRIBUTOR_WRITE_PATHS);
  }
  return pathMatchesAny(safePath, CONTRIBUTOR_WRITE_PATHS);
}

module.exports = {
  ROLE_CAPABILITIES,
  canAccessWorkspaceRequest,
  getRoleCapabilities,
  isWorkspaceAdmin
};
