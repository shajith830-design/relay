"use strict";

const fs = require("node:fs");
const path = require("node:path");

function validateCloudflareConfig(configText) {
  const hyperdriveBinding = configText.match(
    /"binding"\s*:\s*"HYPERDRIVE"\s*,\s*"id"\s*:\s*"([^"]+)"/
  );
  const hyperdriveId = hyperdriveBinding?.[1];
  if (!hyperdriveId || !/^[a-f0-9]{32}$/i.test(hyperdriveId)) {
    throw new Error("Set HYPERDRIVE's id to the real 32-character Cloudflare Hyperdrive configuration ID.");
  }

  const routeBlock = configText.match(/"route"\s*:\s*\{([^}]*)\}/s)?.[1] || "";
  const pattern = routeBlock.match(/"pattern"\s*:\s*"([^"]+)"/)?.[1];
  const zoneName = routeBlock.match(/"zone_name"\s*:\s*"([^"]+)"/)?.[1];
  if (pattern !== "relayautomation.tech/*" || zoneName !== "relayautomation.tech") {
    throw new Error("Configure the relayautomation.tech/* production route in the relayautomation.tech zone.");
  }

  const workerFirst = configText.match(/"run_worker_first"\s*:\s*\[([^\]]*)\]/s)?.[1] || "";
  for (const route of ["/api/*", "/healthz", "/inquiries"]) {
    if (!workerFirst.includes(`"${route}"`)) {
      throw new Error(`Configure ${route} to run through the Worker before static asset handling.`);
    }
  }
}

if (require.main === module) {
  try {
    const configPath = path.join(__dirname, "..", "wrangler.jsonc");
    validateCloudflareConfig(fs.readFileSync(configPath, "utf8"));
    console.info("Cloudflare deployment configuration is ready.");
  } catch (error) {
    console.error(`Cloudflare deployment configuration is not ready: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateCloudflareConfig };
