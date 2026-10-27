"use strict";

const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual
} = require("node:crypto");
const { promisify } = require("node:util");
const { assistantInstructions } = require("./relay-help-content");

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "relay_session";
const SESSION_DAYS = 14;
const rateLimitBuckets = new Map();

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validId(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requiredText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : "";
}

function cookieToken(req) {
  const cookieHeader = req.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)relay_session=([A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}

function setSessionCookie(res, token, isProduction) {
  const secure = isProduction ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function clearSessionCookie(res, isProduction) {
  const secure = isProduction ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function sameOrigin(req, res, next) {
  const origin = req.get("Origin");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: "Request origin could not be verified." });
  }
  if (originHost !== req.get("host")) {
    return res.status(403).json({ error: "Request origin could not be verified." });
  }
  return next();
}

function rateLimit(key, limit, windowMs, message) {
  const now = Date.now();
  for (const [bucketKey, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart >= bucket.windowMs) rateLimitBuckets.delete(bucketKey);
  }
  const bucket = rateLimitBuckets.get(key) || { count: 0, windowStart: now, windowMs };
  if (bucket.count >= limit) {
    return { limited: true, message };
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return { limited: false };
}

function limitRequests(key, limit, windowMs, message) {
  return (req, res, next) => {
    const result = rateLimit(`${key}:${req.ip || "unknown"}`, limit, windowMs, message);
    if (result.limited) return res.status(429).json({ error: result.message });
    return next();
  };
}

async function makePasswordHash(password) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

async function checkPassword(password, encodedHash) {
  const [algorithm, saltHex, keyHex] = encodedHash.split(":");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(keyHex)) {
    return false;
  }
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

const INPUT_TYPES = new Set(["text", "email", "url", "number", "date"]);

function inputValueError(type, value) {
  if (!value) return "";
  if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Enter a valid email address.";
  if (type === "url") {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) {
        return "Enter a complete website URL beginning with https://.";
      }
    } catch {
      return "Enter a complete website URL beginning with https://.";
    }
  }
  if (type === "number" && !Number.isFinite(Number(value))) return "Enter a valid number.";
  if (type === "date" && !validDate(value)) {
    return "Enter a valid date.";
  }
  return "";
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function hasCycle(steps) {
  const graph = new Map(steps.map((step) => [step.id, step.dependsOn || []]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return [...graph.keys()].some(visit);
}

function installProductRoutes(app, db, isProduction) {
  const database = db.database;

  function processSteps(processId) {
    const steps = database.prepare(
      `SELECT s.id, s.title, s.description, s.owner, s.position, s.stage, s.due_offset_days,
        s.assignee_user_id, u.email AS assignee_email
       FROM product_process_steps s
       JOIN product_processes p ON p.id = s.process_id
       LEFT JOIN product_users u ON u.id = s.assignee_user_id
       WHERE s.process_id = ? ORDER BY s.position, s.id`
    ).all(processId);
    const dependencies = database.prepare(`
      SELECT d.process_step_id AS stepId, d.depends_on_step_id AS dependsOn
      FROM product_process_step_dependencies d
      JOIN product_process_steps s ON s.id = d.process_step_id
      WHERE s.process_id = ?
    `).all(processId);
    const byStep = new Map(steps.map((step) => [step.id, step]));
    for (const step of steps) step.dependsOn = [];
    for (const dependency of dependencies) byStep.get(dependency.stepId)?.dependsOn.push(dependency.dependsOn);
    return steps;
  }

  function workspaceAssignee(workspaceId, value) {
    if (value === null || value === undefined || value === "") return { id: null, valid: true };
    const id = validId(value);
    if (!id) return { id: null, valid: false };
    const member = database.prepare(
      "SELECT user_id FROM product_memberships WHERE workspace_id = ? AND user_id = ?"
    ).get(workspaceId, id);
    return { id, valid: Boolean(member) };
  }

  function implementationRequirements(implementationId, workspaceId, templateId) {
    return database.prepare(`
      SELECT r.id, r.name, r.description, r.required, r.input_type,
        COALESCE(c.value, '') AS value
      FROM product_requirements r
      LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = ?
      WHERE r.workspace_id = ? AND (r.template_id IS NULL OR r.template_id = ?)
      ORDER BY r.id
    `).all(implementationId, workspaceId, templateId);
  }

  app.use("/api/product", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.post("/api/product/auth/signup", sameOrigin,
    limitRequests("signup", 20, 60 * 60 * 1000, "Too many account creation attempts. Try again later."),
    async (req, res) => {
    const email = requiredText(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const workspaceName = requiredText(req.body.workspaceName, 100);
    const inviteToken = typeof req.body.inviteToken === "string" ? req.body.inviteToken : "";
    const isInvitedSignup = inviteToken.length > 0;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128
      || (!isInvitedSignup && !workspaceName) || (isInvitedSignup && !/^[A-Za-z0-9_-]{40,60}$/.test(inviteToken))) {
      return sendError(res, 400, "Enter valid account details and a password of at least 12 characters.");
    }
    const invite = isInvitedSignup ? database.prepare(`
      SELECT id, workspace_id, invited_email
      FROM product_workspace_invites
      WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?
    `).get(hashToken(inviteToken), new Date().toISOString()) : null;
    if (isInvitedSignup && (!invite || invite.invited_email.toLowerCase() !== email)) {
      return sendError(res, 400, "This invitation is invalid, expired, or addressed to a different email.");
    }

    try {
      const passwordHash = await makePasswordHash(password);
      const createAccount = database.transaction(() => {
        const user = database.prepare(
          "INSERT INTO product_users (email, password_hash) VALUES (?, ?) RETURNING id, email"
        ).get(email, passwordHash);
        let workspace;
        if (invite) {
          const accepted = database.prepare(`
            UPDATE product_workspace_invites SET accepted_at = CURRENT_TIMESTAMP
            WHERE id = ? AND accepted_at IS NULL AND expires_at > ?
          `).run(invite.id, new Date().toISOString());
          if (!accepted.changes) {
            const error = new Error("This invitation has already been used or has expired.");
            error.code = "INVITE_INVALID";
            throw error;
          }
          database.prepare(
            "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES (?, ?, 'member')"
          ).run(invite.workspace_id, user.id);
          workspace = database.prepare(
            "SELECT id, name FROM product_workspaces WHERE id = ?"
          ).get(invite.workspace_id);
        } else {
          workspace = database.prepare(
            "INSERT INTO product_workspaces (name) VALUES (?) RETURNING id, name"
          ).get(workspaceName);
          database.prepare(
            "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')"
          ).run(workspace.id, user.id);
        }
        return { user, workspace };
      });
      const { user, workspace } = createAccount();
      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
      database.prepare(
        "INSERT INTO product_sessions (token_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)"
      ).run(hashToken(rawToken), user.id, workspace.id, expiresAt);
      setSessionCookie(res, rawToken, isProduction);
      return res.status(201).json({
        user,
        workspace: { ...workspace, role: invite ? "member" : "owner" }
      });
    } catch (error) {
      if (error.code === "INVITE_INVALID") {
        return sendError(res, 409, error.message);
      }
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return sendError(res, 409, "An account with this email already exists. Sign in instead.");
      }
      console.error("Product account creation failed:", error.message);
      return sendError(res, 500, "The account could not be created. Please try again.");
    }
  });

  app.post("/api/product/auth/password-reset/request", sameOrigin,
    limitRequests("password-reset", 5, 60 * 60 * 1000, "Too many requests. Try again later."),
    async (req, res) => {
      const email = requiredText(req.body.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendError(res, 400, "Enter a valid email address.");
      }

      const apiKey = process.env.RESEND_API_KEY?.trim();
      const from = process.env.AUTH_EMAIL_FROM?.trim();
      const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
      const apiUrl = !isProduction && process.env.NODE_ENV === "test"
        ? process.env.AUTH_EMAIL_API_URL?.trim() || "https://api.resend.com/emails"
        : "https://api.resend.com/emails";
      if (!apiKey || !from || !baseUrl) {
        console.error("Password reset email is not configured; set RESEND_API_KEY, AUTH_EMAIL_FROM, and PUBLIC_BASE_URL.");
        return sendError(res, 503, "Password recovery is not available right now. Contact support for help.");
      }
      let parsedBaseUrl;
      try {
        parsedBaseUrl = new URL(baseUrl);
      } catch {
        console.error("Password reset email is not configured: PUBLIC_BASE_URL must be a valid URL.");
        return sendError(res, 503, "Password recovery is not available right now. Contact support for help.");
      }
      if (parsedBaseUrl.protocol !== "https:" && isProduction) {
        console.error("Password reset email is not configured: PUBLIC_BASE_URL must use HTTPS in production.");
        return sendError(res, 503, "Password recovery is not available right now. Contact support for help.");
      }

      try {
        database.prepare("DELETE FROM product_password_resets WHERE expires_at <= ?")
          .run(new Date().toISOString());
        const user = database.prepare("SELECT id, email FROM product_users WHERE email = ?").get(email);
        if (user) {
          const rawToken = randomBytes(32).toString("base64url");
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          database.prepare("DELETE FROM product_password_resets WHERE user_id = ?").run(user.id);
          const tokenHash = hashToken(rawToken);
          database.prepare(
            "INSERT INTO product_password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)"
          ).run(tokenHash, user.id, expiresAt);
          const resetUrl = new URL(`/product.html?reset=${encodeURIComponent(rawToken)}`, parsedBaseUrl).toString();
          let response;
          try {
            response = await fetch(apiUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                from,
                to: [user.email],
                subject: "Reset your Relay password",
                text: `Use this one-time link to reset your Relay password. It expires in 30 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`
              }),
              signal: AbortSignal.timeout(10000)
            });
          } catch (error) {
            database.prepare("DELETE FROM product_password_resets WHERE token_hash = ?").run(tokenHash);
            throw error;
          }
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            database.prepare("DELETE FROM product_password_resets WHERE token_hash = ?").run(tokenHash);
            console.error(JSON.stringify({
              event: "password_reset_email_failed",
              provider_status: response.status
            }));
            return sendError(res, 502, "The recovery email could not be sent. Please try again later.");
          }
          if (result.error) {
            database.prepare("DELETE FROM product_password_resets WHERE token_hash = ?").run(tokenHash);
            console.error(JSON.stringify({ event: "password_reset_email_failed", provider_error: String(result.error).slice(0, 200) }));
            return sendError(res, 502, "The recovery email could not be sent. Please try again later.");
          }
        }
        return res.status(202).json({
          message: "If an account matches that email, a password recovery link will be sent."
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: "password_reset_request_failed",
          message: error.message
        }));
        return sendError(res, 500, "Password recovery could not be started. Please try again.");
      }
    });

  app.post("/api/product/auth/password-reset/complete", sameOrigin,
    limitRequests("password-reset-complete", 10, 60 * 60 * 1000, "Too many attempts. Try again later."),
    async (req, res) => {
      const token = typeof req.body.token === "string" ? req.body.token : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || password.length < 12 || password.length > 128) {
        return sendError(res, 400, "Use a valid recovery link and a password between 12 and 128 characters.");
      }
      try {
        const tokenHash = hashToken(token);
        const reset = database.prepare(`
          SELECT user_id FROM product_password_resets
          WHERE token_hash = ? AND expires_at > ?
        `).get(tokenHash, new Date().toISOString());
        if (!reset) return sendError(res, 400, "This recovery link is invalid or expired. Request a new one.");
        const passwordHash = await makePasswordHash(password);
        const completeReset = database.transaction(() => {
          const used = database.prepare(`
            DELETE FROM product_password_resets
            WHERE token_hash = ? AND expires_at > ?
          `).run(tokenHash, new Date().toISOString());
          if (!used.changes) return false;
          database.prepare("UPDATE product_users SET password_hash = ? WHERE id = ?")
            .run(passwordHash, reset.user_id);
          database.prepare("DELETE FROM product_sessions WHERE user_id = ?").run(reset.user_id);
          database.prepare("DELETE FROM product_password_resets WHERE user_id = ?").run(reset.user_id);
          return true;
        });
        if (!completeReset()) return sendError(res, 400, "This recovery link is invalid or expired. Request a new one.");
        return res.json({ message: "Password updated. Sign in with your new password." });
      } catch (error) {
        console.error("Password reset could not be completed:", error.message);
        return sendError(res, 500, "The password could not be updated. Please try again.");
      }
    });

  app.post("/api/product/auth/login", sameOrigin,
    limitRequests("login", 10, 15 * 60 * 1000, "Too many sign-in attempts. Please wait 15 minutes and try again."),
    async (req, res) => {
    const email = requiredText(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || password.length > 128) return sendError(res, 401, "Email or password is incorrect.");
    const inviteToken = typeof req.body.inviteToken === "string" ? req.body.inviteToken : "";
    if (inviteToken && !/^[A-Za-z0-9_-]{40,60}$/.test(inviteToken)) {
      return sendError(res, 400, "This invitation is invalid or expired.");
    }

    try {
      const record = database.prepare(`
        SELECT u.id, u.email, u.password_hash, w.id AS workspace_id, w.name AS workspace_name, m.role
        FROM product_users u
        JOIN product_memberships m ON m.user_id = u.id
        JOIN product_workspaces w ON w.id = m.workspace_id
        WHERE u.email = ?
        ORDER BY m.role = 'owner' DESC, w.id
        LIMIT 1
      `).get(email);
      if (!record || !(await checkPassword(password, record.password_hash))) {
        return sendError(res, 401, "Email or password is incorrect.");
      }

      let workspace = {
        id: record.workspace_id,
        name: record.workspace_name,
        role: record.role
      };
      if (inviteToken) {
        const invite = database.prepare(`
          SELECT id, workspace_id, invited_email
          FROM product_workspace_invites
          WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?
        `).get(hashToken(inviteToken), new Date().toISOString());
        if (!invite || invite.invited_email.toLowerCase() !== email) {
          return sendError(res, 400, "This invitation is invalid, expired, or addressed to a different email.");
        }
        const acceptInvite = database.transaction(() => {
          const accepted = database.prepare(`
            UPDATE product_workspace_invites SET accepted_at = CURRENT_TIMESTAMP
            WHERE id = ? AND accepted_at IS NULL AND expires_at > ?
          `).run(invite.id, new Date().toISOString());
          if (!accepted.changes) {
            const error = new Error("This invitation has already been used or has expired.");
            error.code = "INVITE_INVALID";
            throw error;
          }
          database.prepare(
            "INSERT INTO product_memberships (workspace_id, user_id, role) VALUES (?, ?, 'member')"
          ).run(invite.workspace_id, record.id);
          return database.prepare(
            "SELECT id, name FROM product_workspaces WHERE id = ?"
          ).get(invite.workspace_id);
          });
        try {
          const joinedWorkspace = acceptInvite();
          workspace = { ...joinedWorkspace, role: "member" };
        } catch (error) {
          if (error.code === "INVITE_INVALID") return sendError(res, 409, error.message);
          if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
            return sendError(res, 409, "This account is already a member of the invited workspace.");
          }
          throw error;
        }
      }

      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
      database.prepare(
        "INSERT INTO product_sessions (token_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)"
      ).run(hashToken(rawToken), record.id, workspace.id, expiresAt);
      setSessionCookie(res, rawToken, isProduction);
      return res.json({
        user: { id: record.id, email: record.email },
        workspace
      });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return sendError(res, 409, "This account is already a member of the invited workspace.");
      }
      console.error("Product sign-in failed:", error.message);
      return sendError(res, 500, "Sign-in could not be completed. Please try again.");
    }
  });

  app.post("/api/product/auth/logout", sameOrigin, (req, res) => {
    const token = cookieToken(req);
    if (token) database.prepare("DELETE FROM product_sessions WHERE token_hash = ?").run(hashToken(token));
    clearSessionCookie(res, isProduction);
    return res.json({ success: true });
  });

  function requireSession(req, res, next) {
    const token = cookieToken(req);
    if (!token) return sendError(res, 401, "Sign in to continue.");
    const session = database.prepare(`
      SELECT s.user_id, s.workspace_id, s.expires_at, u.email, w.name AS workspace_name, m.role
      FROM product_sessions s
      JOIN product_users u ON u.id = s.user_id
      JOIN product_workspaces w ON w.id = s.workspace_id
      JOIN product_memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
      WHERE s.token_hash = ?
    `).get(hashToken(token));
    if (!session || Date.parse(session.expires_at) <= Date.now()) {
      if (session) database.prepare("DELETE FROM product_sessions WHERE token_hash = ?").run(hashToken(token));
      clearSessionCookie(res, isProduction);
      return sendError(res, 401, "Your session expired. Sign in again.");
    }
    req.product = {
      userId: session.user_id,
      workspaceId: session.workspace_id,
      email: session.email,
      workspaceName: session.workspace_name,
      role: session.role
    };
    return next();
  }

  app.get("/api/product/me", requireSession, (req, res) => res.json({
    user: { id: req.product.userId, email: req.product.email },
    workspace: { id: req.product.workspaceId, name: req.product.workspaceName, role: req.product.role }
  }));

  app.get("/api/product/account-deletion/workspaces", requireSession, (req, res) => {
    const workspaces = database.prepare(`
      SELECT w.id, w.name, m.role,
        (SELECT COUNT(*) FROM product_memberships all_members WHERE all_members.workspace_id = w.id) AS member_count
      FROM product_memberships m
      JOIN product_workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ?
      ORDER BY w.name COLLATE NOCASE, w.id
    `).all(req.product.userId);
    const members = database.prepare(`
      SELECT workspace_id, user_id, email
      FROM product_memberships m
      JOIN product_users u ON u.id = m.user_id
      WHERE m.workspace_id IN (
        SELECT workspace_id FROM product_memberships WHERE user_id = ?
      ) AND m.user_id != ?
      ORDER BY email COLLATE NOCASE
    `).all(req.product.userId, req.product.userId);
    const membersByWorkspace = new Map();
    for (const member of members) {
      const workspaceMembers = membersByWorkspace.get(member.workspace_id) || [];
      workspaceMembers.push({ userId: member.user_id, email: member.email });
      membersByWorkspace.set(member.workspace_id, workspaceMembers);
    }
    return res.json({
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        members: membersByWorkspace.get(workspace.id) || []
      }))
    });
  });

  app.delete("/api/product/account", sameOrigin, limitRequests(
    "account-deletion", 5, 15 * 60 * 1000, "Too many deletion attempts. Please wait and try again."
  ), requireSession, async (req, res) => {
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (password.length < 1 || password.length > 128 || req.body.confirmation !== "DELETE") {
      return sendError(res, 400, "Enter your password and type DELETE to confirm account deletion.");
    }

    const user = database.prepare("SELECT password_hash FROM product_users WHERE id = ?")
      .get(req.product.userId);
    if (!user || !(await checkPassword(password, user.password_hash))) {
      return sendError(res, 401, "Your password is incorrect. Your account has not been deleted.");
    }

    const requestedTransfers = req.body.transfers;
    if (!Array.isArray(requestedTransfers) || requestedTransfers.length > 100) {
      return sendError(res, 400, "Review your workspace ownership choices and try again.");
    }
    const transferByWorkspace = new Map();
    for (const transfer of requestedTransfers) {
      const workspaceId = validId(transfer?.workspaceId);
      const newOwnerUserId = validId(transfer?.newOwnerUserId);
      if (!workspaceId || !newOwnerUserId || transferByWorkspace.has(workspaceId)) {
        return sendError(res, 400, "Review your workspace ownership choices and try again.");
      }
      transferByWorkspace.set(workspaceId, newOwnerUserId);
    }

    const deleteAccount = database.transaction(() => {
      const memberships = database.prepare(`
        SELECT m.workspace_id, m.role,
          (SELECT COUNT(*) FROM product_memberships all_members
            WHERE all_members.workspace_id = m.workspace_id) AS member_count
        FROM product_memberships m
        WHERE m.user_id = ?
        ORDER BY m.workspace_id
      `).all(req.product.userId);
      const requiredTransfers = new Set();
      for (const membership of memberships) {
        if (membership.member_count <= 1) continue;
        if (membership.role !== "owner") continue;
        requiredTransfers.add(membership.workspace_id);
        const newOwnerUserId = transferByWorkspace.get(membership.workspace_id);
        const newOwner = newOwnerUserId && database.prepare(`
          SELECT user_id FROM product_memberships
          WHERE workspace_id = ? AND user_id = ? AND user_id != ?
        `).get(membership.workspace_id, newOwnerUserId, req.product.userId);
        if (!newOwner) {
          throw new Error("Choose a remaining workspace member to become the owner before deleting your account.");
        }
      }
      if ([...transferByWorkspace.keys()].some((workspaceId) => !requiredTransfers.has(workspaceId))) {
        throw new Error("A workspace ownership choice is no longer valid. Refresh and try again.");
      }

      for (const membership of memberships) {
        if (membership.member_count <= 1) {
          database.prepare("DELETE FROM product_workspaces WHERE id = ?").run(membership.workspace_id);
          continue;
        }
        if (membership.role === "owner") {
          database.prepare(`
            UPDATE product_memberships SET role = 'owner'
            WHERE workspace_id = ? AND user_id = ?
          `).run(membership.workspace_id, transferByWorkspace.get(membership.workspace_id));
        }
        database.prepare("DELETE FROM product_memberships WHERE workspace_id = ? AND user_id = ?")
          .run(membership.workspace_id, req.product.userId);
      }

      database.prepare("UPDATE product_process_steps SET assignee_user_id = NULL WHERE assignee_user_id = ?")
        .run(req.product.userId);
      database.prepare("UPDATE product_implementation_steps SET assignee_user_id = NULL WHERE assignee_user_id = ?")
        .run(req.product.userId);
      database.prepare("DELETE FROM product_users WHERE id = ?").run(req.product.userId);
    });

    try {
      deleteAccount();
    } catch (error) {
      if (error instanceof Error && /workspace member|ownership choice/.test(error.message)) {
        return sendError(res, 409, error.message);
      }
      throw error;
    }
    clearSessionCookie(res, isProduction);
    return res.json({ success: true });
  });

  app.get("/api/product/onboarding", requireSession, (req, res) => {
    const onboarding = database.prepare(
      "SELECT dismissed FROM product_user_onboarding WHERE user_id = ?"
    ).get(req.product.userId);
    return res.json({ dismissed: Boolean(onboarding?.dismissed) });
  });

  app.patch("/api/product/onboarding", sameOrigin, requireSession, (req, res) => {
    if (typeof req.body.dismissed !== "boolean") {
      return sendError(res, 400, "Choose whether to show or dismiss the getting-started guide.");
    }
    database.prepare(`
      INSERT INTO product_user_onboarding (user_id, dismissed, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        dismissed = excluded.dismissed,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.product.userId, Number(req.body.dismissed));
    return res.json({ dismissed: req.body.dismissed });
  });

  app.get("/api/product/preferences", requireSession, (req, res) => {
    const preferences = database.prepare(`
      SELECT theme, accent FROM product_user_preferences WHERE user_id = ?
    `).get(req.product.userId);
    return res.json(preferences || { theme: "light", accent: "blue" });
  });

  app.patch("/api/product/preferences", sameOrigin, requireSession, (req, res) => {
    const { theme, accent } = req.body;
    if (theme === undefined && accent === undefined) {
      return sendError(res, 400, "Choose a theme mode or accent color to update.");
    }
    if (theme !== undefined && !["light", "dark"].includes(theme)) {
      return sendError(res, 400, "Choose light or dark mode.");
    }
    if (accent !== undefined && !["blue", "teal", "violet", "rose"].includes(accent)) {
      return sendError(res, 400, "Choose one of the available accent colors.");
    }
    const current = database.prepare(`
      SELECT theme, accent FROM product_user_preferences WHERE user_id = ?
    `).get(req.product.userId) || { theme: "light", accent: "blue" };
    const next = {
      theme: theme ?? current.theme,
      accent: accent ?? current.accent
    };
    database.prepare(`
      INSERT INTO product_user_preferences (user_id, theme, accent, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        theme = excluded.theme,
        accent = excluded.accent,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.product.userId, next.theme, next.accent);
    return res.json(next);
  });

  app.get("/api/product/help-chat", requireSession, (req, res) => {
    const messages = database.prepare(`
      SELECT id, role, content, created_at
      FROM (
        SELECT id, role, content, created_at
        FROM product_help_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 50
      )
      ORDER BY id
    `).all(req.product.userId);
    const consent = database.prepare(
      "SELECT 1 FROM product_help_consents WHERE user_id = ?"
    ).get(req.product.userId);
    return res.json({ messages, consented: Boolean(consent) });
  });

  app.delete("/api/product/help-chat", sameOrigin, requireSession, (req, res) => {
    const clearHistory = database.transaction(() => {
      database.prepare("DELETE FROM product_help_messages WHERE user_id = ?").run(req.product.userId);
      database.prepare("DELETE FROM product_help_consents WHERE user_id = ?").run(req.product.userId);
    });
    clearHistory();
    return res.json({ success: true });
  });

  app.post("/api/product/help-chat", sameOrigin, requireSession, async (req, res) => {
    const userId = req.product.userId;
    const message = requiredText(req.body.message, 1200);
    if (!message) return sendError(res, 400, "Enter a Relay question up to 1,200 characters.");

    const alreadyConsented = database.prepare(
      "SELECT 1 FROM product_help_consents WHERE user_id = ?"
    ).get(userId);
    if (!alreadyConsented && req.body.consentAccepted !== true) {
      return sendError(res, 403, "Confirm that your help messages and recent chat history may be processed by Relay’s AI service.");
    }

    const rateLimitResult = rateLimit(`help-chat-user:${userId}`, 12, 10 * 60 * 1000,
      "You’ve sent several help questions. Please wait a few minutes and try again.");
    if (rateLimitResult.limited) return sendError(res, 429, rateLimitResult.message);

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
    if (!apiKey) {
      console.error("Relay Help is not configured: OPENAI_API_KEY is missing.");
      return sendError(res, 503, "Ray is temporarily unavailable. Please contact Relay support.");
    }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) {
      console.error("Relay Help is not configured: OPENAI_MODEL is invalid.");
      return sendError(res, 503, "Ray is temporarily unavailable. Please contact Relay support.");
    }

    if (!alreadyConsented) {
      database.prepare("INSERT INTO product_help_consents (user_id) VALUES (?)").run(userId);
    }

    const previousMessages = database.prepare(`
      SELECT role, content
      FROM (
        SELECT role, content, id
        FROM product_help_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 12
      )
      ORDER BY id
    `).all(userId);

    let response;
    try {
      const apiUrl = process.env.NODE_ENV === "test" && process.env.RELAY_HELP_API_URL
        ? process.env.RELAY_HELP_API_URL
        : "https://api.openai.com/v1/chat/completions";
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: assistantInstructions },
            ...previousMessages,
            { role: "user", content: message }
          ],
          max_completion_tokens: 500
        }),
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "relay_help_provider_failed",
        reason: error.name === "TimeoutError" ? "timeout" : "request_error",
        message: error.message
      }));
      return sendError(res, 503, "Ray could not connect right now. Please try again shortly.");
    }

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(JSON.stringify({
        event: "relay_help_provider_failed",
        provider_status: response.status
      }));
      return sendError(res, 503, "Ray could not answer right now. Please try again shortly.");
    }
    const answer = result.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim() || answer.length > 4000) {
      console.error(JSON.stringify({ event: "relay_help_provider_invalid_response" }));
      return sendError(res, 502, "Ray received an invalid answer. Please try again.");
    }

    const saveMessages = database.transaction(() => {
      const insert = database.prepare(
        "INSERT INTO product_help_messages (user_id, role, content) VALUES (?, ?, ?)"
      );
      insert.run(userId, "user", message);
      const assistantMessage = insert.run(userId, "assistant", answer.trim());
      database.prepare(`
        DELETE FROM product_help_messages
        WHERE user_id = ? AND id NOT IN (
          SELECT id FROM product_help_messages WHERE user_id = ? ORDER BY id DESC LIMIT 50
        )
      `).run(userId, userId);
      return database.prepare(
        "SELECT id, role, content, created_at FROM product_help_messages WHERE id = ? AND user_id = ?"
      ).get(assistantMessage.lastInsertRowid, userId);
    });

    return res.json({ message: saveMessages() });
  });

  app.get("/api/product/workspace", requireSession, (req, res) => {
    const workspaceId = req.product.workspaceId;
    const processes = database.prepare(`
      SELECT p.id, p.name, p.description, p.updated_at,
        (SELECT COUNT(*) FROM product_process_steps s WHERE s.process_id = p.id) AS steps_count,
        EXISTS (
          SELECT 1 FROM product_setup_checks c
          WHERE c.process_id = p.id AND c.process_revision = p.revision AND c.result = 'ready'
        ) AS checked
      FROM product_processes p
      WHERE p.workspace_id = ?
      ORDER BY p.updated_at DESC, p.id DESC
    `).all(workspaceId);
    const templates = database.prepare(
      "SELECT id, name, created_at, updated_at, revision, (SELECT COUNT(*) FROM json_each(steps_json)) AS step_count FROM product_templates WHERE workspace_id = ? ORDER BY created_at DESC, id DESC"
    ).all(workspaceId);
    const implementations = database.prepare(`
      SELECT i.id, i.template_id, i.customer_name, i.created_at, t.name AS template_name,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id) AS total_steps,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status != 'done') AS open_steps,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status = 'done') AS completed_steps,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status = 'in_progress') AS in_progress_steps,
        (SELECT GROUP_CONCAT(DISTINCT s.assignee_user_id) FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.assignee_user_id IS NOT NULL) AS assigned_member_ids,
        (SELECT COUNT(*) FROM product_implementation_steps s WHERE s.implementation_id = i.id AND s.status != 'done' AND s.assignee_user_id IS NULL) AS unowned_steps,
        (SELECT GROUP_CONCAT(s.title, ', ') FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done' AND s.assignee_user_id IS NULL) AS unowned_step_names,
        (SELECT COUNT(*) FROM product_requirements r
          LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = i.id
          WHERE r.workspace_id = i.workspace_id AND (r.template_id IS NULL OR r.template_id = i.template_id)
            AND r.required = 1 AND TRIM(COALESCE(c.value, '')) = '') AS missing_inputs,
        (SELECT GROUP_CONCAT(r.name, ', ') FROM product_requirements r
          LEFT JOIN product_customer_inputs c ON c.requirement_id = r.id AND c.implementation_id = i.id
          WHERE r.workspace_id = i.workspace_id AND (r.template_id IS NULL OR r.template_id = i.template_id)
            AND r.required = 1 AND TRIM(COALESCE(c.value, '')) = '') AS missing_input_names,
        (SELECT COUNT(*) FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done' AND s.is_blocked = 1) AS blocked_steps,
        (SELECT GROUP_CONCAT(s.title, ', ') FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done' AND s.is_blocked = 1) AS blocked_step_names,
        (SELECT COUNT(*) FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done'
            AND s.due_at != '' AND s.due_at < date('now')) AS overdue_steps,
        (SELECT GROUP_CONCAT(s.title, ', ') FROM product_implementation_steps s
          WHERE s.implementation_id = i.id AND s.status != 'done'
            AND s.due_at != '' AND s.due_at < date('now')) AS overdue_step_names,
        (SELECT COUNT(DISTINCT s.id) FROM product_implementation_steps s
          JOIN product_implementation_step_dependencies d ON d.implementation_step_id = s.id
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE s.implementation_id = i.id AND s.status != 'done' AND parent.status != 'done') AS waiting_steps,
        (SELECT GROUP_CONCAT(DISTINCT s.title) FROM product_implementation_steps s
          JOIN product_implementation_step_dependencies d ON d.implementation_step_id = s.id
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE s.implementation_id = i.id AND s.status != 'done' AND parent.status != 'done') AS waiting_step_names
      FROM product_implementations i
      JOIN product_templates t ON t.id = i.template_id
      WHERE i.workspace_id = ?
      ORDER BY i.created_at DESC, i.id DESC
    `).all(workspaceId);
    for (const implementation of implementations) {
      const scopedRequirements = implementationRequirements(implementation.id, workspaceId, implementation.template_id);
      const invalid = scopedRequirements.filter((requirement) => {
        const value = requirement.value.trim();
        return value && inputValueError(requirement.input_type, value);
      });
      implementation.invalid_inputs = invalid.length;
      implementation.invalid_input_names = invalid.map((requirement) => requirement.name).join(", ");
      implementation.missing_inputs += invalid.length;
      if (invalid.length) {
        implementation.missing_input_names = [implementation.missing_input_names, implementation.invalid_input_names]
          .filter(Boolean).join(", ");
      }
    }
    const requirements = database.prepare(
      "SELECT id, name, description, required, input_type, template_id FROM product_requirements WHERE workspace_id = ? ORDER BY id"
    ).all(workspaceId);
    const members = database.prepare(`
      SELECT u.id, u.email, m.role
      FROM product_memberships m JOIN product_users u ON u.id = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY m.role = 'owner' DESC, u.email
    `).all(workspaceId);
    const invites = database.prepare(`
      SELECT id, invited_email, expires_at, created_at
      FROM product_workspace_invites
      WHERE workspace_id = ? AND accepted_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC
    `).all(workspaceId, new Date().toISOString());
    return res.json({ processes, templates, implementations, requirements, members, invites, role: req.product.role });
  });

  app.post("/api/product/invites", sameOrigin, requireSession, (req, res) => {
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can invite teammates.");
    const email = requiredText(req.body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "Enter a valid teammate email address.");
    const existingUser = database.prepare("SELECT id FROM product_users WHERE email = ?").get(email);
    if (existingUser && database.prepare(
      "SELECT 1 FROM product_memberships WHERE workspace_id = ? AND user_id = ?"
    ).get(req.product.workspaceId, existingUser.id)) {
      return sendError(res, 409, "This account is already a member of your workspace.");
    }
    const activeInvite = database.prepare(`
      SELECT id FROM product_workspace_invites
      WHERE workspace_id = ? AND invited_email = ? AND accepted_at IS NULL AND expires_at > ?
    `).get(req.product.workspaceId, email, new Date().toISOString());
    if (activeInvite) return sendError(res, 409, "An active invitation already exists for this email.");
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const invite = database.prepare(`
      INSERT INTO product_workspace_invites (workspace_id, invited_email, token_hash, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?) RETURNING id
    `).get(req.product.workspaceId, email, hashToken(rawToken), expiresAt, req.product.userId);
    const inviteUrl = new URL(`/product.html?invite=${encodeURIComponent(rawToken)}`, req.get("Origin")).toString();
    return res.status(201).json({ invite: { id: invite.id, email, expiresAt, inviteUrl } });
  });

  app.delete("/api/product/invites/:inviteId", sameOrigin, requireSession, (req, res) => {
    if (req.product.role !== "owner") return sendError(res, 403, "Only a workspace owner can revoke invitations.");
    const inviteId = validId(req.params.inviteId);
    if (!inviteId) return sendError(res, 400, "Invalid invitation.");
    const result = database.prepare(
      "DELETE FROM product_workspace_invites WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL"
    ).run(inviteId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Invitation not found or already accepted.");
    return res.json({ success: true });
  });

  app.post("/api/product/processes", sameOrigin, requireSession, (req, res) => {
    const name = requiredText(req.body.name, 100);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    if (!name) return sendError(res, 400, "Give this onboarding process a name.");
    const process = database.prepare(
      "INSERT INTO product_processes (workspace_id, name, description) VALUES (?, ?, ?) RETURNING id, name, description, updated_at"
    ).get(req.product.workspaceId, name, description);
    return res.status(201).json({ process });
  });

  app.patch("/api/product/processes/:processId", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    const name = requiredText(req.body.name, 100);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    if (!processId || !name) return sendError(res, 400, "Give this onboarding process a valid name.");
    const result = database.prepare(`
      UPDATE product_processes SET name = ?, description = ?, revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?
    `).run(name, description, processId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Process not found.");
    return res.json({ success: true });
  });

  app.delete("/api/product/processes/:processId", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    if (!processId) return sendError(res, 400, "Invalid process.");
    const process = database.prepare(
      "SELECT id FROM product_processes WHERE id = ? AND workspace_id = ?"
    ).get(processId, req.product.workspaceId);
    if (!process) return sendError(res, 404, "Process not found.");
    const templateCount = database.prepare(
      "SELECT COUNT(*) AS count FROM product_templates WHERE process_id = ?"
    ).get(processId).count;
    if (templateCount) return sendError(res, 409, "This process is used by saved templates. Delete unused templates before deleting the process.");
    database.prepare("DELETE FROM product_processes WHERE id = ?").run(processId);
    return res.json({ success: true });
  });

  app.get("/api/product/processes/:processId", requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    if (!processId) return sendError(res, 400, "Invalid process.");
    const process = database.prepare(`
      SELECT p.id, p.name, p.description, p.revision, p.updated_at,
        EXISTS (
          SELECT 1 FROM product_setup_checks c
          WHERE c.process_id = p.id AND c.process_revision = p.revision AND c.result = 'ready'
        ) AS checked
      FROM product_processes p
      WHERE p.id = ? AND p.workspace_id = ?
    `).get(processId, req.product.workspaceId);
    if (!process) return sendError(res, 404, "Process not found.");
    process.steps = processSteps(processId);
    return res.json({ process });
  });

  app.post("/api/product/processes/:processId/steps", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    const title = requiredText(req.body.title, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const owner = typeof req.body.owner === "string" ? req.body.owner.trim().slice(0, 120) : "";
    const stage = requiredText(req.body.stage || "Implementation", 100);
    const dueOffsetDays = req.body.dueOffsetDays === undefined ? 0 : req.body.dueOffsetDays;
    const assignee = workspaceAssignee(req.product.workspaceId, req.body.assigneeUserId);
    const dependsOn = Array.isArray(req.body.dependsOn) ? req.body.dependsOn.map(validId) : [];
    if (dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length) {
      return sendError(res, 400, "Choose valid, unique prerequisite steps.");
    }
    if (!processId || !title || !stage || !assignee.valid || !Number.isInteger(dueOffsetDays) || dueOffsetDays < 0 || dueOffsetDays > 3650) {
      return sendError(res, 400, "Enter a step name, stage, and valid due-date offset.");
    }
    const process = database.prepare(
      "SELECT id FROM product_processes WHERE id = ? AND workspace_id = ?"
    ).get(processId, req.product.workspaceId);
    if (!process) return sendError(res, 404, "Process not found.");
    const existingSteps = processSteps(processId);
    if (dependsOn.some((id) => !existingSteps.some((step) => step.id === id))) {
      return sendError(res, 400, "A prerequisite must be another step in this process.");
    }
    const createStep = database.transaction(() => {
      const position = database.prepare(
        "SELECT COALESCE(MAX(position), 0) + 1 AS position FROM product_process_steps WHERE process_id = ?"
      ).get(processId).position;
      const step = database.prepare(`
        INSERT INTO product_process_steps
          (process_id, title, description, owner, position, stage, due_offset_days, assignee_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, title, description, owner, position, stage, due_offset_days, assignee_user_id
      `).get(processId, title, description, owner, position, stage, dueOffsetDays, assignee.id);
      const addDependency = database.prepare(
        "INSERT INTO product_process_step_dependencies (process_step_id, depends_on_step_id) VALUES (?, ?)"
      );
      for (const dependencyId of dependsOn) addDependency.run(step.id, dependencyId);
      database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(processId);
      return step;
    });
    const step = createStep();
    return res.status(201).json({ step });
  });

  app.patch("/api/product/processes/:processId/steps/:stepId", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    const stepId = validId(req.params.stepId);
    const title = requiredText(req.body.title, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const owner = typeof req.body.owner === "string" ? req.body.owner.trim().slice(0, 120) : "";
    const stage = requiredText(req.body.stage, 100);
    const dueOffsetDays = req.body.dueOffsetDays;
    const assignee = workspaceAssignee(req.product.workspaceId, req.body.assigneeUserId);
    const dependsOn = Array.isArray(req.body.dependsOn) ? req.body.dependsOn.map(validId) : null;
    if (!processId || !stepId || !title || !stage || !Number.isInteger(dueOffsetDays)
      || dueOffsetDays < 0 || dueOffsetDays > 3650 || !dependsOn
      || dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length || !assignee.valid
      || dependsOn.includes(stepId)) {
      return sendError(res, 400, "Enter valid step details and prerequisites.");
    }
    const steps = processSteps(processId);
    const step = steps.find((item) => item.id === stepId);
    if (!step || !database.prepare("SELECT id FROM product_processes WHERE id = ? AND workspace_id = ?").get(processId, req.product.workspaceId)) {
      return sendError(res, 404, "Process step not found.");
    }
    if (dependsOn.some((id) => !steps.some((item) => item.id === id))) {
      return sendError(res, 400, "A prerequisite must be another step in this process.");
    }
    const proposed = steps.map((item) => ({
      ...item,
      dependsOn: item.id === stepId ? dependsOn : item.dependsOn
    }));
    if (hasCycle(proposed)) return sendError(res, 400, "Prerequisites cannot form a cycle.");
    const updateStep = database.transaction(() => {
      database.prepare(`
        UPDATE product_process_steps SET title = ?, description = ?, owner = ?, stage = ?,
          due_offset_days = ?, assignee_user_id = ? WHERE id = ? AND process_id = ?
      `).run(title, description, owner, stage, dueOffsetDays, assignee.id, stepId, processId);
      database.prepare("DELETE FROM product_process_step_dependencies WHERE process_step_id = ?").run(stepId);
      const addDependency = database.prepare(
        "INSERT INTO product_process_step_dependencies (process_step_id, depends_on_step_id) VALUES (?, ?)"
      );
      for (const dependencyId of dependsOn) addDependency.run(stepId, dependencyId);
      database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(processId);
    });
    updateStep();
    return res.json({ success: true });
  });

  app.delete("/api/product/processes/:processId/steps/:stepId", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    const stepId = validId(req.params.stepId);
    if (!processId || !stepId) return sendError(res, 400, "Invalid process step.");
    const process = database.prepare(
      "SELECT id FROM product_processes WHERE id = ? AND workspace_id = ?"
    ).get(processId, req.product.workspaceId);
    if (!process) return sendError(res, 404, "Process not found.");
    const removeStep = database.transaction(() => {
      const removed = database.prepare("DELETE FROM product_process_steps WHERE id = ? AND process_id = ?").run(stepId, processId);
      if (!removed.changes) return false;
      const remaining = database.prepare("SELECT id FROM product_process_steps WHERE process_id = ? ORDER BY position, id").all(processId);
      const setPosition = database.prepare("UPDATE product_process_steps SET position = ? WHERE id = ?");
      remaining.forEach((item, index) => setPosition.run(index + 1, item.id));
      database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(processId);
      return true;
    });
    if (!removeStep()) return sendError(res, 404, "Process step not found.");
    return res.json({ success: true });
  });

  app.put("/api/product/processes/:processId/steps/order", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    const orderedIds = Array.isArray(req.body.stepIds) ? req.body.stepIds.map(validId) : null;
    if (!processId || !orderedIds || orderedIds.some((id) => !id) || new Set(orderedIds).size !== orderedIds.length) {
      return sendError(res, 400, "Provide the complete ordered list of process steps.");
    }
    if (!database.prepare("SELECT id FROM product_processes WHERE id = ? AND workspace_id = ?").get(processId, req.product.workspaceId)) {
      return sendError(res, 404, "Process not found.");
    }
    const steps = processSteps(processId);
    if (steps.length !== orderedIds.length || steps.some((step) => !orderedIds.includes(step.id))) {
      return sendError(res, 400, "The ordered list must contain every process step exactly once.");
    }
    const positions = new Map(orderedIds.map((id, index) => [id, index + 1]));
    for (const step of steps) {
      if (step.dependsOn.some((dependencyId) => positions.get(dependencyId) >= positions.get(step.id))) {
        return sendError(res, 400, "A prerequisite must appear before the step that depends on it.");
      }
    }
    const reorder = database.transaction(() => {
      const updatePosition = database.prepare("UPDATE product_process_steps SET position = ? WHERE id = ? AND process_id = ?");
      for (const [id, position] of positions) updatePosition.run(position, id, processId);
      database.prepare("UPDATE product_processes SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(processId);
    });
    reorder();
    return res.json({ success: true });
  });

  app.post("/api/product/processes/:processId/test", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.params.processId);
    if (!processId) return sendError(res, 400, "Invalid process.");
    const process = database.prepare(
      "SELECT id, revision FROM product_processes WHERE id = ? AND workspace_id = ?"
    ).get(processId, req.product.workspaceId);
    if (!process) return sendError(res, 404, "Process not found.");
    const steps = processSteps(processId);
    const findings = [];
    if (steps.length === 0) findings.push("Add at least one step before handing over this process.");
    steps.forEach((step, index) => {
      if (!step.description) findings.push(`Step ${index + 1} (“${step.title}”) needs a short instruction.`);
      if (!step.owner) findings.push(`Step ${index + 1} (“${step.title}”) needs an owner.`);
      if (!step.assignee_user_id) findings.push(`Step ${index + 1} (“${step.title}”) needs an assigned workspace member.`);
      if (step.dependsOn.some((dependencyId) => steps.findIndex((candidate) => candidate.id === dependencyId) >= index)) {
        findings.push(`Step “${step.title}” must appear after its prerequisite steps.`);
      }
    });
    if (hasCycle(steps)) findings.push("Resolve the circular prerequisites before handing over this process.");
    const result = steps.length > 0 && findings.length === 0 ? "ready" : "needs_attention";
    const check = database.prepare(
      "INSERT INTO product_setup_checks (workspace_id, process_id, process_revision, result, findings_json) VALUES (?, ?, ?, ?, ?) RETURNING id, result, created_at"
    ).get(req.product.workspaceId, processId, process.revision, result, JSON.stringify(findings));
    return res.json({
      check,
      findings,
      stepsChecked: steps.length,
      handover: result === "ready" ? steps.map((step, index) => ({
        number: index + 1,
        title: step.title,
        description: step.description,
        owner: step.owner,
        assigneeUserId: step.assignee_user_id,
        assigneeEmail: step.assignee_email,
        stage: step.stage,
        dueOffsetDays: step.due_offset_days,
        dependsOn: step.dependsOn.map((id) => steps.find((candidate) => candidate.id === id)?.title).filter(Boolean)
      })) : []
    });
  });

  app.post("/api/product/templates", sameOrigin, requireSession, (req, res) => {
    const processId = validId(req.body.processId);
    const name = requiredText(req.body.name, 100);
    if (!processId || !name) return sendError(res, 400, "Choose a process and name the reusable template.");
    const process = database.prepare(
      "SELECT id, revision FROM product_processes WHERE id = ? AND workspace_id = ?"
    ).get(processId, req.product.workspaceId);
    if (!process) return sendError(res, 404, "Process not found.");
    const latestCheck = database.prepare(`
      SELECT result FROM product_setup_checks
      WHERE process_id = ? AND process_revision = ?
      ORDER BY id DESC LIMIT 1
    `).get(processId, process.revision);
    if (!latestCheck || latestCheck.result !== "ready") {
      return sendError(res, 409, "Run a successful setup check for the current process before saving a reusable template.");
    }
    const steps = processSteps(processId);
    if (steps.length === 0) return sendError(res, 400, "Add at least one process step before saving a template.");
    const stepPositions = new Map(steps.map((step) => [step.id, step.position]));
    const snapshot = steps.map((step) => ({
      title: step.title,
      description: step.description,
      owner: step.owner,
      assigneeUserId: step.assignee_user_id,
      assigneeEmail: step.assignee_email,
      stage: step.stage,
      dueOffsetDays: step.due_offset_days,
      position: step.position,
      dependsOnPositions: step.dependsOn.map((id) => stepPositions.get(id)).filter(Number.isInteger)
    }));
    const createTemplate = database.transaction(() => {
      const template = database.prepare(
        "INSERT INTO product_templates (workspace_id, process_id, name, steps_json, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id, name, created_at, revision"
      ).get(req.product.workspaceId, processId, name, JSON.stringify(snapshot));
      database.prepare(
        "INSERT INTO product_template_versions (template_id, revision, name, steps_json) VALUES (?, ?, ?, ?)"
      ).run(template.id, template.revision, template.name, JSON.stringify(snapshot));
      return template;
    });
    const template = createTemplate();
    return res.status(201).json({ template });
  });

  app.get("/api/product/templates/:templateId/versions", requireSession, (req, res) => {
    const templateId = validId(req.params.templateId);
    if (!templateId) return sendError(res, 400, "Invalid template.");
    const template = database.prepare(
      "SELECT id FROM product_templates WHERE id = ? AND workspace_id = ?"
    ).get(templateId, req.product.workspaceId);
    if (!template) return sendError(res, 404, "Template not found.");
    const versions = database.prepare(`
      SELECT revision, name, steps_json, created_at
      FROM product_template_versions
      WHERE template_id = ?
      ORDER BY revision DESC
    `).all(templateId).map((version) => ({
      revision: version.revision,
      name: version.name,
      created_at: version.created_at,
      steps: JSON.parse(version.steps_json).map((step) => step.title)
    }));
    return res.json({ versions });
  });

  app.post("/api/product/templates/:templateId/versions/:revision/restore", sameOrigin, requireSession, (req, res) => {
    const templateId = validId(req.params.templateId);
    const revision = validId(req.params.revision);
    if (!templateId || !revision) return sendError(res, 400, "Choose a valid template version.");
    const template = database.prepare(
      "SELECT id, revision FROM product_templates WHERE id = ? AND workspace_id = ?"
    ).get(templateId, req.product.workspaceId);
    if (!template) return sendError(res, 404, "Template not found.");
    const version = database.prepare(`
      SELECT name, steps_json FROM product_template_versions
      WHERE template_id = ? AND revision = ?
    `).get(templateId, revision);
    if (!version) return sendError(res, 404, "Template version not found.");
    const restoreVersion = database.transaction(() => {
      const nextRevision = template.revision + 1;
      database.prepare(`
        UPDATE product_templates SET name = ?, steps_json = ?, revision = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?
      `).run(version.name, version.steps_json, nextRevision, templateId, req.product.workspaceId);
      database.prepare(
        "INSERT INTO product_template_versions (template_id, revision, name, steps_json) VALUES (?, ?, ?, ?)"
      ).run(templateId, nextRevision, version.name, version.steps_json);
    });
    restoreVersion();
    return res.json({ success: true });
  });

  app.patch("/api/product/templates/:templateId", sameOrigin, requireSession, (req, res) => {
    const templateId = validId(req.params.templateId);
    const name = requiredText(req.body.name, 100);
    const refreshFromProcess = req.body.refreshFromProcess === true;
    if (!templateId || !name) return sendError(res, 400, "Give this reusable template a valid name.");
    const template = database.prepare(
      "SELECT id, process_id, revision, steps_json FROM product_templates WHERE id = ? AND workspace_id = ?"
    ).get(templateId, req.product.workspaceId);
    if (!template) return sendError(res, 404, "Template not found.");
    let stepsJson;
    if (refreshFromProcess) {
      const process = database.prepare(
        "SELECT id, revision FROM product_processes WHERE id = ? AND workspace_id = ?"
      ).get(template.process_id, req.product.workspaceId);
      const latestCheck = database.prepare(`
        SELECT result FROM product_setup_checks
        WHERE process_id = ? AND process_revision = ?
        ORDER BY id DESC LIMIT 1
      `).get(template.process_id, process.revision);
      if (!latestCheck || latestCheck.result !== "ready") {
        return sendError(res, 409, "Run a successful setup check for the current process before refreshing this template.");
      }
      const steps = processSteps(template.process_id);
      const positions = new Map(steps.map((step) => [step.id, step.position]));
      stepsJson = JSON.stringify(steps.map((step) => ({
        title: step.title,
        description: step.description,
        owner: step.owner,
        assigneeUserId: step.assignee_user_id,
        assigneeEmail: step.assignee_email,
        stage: step.stage,
        dueOffsetDays: step.due_offset_days,
        position: step.position,
        dependsOnPositions: step.dependsOn.map((id) => positions.get(id)).filter(Number.isInteger)
      })));
    }
    const nextStepsJson = stepsJson === undefined ? template.steps_json : stepsJson;
    const nextRevision = template.revision + 1;
    const saveVersion = database.transaction(() => {
      database.prepare(`
        UPDATE product_templates SET name = ?, steps_json = ?, revision = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?
      `).run(name, nextStepsJson, nextRevision, templateId, req.product.workspaceId);
      database.prepare(
        "INSERT INTO product_template_versions (template_id, revision, name, steps_json) VALUES (?, ?, ?, ?)"
      ).run(templateId, nextRevision, name, nextStepsJson);
    });
    saveVersion();
    return res.json({ success: true });
  });

  app.delete("/api/product/templates/:templateId", sameOrigin, requireSession, (req, res) => {
    const templateId = validId(req.params.templateId);
    if (!templateId) return sendError(res, 400, "Invalid template.");
    const implementationCount = database.prepare(
      "SELECT COUNT(*) AS count FROM product_implementations WHERE template_id = ? AND workspace_id = ?"
    ).get(templateId, req.product.workspaceId).count;
    if (implementationCount) return sendError(res, 409, "This template is used by existing implementations and cannot be deleted.");
    const result = database.prepare(
      "DELETE FROM product_templates WHERE id = ? AND workspace_id = ?"
    ).run(templateId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Template not found.");
    return res.json({ success: true });
  });

  app.post("/api/product/implementations", sameOrigin, requireSession, (req, res) => {
    const templateId = validId(req.body.templateId);
    const customerName = requiredText(req.body.customerName, 120);
    if (!templateId || !customerName) return sendError(res, 400, "Choose a template and enter the customer’s company name.");
    const template = database.prepare(
      "SELECT id, name, steps_json FROM product_templates WHERE id = ? AND workspace_id = ?"
    ).get(templateId, req.product.workspaceId);
    if (!template) return sendError(res, 404, "Template not found.");
    const steps = JSON.parse(template.steps_json);
    if (!Array.isArray(steps) || steps.length === 0) return sendError(res, 409, "This template has no steps. Create a new template from a process with steps.");

    const rawPortalToken = randomBytes(32).toString("base64url");
    const createImplementation = database.transaction(() => {
      const implementation = database.prepare(
        "INSERT INTO product_implementations (workspace_id, template_id, customer_name, portal_token_hash) VALUES (?, ?, ?, ?) RETURNING id, customer_name, created_at"
      ).get(req.product.workspaceId, templateId, customerName, hashToken(rawPortalToken));
      const insertStep = database.prepare(
        `INSERT INTO product_implementation_steps
          (implementation_id, title, description, owner, position, due_at, stage, assignee_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const stepIdsByPosition = new Map();
      for (const step of steps) {
        const dueDate = new Date();
        dueDate.setUTCHours(0, 0, 0, 0);
        dueDate.setUTCDate(dueDate.getUTCDate() + (Number.isInteger(step.dueOffsetDays) ? step.dueOffsetDays : 0));
        const inserted = insertStep.run(
          implementation.id,
          step.title,
          step.description || "",
          step.owner || "",
          step.position,
          Number.isInteger(step.dueOffsetDays) ? dueDate.toISOString().slice(0, 10) : "",
          step.stage || "Implementation",
          step.assigneeUserId || null
        );
        stepIdsByPosition.set(step.position, inserted.lastInsertRowid);
      }
      const addDependency = database.prepare(
        "INSERT INTO product_implementation_step_dependencies (implementation_step_id, depends_on_step_id) VALUES (?, ?)"
      );
      for (const step of steps) {
        for (const dependencyPosition of step.dependsOnPositions || []) {
          const dependencyId = stepIdsByPosition.get(dependencyPosition);
          const currentStepId = stepIdsByPosition.get(step.position);
          if (!dependencyId || !currentStepId) throw new Error("Template contains an invalid prerequisite reference.");
          addDependency.run(currentStepId, dependencyId);
        }
      }
      database.prepare(`
        INSERT INTO product_customer_inputs (implementation_id, requirement_id)
        SELECT ?, id FROM product_requirements
        WHERE workspace_id = ? AND (template_id IS NULL OR template_id = ?)
      `).run(implementation.id, req.product.workspaceId, templateId);
      return implementation;
    });
    const implementation = createImplementation();
    return res.status(201).json({
      implementation: { ...implementation, template_name: template.name },
      customerPortalToken: rawPortalToken
    });
  });

  app.post("/api/product/implementations/:implementationId/customer-link", sameOrigin, requireSession, (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const implementation = database.prepare(
      "SELECT id FROM product_implementations WHERE id = ? AND workspace_id = ?"
    ).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    const rawToken = randomBytes(32).toString("base64url");
    database.prepare("UPDATE product_implementations SET portal_token_hash = ? WHERE id = ?")
      .run(hashToken(rawToken), implementationId);
    return res.json({ customerPortalToken: rawToken });
  });

  app.get("/api/product/implementations/:implementationId", requireSession, (req, res) => {
    const implementationId = validId(req.params.implementationId);
    if (!implementationId) return sendError(res, 400, "Invalid implementation.");
    const implementation = database.prepare(`
      SELECT i.id, i.customer_name, i.created_at, i.template_id, t.name AS template_name,
        i.portal_token_hash IS NOT NULL AS has_customer_link
      FROM product_implementations i
      JOIN product_templates t ON t.id = i.template_id
      WHERE i.id = ? AND i.workspace_id = ?
    `).get(implementationId, req.product.workspaceId);
    if (!implementation) return sendError(res, 404, "Implementation not found.");
    implementation.steps = database.prepare(`
      SELECT s.id, s.title, s.description, s.owner, s.position, s.status, s.updated_at, s.stage,
        s.assignee_user_id, u.email AS assignee_email,
        s.due_at, s.is_blocked, s.blocker_reason, s.blocker_next_action,
        COALESCE((SELECT GROUP_CONCAT(parent.title, ', ')
          FROM product_implementation_step_dependencies d
          JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
          WHERE d.implementation_step_id = s.id AND parent.status != 'done'), '') AS waiting_on
      FROM product_implementation_steps s
      LEFT JOIN product_users u ON u.id = s.assignee_user_id
      WHERE s.implementation_id = ?
      ORDER BY s.position, s.id
    `).all(implementationId);
    implementation.requirements = implementationRequirements(implementationId, req.product.workspaceId, implementation.template_id);
    return res.json({ implementation });
  });

  app.patch("/api/product/implementations/:implementationId/steps/:stepId", sameOrigin, requireSession, (req, res) => {
    const implementationId = validId(req.params.implementationId);
    const stepId = validId(req.params.stepId);
    if (!implementationId || !stepId) return sendError(res, 400, "Invalid implementation task.");
    const step = database.prepare(`
      SELECT s.* FROM product_implementation_steps s
      JOIN product_implementations i ON i.id = s.implementation_id
      WHERE s.id = ? AND s.implementation_id = ? AND i.workspace_id = ?
    `).get(stepId, implementationId, req.product.workspaceId);
    if (!step) return sendError(res, 404, "Implementation task not found.");
    const status = req.body.status === undefined ? step.status : req.body.status;
    const owner = req.body.owner === undefined ? step.owner : typeof req.body.owner === "string" ? req.body.owner.trim().slice(0, 120) : null;
    const assignee = workspaceAssignee(
      req.product.workspaceId,
      req.body.assigneeUserId === undefined ? step.assignee_user_id : req.body.assigneeUserId
    );
    const dueAt = req.body.dueAt === undefined ? step.due_at : req.body.dueAt;
    const isBlocked = req.body.isBlocked === undefined ? Boolean(step.is_blocked) : req.body.isBlocked;
    const blockerReason = req.body.blockerReason === undefined ? step.blocker_reason
      : typeof req.body.blockerReason === "string" ? req.body.blockerReason.trim().slice(0, 500) : null;
    const blockerNextAction = req.body.blockerNextAction === undefined ? step.blocker_next_action
      : typeof req.body.blockerNextAction === "string" ? req.body.blockerNextAction.trim().slice(0, 500) : null;
    if (!["not_started", "in_progress", "done"].includes(status) || owner === null || !assignee.valid
      || (dueAt !== "" && !validDate(dueAt))
      || typeof isBlocked !== "boolean" || blockerReason === null || blockerNextAction === null
      || (isBlocked && (!blockerReason || !blockerNextAction)) || (status === "done" && isBlocked)) {
      return sendError(res, 400, "Enter a valid task status, owner, due date, and blocker details.");
    }
    if (status === "done") {
      const waiting = database.prepare(`
        SELECT parent.title FROM product_implementation_step_dependencies d
        JOIN product_implementation_steps parent ON parent.id = d.depends_on_step_id
        WHERE d.implementation_step_id = ? AND parent.status != 'done'
        LIMIT 1
      `).get(stepId);
      if (waiting) return sendError(res, 409, `Complete prerequisite “${waiting.title}” before marking this task done.`);
    }
    database.prepare(`
      UPDATE product_implementation_steps
      SET status = ?, owner = ?, assignee_user_id = ?, due_at = ?, is_blocked = ?, blocker_reason = ?,
        blocker_next_action = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND implementation_id = ?
    `).run(status, owner, assignee.id, dueAt, Number(isBlocked), isBlocked ? blockerReason : "", isBlocked ? blockerNextAction : "", stepId, implementationId);
    return res.json({ success: true });
  });

  app.post("/api/product/requirements", sameOrigin, requireSession, (req, res) => {
    const name = requiredText(req.body.name, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const templateValue = req.body.templateId;
    const templateId = templateValue === null || templateValue === undefined || templateValue === ""
      ? null : validId(templateValue);
    const inputType = req.body.inputType === undefined ? "text" : req.body.inputType;
    const invalidTemplate = templateValue !== null && templateValue !== undefined && templateValue !== "" && !templateId;
    if (!name || invalidTemplate || !INPUT_TYPES.has(inputType)) {
      return sendError(res, 400, "Enter a request name, valid template scope, and supported response type.");
    }
    if (templateId && !database.prepare(
      "SELECT id FROM product_templates WHERE id = ? AND workspace_id = ?"
    ).get(templateId, req.product.workspaceId)) return sendError(res, 404, "Template not found.");
    const requirementCount = database.prepare(
      "SELECT COUNT(*) AS count FROM product_requirements WHERE workspace_id = ?"
    ).get(req.product.workspaceId).count;
    if (requirementCount >= 50) return sendError(res, 409, "A workspace can have up to 50 customer information requests.");
    if (req.body.required !== undefined && typeof req.body.required !== "boolean") {
      return sendError(res, 400, "Choose whether this information request is required.");
    }
    const required = req.body.required === false ? 0 : 1;
    const createRequirement = database.transaction(() => {
      const requirement = database.prepare(
        `INSERT INTO product_requirements (workspace_id, template_id, name, description, required, input_type)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id, template_id, name, description, required, input_type`
      ).get(req.product.workspaceId, templateId, name, description, required, inputType);
      database.prepare(`
        INSERT INTO product_customer_inputs (implementation_id, requirement_id)
        SELECT id, ? FROM product_implementations
        WHERE workspace_id = ? AND (? IS NULL OR template_id = ?)
      `).run(requirement.id, req.product.workspaceId, templateId, templateId);
      return requirement;
    });
    return res.status(201).json({ requirement: createRequirement() });
  });

  app.patch("/api/product/requirements/:requirementId", sameOrigin, requireSession, (req, res) => {
    const requirementId = validId(req.params.requirementId);
    const name = requiredText(req.body.name, 120);
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "";
    const inputType = req.body.inputType;
    const required = req.body.required;
    if (!requirementId || !name || !INPUT_TYPES.has(inputType) || typeof required !== "boolean") {
      return sendError(res, 400, "Enter a request name, supported response type, and required/optional setting.");
    }
    const saved = database.prepare(`
      UPDATE product_requirements
      SET name = ?, description = ?, input_type = ?, required = ?
      WHERE id = ? AND workspace_id = ?
    `).run(name, description, inputType, Number(required), requirementId, req.product.workspaceId);
    if (!saved.changes) return sendError(res, 404, "Customer information request not found.");
    return res.json({ success: true });
  });

  app.delete("/api/product/requirements/:requirementId", sameOrigin, requireSession, (req, res) => {
    const requirementId = validId(req.params.requirementId);
    if (!requirementId) return sendError(res, 400, "Invalid customer information request.");
    const result = database.prepare(
      "DELETE FROM product_requirements WHERE id = ? AND workspace_id = ?"
    ).run(requirementId, req.product.workspaceId);
    if (!result.changes) return sendError(res, 404, "Customer information request not found.");
    return res.json({ success: true });
  });

  app.get("/api/product/customer/:token", (req, res) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return sendError(res, 404, "Customer link not found.");
    const implementation = database.prepare(
      "SELECT id, template_id, customer_name FROM product_implementations WHERE portal_token_hash = ?"
    ).get(hashToken(token));
    if (!implementation) return sendError(res, 404, "Customer link not found or no longer available.");
    const workspaceId = database.prepare(
      "SELECT workspace_id FROM product_implementations WHERE id = ?"
    ).get(implementation.id).workspace_id;
    const requirements = implementationRequirements(implementation.id, workspaceId, implementation.template_id);
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.json({ customerName: implementation.customer_name, requirements });
  });

  app.post("/api/product/customer/:token", sameOrigin, (req, res) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return sendError(res, 404, "Customer link not found.");
    const inputs = req.body.inputs;
    if (!Array.isArray(inputs) || inputs.length > 50) return sendError(res, 400, "Submit a valid list of information.");
    const implementation = database.prepare(
      "SELECT id, workspace_id, template_id FROM product_implementations WHERE portal_token_hash = ?"
    ).get(hashToken(token));
    if (!implementation) return sendError(res, 404, "Customer link not found or no longer available.");
    const validRequirements = implementationRequirements(
      implementation.id,
      implementation.workspace_id,
      implementation.template_id
    ).map((requirement) => ({ ...requirement, current_value: requirement.value }));
    const entries = [];
    const entryIds = new Set();
    for (const input of inputs) {
      const requirementId = validId(input?.requirementId);
      if (!requirementId || !validRequirements.some((requirement) => requirement.id === requirementId)
        || entryIds.has(requirementId) || typeof input.value !== "string" || input.value.length > 2000) {
        return sendError(res, 400, "One or more submitted fields are invalid.");
      }
      entryIds.add(requirementId);
      const value = input.value.trim();
      const requirement = validRequirements.find((item) => item.id === requirementId);
      const validationError = inputValueError(requirement.input_type, value);
      if (validationError) return sendError(res, 400, `${requirement.name}: ${validationError}`);
      entries.push({ requirementId, value });
    }
    const submittedValues = new Map(entries.map((entry) => [entry.requirementId, entry.value]));
    const missingRequired = validRequirements.find((requirement) => requirement.required
      && !(submittedValues.has(requirement.id)
        ? submittedValues.get(requirement.id)
        : requirement.current_value).trim());
    if (missingRequired) {
      return sendError(res, 400, `Required information is missing: ${missingRequired.name}.`);
    }
    const invalidSavedValue = validRequirements.find((requirement) => {
      const value = submittedValues.has(requirement.id) ? submittedValues.get(requirement.id) : requirement.current_value.trim();
      return value && inputValueError(requirement.input_type, value);
    });
    if (invalidSavedValue) return sendError(res, 400, `${invalidSavedValue.name} must be corrected before submission.`);
    const saveInputs = database.transaction(() => {
      const save = database.prepare(`
        INSERT INTO product_customer_inputs (implementation_id, requirement_id, value, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (implementation_id, requirement_id)
        DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `);
      for (const entry of entries) save.run(implementation.id, entry.requirementId, entry.value);
    });
    saveInputs();
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.json({ success: true });
  });

  app.use("/api/product", (_req, res) => sendError(res, 404, "Product endpoint not found."));
}

module.exports = installProductRoutes;
