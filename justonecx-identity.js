"use strict";

const { createHmac } = require("node:crypto");

function createJustOneCXIdentity(userId, accountId, secret = process.env.JUSTONECX_SECRET_KEY) {
  const key = typeof secret === "string" ? secret.trim() : "";
  if (!key) return null;

  const sign = (value) => createHmac("sha256", key).update(String(value)).digest("hex");
  return {
    userHash: sign(userId),
    accountHash: sign(accountId)
  };
}

module.exports = { createJustOneCXIdentity };
