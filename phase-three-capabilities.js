"use strict";

const ExcelJS = require("exceljs");

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_XLSX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_CSV_ROWS = 10000;
const MAX_CSV_COLUMNS = 100;
const MAX_CSV_CELL_LENGTH = 2000;
const MAX_VALIDATION_ERRORS = 500;
const CSV_DATA_TYPES = new Set(["email", "iso_date", "currency", "string"]);
const CREDENTIAL_PROVIDERS = new Set(["hubspot", "jira", "linear", "salesforce", "slack"]);

function normalizedHeader(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function validateCsvSchema(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CSV_COLUMNS) return null;
  const columns = [];
  const seen = new Set();
  for (const column of value) {
    if (!column || typeof column !== "object" || Array.isArray(column)) return null;
    const columnName = typeof column.column_name === "string" ? column.column_name.trim() : "";
    const dataType = column.data_type;
    const required = column.required;
    const regex = column.regex === undefined || column.regex === null ? "" : column.regex;
    if (!columnName || columnName.length > 120 || !CSV_DATA_TYPES.has(dataType)
      || typeof required !== "boolean" || typeof regex !== "string" || regex.length > 120) return null;
    const key = normalizedHeader(columnName);
    if (!key || seen.has(key)) return null;
    seen.add(key);
    if (regex) {
      if (!isSafeValidationRegex(regex)) return null;
      try {
        new RegExp(regex, "u");
      } catch {
        return null;
      }
    }
    columns.push({ column_name: columnName, data_type: dataType, required, regex });
  }
  return columns;
}

function validateCredentialProvider(value) {
  return typeof value === "string" && CREDENTIAL_PROVIDERS.has(value) ? value : null;
}

function normalizeSlackWebhookUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com"
      || url.port || url.username || url.password || url.search || url.hash
      || !/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function sendSlackWebhook(value, text, fetchImpl = fetch) {
  const webhook = normalizeSlackWebhookUrl(value);
  if (!webhook || typeof text !== "string" || !text.trim() || text.length > 4000) {
    return { success: false, status: 400, message: "The Slack webhook or message is invalid." };
  }
  try {
    const response = await fetchImpl(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      redirect: "manual",
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      return {
        success: false,
        status: response.status,
        message: `Slack did not accept the message (HTTP ${response.status}).`
      };
    }
    return { success: true, status: response.status, message: "Slack message delivered." };
  } catch {
    return { success: false, status: 502, message: "Slack message could not be delivered. Check the webhook and try again." };
  }
}

async function boundedResponseJson(response, maxBytes = 65536) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("The provider response exceeded the size limit.");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The provider response exceeded the size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function testCredentialConnection(provider, credential, fetchImpl = fetch) {
  const selectedProvider = validateCredentialProvider(provider);
  const secret = typeof credential === "string" ? credential.trim() : "";
  if (!selectedProvider || secret.length < 8 || secret.length > 4096 || /[\u0000-\u001f\u007f]/.test(secret)) {
    return { success: false, status: 400, message: "Enter a valid credential for a supported provider." };
  }
  const targets = {
    hubspot: { url: "https://api.hubapi.com/crm/v3/objects/companies?limit=1" },
    jira: { url: "https://api.atlassian.com/oauth/token/accessible-resources" },
    linear: {
      url: "https://api.linear.app/graphql",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query RelayCredentialCheck { viewer { id } }" })
    },
    salesforce: { url: "https://login.salesforce.com/services/oauth2/userinfo" },
    slack: { url: "https://slack.com/api/auth.test" }
  };
  const target = targets[selectedProvider];
  try {
    const response = await fetchImpl(target.url, {
      method: target.method || "GET",
      headers: { ...target.headers, Authorization: `Bearer ${secret}` },
      ...(target.body ? { body: target.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(8000)
    });
    if (response.status >= 300 && response.status < 400) {
      return { success: false, status: response.status, message: "The provider requested a redirect; Relay did not follow it." };
    }
    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        message: response.status === 401 || response.status === 403
          ? `The provider rejected the credential (HTTP ${response.status}). Check the token and its permissions.`
          : `The provider returned HTTP ${response.status}. Try again or check the provider status.`
      };
    }
    if (selectedProvider === "linear" || selectedProvider === "slack") {
      const body = await boundedResponseJson(response);
      const accepted = selectedProvider === "linear"
        ? Boolean(body?.data?.viewer?.id) && !body?.errors?.length
        : body?.ok === true;
      if (!accepted) {
        return {
          success: false,
          status: 401,
          message: "The provider did not accept the credential. Check the token and its permissions."
        };
      }
    }
    return { success: true, status: response.status, message: "Connection verified." };
  } catch {
    return { success: false, status: 502, message: "Relay could not verify the connection. Check the provider status and try again." };
  }
}

function isSafeValidationRegex(pattern) {
  if (!pattern || pattern.length > 120 || /[()|\\]/.test(pattern)) return false;
  if (/\[[^\]]*$/.test(pattern) || /\]\s*\[/.test(pattern)) return false;
  if (/\*{2,}|\+{2,}|\?{2,}|\{\d{4,},?\d*\}/.test(pattern)) return false;
  return !/[\u0000-\u001f]/.test(pattern);
}

function parseCsv(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CSV_BYTES) {
    return { headers: [], rows: [], structureErrors: [{ row: 1, message: "The CSV must be no larger than 5 MB." }] };
  }
  const text = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) {
    return { headers: [], rows: [], structureErrors: [{ row: 1, message: "The CSV file is empty." }] };
  }

  const records = [];
  let record = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;
  let error = "";
  const pushCell = () => {
    if (cell.length > MAX_CSV_CELL_LENGTH) error = "A cell exceeds the 2,000-character limit.";
    record.push(cell);
    cell = "";
    afterQuote = false;
  };
  const pushRecord = () => {
    pushCell();
    records.push({ line: recordLine, cells: record });
    record = [];
    recordLine = line + 1;
    if (records.length > MAX_CSV_ROWS + 1) error = "The CSV may contain no more than 10,000 data rows.";
  };

  for (let index = 0; index < text.length && !error; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += char;
        if (char === "\n") line += 1;
      }
      continue;
    }
    if (afterQuote && char !== "," && char !== "\n" && !/\s/.test(char)) {
      error = "Unexpected text after a quoted CSV value.";
      break;
    }
    if (char === ",") {
      pushCell();
    } else if (char === "\n") {
      pushRecord();
      line += 1;
      recordLine = line;
    } else if (char === '"') {
      if (cell.length) {
        error = "A quote appears inside an unquoted CSV value.";
      } else {
        quoted = true;
      }
    } else if (!afterQuote) {
      cell += char;
    }
  }
  if (quoted && !error) error = "A quoted CSV value is not closed.";
  if (!error && (record.length || cell.length || afterQuote)) pushRecord();
  if (error) {
    return { headers: [], rows: [], structureErrors: [{ row: line, message: error }] };
  }

  while (records.length && records[records.length - 1].cells.length === 1
    && records[records.length - 1].cells[0] === "") records.pop();
  if (!records.length) {
    return { headers: [], rows: [], structureErrors: [{ row: 1, message: "The CSV must include a header row." }] };
  }

  const headers = records[0].cells.map((header) => header.trim());
  const headerKeys = headers.map(normalizedHeader);
  const structureErrors = [];
  if (!headers.length || headers.length > MAX_CSV_COLUMNS) {
    structureErrors.push({ row: records[0].line, message: "The CSV must contain between 1 and 100 columns." });
  }
  if (headers.some((header) => !header)) {
    structureErrors.push({ row: records[0].line, message: "Every CSV column must have a header." });
  }
  if (new Set(headerKeys).size !== headerKeys.length) {
    structureErrors.push({ row: records[0].line, message: "CSV column headers must be unique." });
  }
  const rows = records.slice(1).map((item) => ({ line: item.line, cells: item.cells }));
  for (const row of rows) {
    if (row.cells.length !== headers.length && structureErrors.length < MAX_VALIDATION_ERRORS) {
      structureErrors.push({ row: row.line, message: `Expected ${headers.length} columns but found ${row.cells.length}.` });
    }
  }
  return { headers, rows, structureErrors };
}

function validateXlsxArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_CSV_BYTES
    || buffer.readUInt32LE(0) !== 0x04034b50) return "Choose a valid XLSX file no larger than 5 MB.";
  const searchFrom = Math.max(0, buffer.length - 65557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > buffer.length) return "The XLSX archive is incomplete.";
  const entries = buffer.readUInt16LE(endOffset + 10);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (!entries || entries > 1000 || entries === 0xffff || directorySize === 0xffffffff
    || directoryOffset === 0xffffffff || directoryOffset + directorySize > endOffset) {
    return "The XLSX archive structure is not supported.";
  }
  let offset = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== 0x02014b50) {
      return "The XLSX archive structure is not supported.";
    }
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff
      || offset + 46 + nameLength + extraLength + commentLength > endOffset) {
      return "The XLSX archive structure is not supported.";
    }
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (/vbaProject\.bin|externalLinks/i.test(entryName)) {
      return "Macro-enabled and externally linked workbooks are not supported.";
    }
    expandedBytes += uncompressedBytes;
    if (expandedBytes > MAX_XLSX_EXPANDED_BYTES
      || (uncompressedBytes > 1024 * 1024 && uncompressedBytes / Math.max(1, compressedBytes) > 100)) {
      return "The XLSX file expands beyond the supported size limit.";
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize) return "The XLSX archive directory is inconsistent.";
  return "";
}

async function parseXlsx(buffer) {
  const archiveError = validateXlsxArchive(buffer);
  if (archiveError) {
    return { headers: [], rows: [], structureErrors: [{ row: 1, message: archiveError }] };
  }
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("The workbook has no worksheets.");
    if (worksheet.actualColumnCount < 1 || worksheet.actualColumnCount > MAX_CSV_COLUMNS
      || worksheet.actualRowCount < 1 || worksheet.actualRowCount > MAX_CSV_ROWS + 1) {
      throw new Error("The first worksheet must contain no more than 10,000 rows and 100 columns.");
    }
    const records = [];
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > MAX_CSV_ROWS + 1) return;
      const cells = [];
      for (let column = 1; column <= worksheet.actualColumnCount; column += 1) {
        const value = row.getCell(column).value;
        if (value && typeof value === "object" && !(value instanceof Date)) {
          if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) {
            throw new Error(`Formula cells are not allowed (row ${rowNumber}, column ${column}).`);
          }
          if (Array.isArray(value.richText)) {
            cells.push(value.richText.map((item) => item.text || "").join(""));
          } else if (typeof value.text === "string" && value.hyperlink) {
            cells.push(value.text);
          } else {
            throw new Error(`Unsupported cell value (row ${rowNumber}, column ${column}).`);
          }
        } else if (value instanceof Date) {
          cells.push(value.toISOString().slice(0, 10));
        } else {
          cells.push(value === null || value === undefined ? "" : String(value));
        }
      }
      if (cells.some((cell) => cell.length > MAX_CSV_CELL_LENGTH)) {
        throw new Error(`A cell exceeds the 2,000-character limit (row ${rowNumber}).`);
      }
      records.push({ line: rowNumber, cells });
    });
    if (!records.length) throw new Error("The first worksheet is empty.");
    const headers = records[0].cells.map((header) => header.trim());
    const headerKeys = headers.map(normalizedHeader);
    const structureErrors = [];
    if (headers.some((header) => !header)) {
      structureErrors.push({ row: records[0].line, message: "Every worksheet column must have a header." });
    }
    if (new Set(headerKeys).size !== headerKeys.length) {
      structureErrors.push({ row: records[0].line, message: "Worksheet column headers must be unique." });
    }
    return { headers, rows: records.slice(1), structureErrors };
  } catch (error) {
    return { headers: [], rows: [], structureErrors: [{ row: 1, message: error.message || "The XLSX file could not be read." }] };
  }
}

function headerSimilarity(left, right) {
  const a = normalizedHeader(left);
  const b = normalizedHeader(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const old = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
      diagonal = old;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function suggestCsvHeaderMapping(headers, schema) {
  const suggestions = {};
  for (const column of schema) {
    const ranked = headers.map((header, index) => ({
      header,
      index,
      score: headerSimilarity(column.column_name, header)
    })).sort((left, right) => right.score - left.score);
    const first = ranked[0];
    const second = ranked[1];
    suggestions[column.column_name] = first && first.score >= 0.72
      && (!second || first.score - second.score >= 0.08)
      ? first.header
      : "";
  }
  return suggestions;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validCurrency(value) {
  const normalized = value.replace(/[$€£₹]/g, "").replace(/\b(?:USD|INR|EUR|GBP)\b/gi, "").trim();
  return /^-?(?:\d{1,12}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(normalized)
    || /^-?\d{1,12},\d{1,2}$/.test(normalized);
}

function validCell(column, value) {
  if (!value) return !column.required;
  if (column.data_type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  if (column.data_type === "iso_date" && !validDate(value)) return false;
  if (column.data_type === "currency" && !validCurrency(value)) return false;
  if (column.regex && !new RegExp(column.regex, "u").test(value)) return false;
  return true;
}

function validateCsvRows(parsed, schema, mapping) {
  const errors = [...parsed.structureErrors];
  if (errors.length || !parsed.headers.length) {
    return { valid: false, errorCount: errors.length, errors: errors.slice(0, MAX_VALIDATION_ERRORS) };
  }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return { valid: false, errorCount: 1, errors: [{ row: 1, column: "", message: "Confirm the column mapping." }] };
  }
  const headerIndexes = new Map(parsed.headers.map((header, index) => [header, index]));
  const usedIndexes = new Set();
  const mappedColumns = [];
  for (const column of schema) {
    const header = mapping[column.column_name];
    if (header === undefined || header === "") {
      if (column.required) errors.push({
        row: 1,
        column: column.column_name,
        message: "Map this required field to a CSV column."
      });
      continue;
    }
    const index = headerIndexes.get(header);
    if (!Number.isInteger(index) || usedIndexes.has(index)) {
      errors.push({ row: 1, column: column.column_name, message: "Choose a unique CSV column." });
      continue;
    }
    usedIndexes.add(index);
    mappedColumns.push({ column, index });
  }
  let errorCount = errors.length;
  for (const row of parsed.rows) {
    for (const { column, index } of mappedColumns) {
      const value = String(row.cells[index] ?? "").trim();
      if (!validCell(column, value)) {
        errorCount += 1;
        if (errors.length < MAX_VALIDATION_ERRORS) errors.push({
          row: row.line,
          column: column.column_name,
          message: value ? `Invalid ${column.data_type.replaceAll("_", " ")} value.` : "This field is required."
        });
      }
    }
  }
  return { valid: errorCount === 0, errorCount, errors };
}

module.exports = {
  CSV_DATA_TYPES,
  CREDENTIAL_PROVIDERS,
  MAX_CSV_BYTES,
  headerSimilarity,
  isSafeValidationRegex,
  normalizeSlackWebhookUrl,
  parseCsv,
  parseXlsx,
  sendSlackWebhook,
  suggestCsvHeaderMapping,
  testCredentialConnection,
  validateCredentialProvider,
  validateCsvRows,
  validateCsvSchema
};
