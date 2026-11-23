"use strict";

const { timingSafeEqual } = require("node:crypto");
const http = require("node:http");
const { connect } = require("node:net");

const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_CLAMAV_RESPONSE_BYTES = 4096;

function scanWithClamAV(content, { host, port, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let response = Buffer.alloc(0);
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0", "utf8"));
      for (let offset = 0; offset < content.length; offset += 64 * 1024) {
        const chunk = content.subarray(offset, Math.min(offset + 64 * 1024, content.length));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_CLAMAV_RESPONSE_BYTES) {
        finish(new Error("ClamAV response exceeded its limit."));
        return;
      }
      const terminator = response.indexOf(0);
      if (terminator < 0) return;
      const message = response.subarray(0, terminator).toString("utf8");
      if (/^stream:\s*OK$/i.test(message)) finish(null, { status: "clean" });
      else if (/^stream:\s*.+\sFOUND$/i.test(message)) finish(null, { status: "infected" });
      else finish(new Error("ClamAV returned an unsuccessful scan result."));
    });
    socket.once("error", () => finish(new Error("ClamAV connection failed.")));
    socket.once("timeout", () => finish(new Error("ClamAV scan timed out.")));
    socket.once("end", () => {
      if (!finished) finish(new Error("ClamAV closed the connection without a result."));
    });
  });
}

function matchesBearerToken(authorization, expectedToken) {
  const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const expectedBuffer = Buffer.from(expectedToken);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function createScannerServer({
  token = process.env.MALWARE_SCANNER_TOKEN || "",
  clamavHost = process.env.CLAMAV_HOST || "clamav",
  clamavPort = Number(process.env.CLAMAV_PORT || 3310),
  scan = scanWithClamAV
} = {}) {
  if (token.trim().length < 32) throw new Error("MALWARE_SCANNER_TOKEN must contain at least 32 characters.");
  if (!clamavHost.trim() || !Number.isInteger(clamavPort) || clamavPort < 1 || clamavPort > 65535) {
    throw new Error("Configure a valid ClamAV host and port.");
  }
  token = token.trim();
  clamavHost = clamavHost.trim();
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/scan") {
      request.resume();
      return sendJson(response, 404, { error: "Not found." });
    }
    if (!matchesBearerToken(request.headers.authorization, token)) {
      request.resume();
      return sendJson(response, 401, { error: "Not authorized." });
    }
    if (request.headers["content-type"] !== "application/octet-stream") {
      request.resume();
      return sendJson(response, 415, { error: "Unsupported content type." });
    }
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SCAN_BYTES) {
      request.resume();
      return sendJson(response, 413, { error: "File exceeds the scan size limit." });
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_SCAN_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", async () => {
      if (tooLarge) return sendJson(response, 413, { error: "File exceeds the scan size limit." });
      if (!size) return sendJson(response, 400, { error: "File is empty." });
      try {
        const result = await scan(Buffer.concat(chunks, size), {
          host: clamavHost,
          port: clamavPort
        });
        return sendJson(response, 200, result);
      } catch (error) {
        console.error(JSON.stringify({
          event: "clamav_scan_failed",
          errorName: error?.name || "Error"
        }));
        return sendJson(response, 503, { error: "Malware scan is unavailable." });
      }
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (require.main === module) {
  try {
    const port = Number(process.env.SCANNER_PORT || 8788);
    const host = process.env.SCANNER_HOST || "0.0.0.0";
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("SCANNER_PORT must be a valid port.");
    }
    const server = createScannerServer();
    server.listen(port, host, () => {
      console.info(JSON.stringify({ event: "clamav_scan_service_ready", host, port }));
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "clamav_scan_service_start_failed",
      errorName: error?.name || "Error"
    }));
    process.exitCode = 1;
  }
}

module.exports = {
  createScannerServer,
  scanWithClamAV
};
