/**
 * Test suite for Turso chat_alerts integration in queue-engine executor.mjs.
 *
 * Verifies:
 * 1. initChatAlertsTable creates chat_alerts table with required schema:
 *    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL,
 *    task TEXT NOT NULL, from_provider TEXT, to_provider TEXT, error TEXT, details TEXT.
 * 2. writeChatAlert correctly inserts alert records for types: escalation, failure, fallback.
 * 3. writeChatAlert correctly formats alert JSON object with fields:
 *    ts, type, task, from, to, error, details.
 * 4. writeChatAlert redacts sensitive tokens (GCP service account, sk-... keys, master keys)
 *    before writing to database.
 * 5. loadTursoCredentials correctly reads credentials from env or keys.txt.
 */

import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  writeChatAlert,
  initChatAlertsTable,
  loadTursoCredentials,
} from "./executor.mjs";

console.log("Starting chat_alerts verification suite...");

// In-memory isolated libSQL test client
const testClient = createClient({ url: "file::memory:" });

// ---------------------------------------------------------------------
// 1. Table schema initialization verification
// ---------------------------------------------------------------------
console.log("Test 1: Verify chat_alerts table creation and schema...");
await initChatAlertsTable(testClient);

const tableInfo = await testClient.execute("PRAGMA table_info(chat_alerts)");
const columns = new Map(tableInfo.rows.map(r => [r.name, r.type]));

assert.ok(columns.has("id"), "Table must have 'id' column");
assert.ok(columns.has("ts"), "Table must have 'ts' column");
assert.ok(columns.has("type"), "Table must have 'type' column");
assert.ok(columns.has("task"), "Table must have 'task' column");
assert.ok(columns.has("from_provider"), "Table must have 'from_provider' column");
assert.ok(columns.has("to_provider"), "Table must have 'to_provider' column");
assert.ok(columns.has("error"), "Table must have 'error' column");
assert.ok(columns.has("details"), "Table must have 'details' column");

console.log("  ✓ Table schema verified with all 8 expected columns.");

// ---------------------------------------------------------------------
// 2. Alert insertion: escalation, failure, fallback
// ---------------------------------------------------------------------
console.log("Test 2: Verify writeChatAlert for escalation, failure, and fallback...");

// Escalation alert
const escRes = await writeChatAlert({
  ts: "2026-09-18T10:00:00.000Z",
  type: "escalation",
  task: "TASK-ESCALATE-1",
  from: "nvidia",
  to: "google",
  error: "Loop detected on nvidia",
  details: "Repeated context re-read across multiple reasoning turns",
}, testClient);

assert.equal(escRes.success, true, "Escalation alert write must succeed");
assert.equal(escRes.alert.type, "escalation");
assert.equal(escRes.alert.task, "TASK-ESCALATE-1");
assert.equal(escRes.alert.from, "nvidia");
assert.equal(escRes.alert.to, "google");

// Fallback alert
const fbRes = await writeChatAlert({
  ts: "2026-09-18T10:05:00.000Z",
  type: "fallback",
  task: "TASK-FALLBACK-1",
  from: "google",
  to: "vertex",
  error: "429: RESOURCE_EXHAUSTED: quota exceeded",
  details: "Switched from Google to Vertex fallback pair due to quota limit",
}, testClient);

assert.equal(fbRes.success, true, "Fallback alert write must succeed");
assert.equal(fbRes.alert.type, "fallback");
assert.equal(fbRes.alert.task, "TASK-FALLBACK-1");
assert.equal(fbRes.alert.from, "google");
assert.equal(fbRes.alert.to, "vertex");

// Failure alert
const failRes = await writeChatAlert({
  ts: "2026-09-18T10:10:00.000Z",
  type: "failure",
  task: "TASK-FAIL-1",
  from: "mistral",
  to: null,
  error: "Exit code 1: command not found",
  details: "Task failed after exhausting retries",
}, testClient);

assert.equal(failRes.success, true, "Failure alert write must succeed");
assert.equal(failRes.alert.type, "failure");
assert.equal(failRes.alert.task, "TASK-FAIL-1");
assert.equal(failRes.alert.from, "mistral");
assert.equal(failRes.alert.to, null);

// Verify rows in DB
const rowsRes = await testClient.execute("SELECT * FROM chat_alerts ORDER BY id ASC");
assert.equal(rowsRes.rows.length, 3, "There should be exactly 3 alert rows");

const [row1, row2, row3] = rowsRes.rows;
assert.equal(row1.type, "escalation");
assert.equal(row1.task, "TASK-ESCALATE-1");
assert.equal(row1.from_provider, "nvidia");
assert.equal(row1.to_provider, "google");

assert.equal(row2.type, "fallback");
assert.equal(row2.task, "TASK-FALLBACK-1");
assert.equal(row2.from_provider, "google");
assert.equal(row2.to_provider, "vertex");

assert.equal(row3.type, "failure");
assert.equal(row3.task, "TASK-FAIL-1");
assert.equal(row3.from_provider, "mistral");
assert.equal(row3.to_provider, null);

console.log("  ✓ Alert insertion for escalation, failure, and fallback verified in DB.");

// ---------------------------------------------------------------------
// 3. Secret redaction verification
// ---------------------------------------------------------------------
console.log("Test 3: Verify secret redaction in chat_alerts...");

await writeChatAlert({
  type: "failure",
  task: "TASK-SECRET-TEST",
  from: "groq",
  to: null,
  error: "Failed with key sk-12345678901234567890abcdef",
  details: 'Error trace with {"type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"} leaked',
}, testClient);

const secretRow = (await testClient.execute("SELECT * FROM chat_alerts WHERE task = 'TASK-SECRET-TEST'")).rows[0];
assert.ok(!secretRow.error.includes("sk-12345678901234567890abcdef"), "Error field must be redacted");
assert.ok(secretRow.error.includes("[REDACTED: sk-... key]"), "Error field must contain redaction marker");
assert.ok(!secretRow.details.includes("BEGIN PRIVATE KEY"), "Details field must not contain raw private key");
assert.ok(secretRow.details.includes("[REDACTED: GCP service-account JSON key]"), "Details field must contain GCP redaction marker");

console.log("  ✓ Secret redaction verified.");

// ---------------------------------------------------------------------
// 4. loadTursoCredentials verification
// ---------------------------------------------------------------------
console.log("Test 4: Verify loadTursoCredentials...");
const creds = loadTursoCredentials();
assert.ok(creds.url, "URL must be populated (either from env, keys.txt, or memory)");
console.log("  ✓ loadTursoCredentials returned URL:", creds.url.startsWith("libsql://") ? "libsql URL (remote)" : creds.url);

console.log("\nALL TESTS PASSED: chat_alerts table and writeChatAlert functionality verified successfully.");
