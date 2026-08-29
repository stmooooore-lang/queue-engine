#!/usr/bin/env node
/**
 * Local test for lane routing - uses a temporary libsql database file
 * No real Turso credentials needed - uses local file database
 */

import { createClient } from "@libsql/client";
import { fetchHistory } from "./poller.mjs";
import { unlinkSync } from "node:fs";

const DB_PATH = "/tmp/lane-routing-test.db";

async function runTest() {
  // Clean up any existing test database
  try { unlinkSync(DB_PATH); } catch {}
  
  const db = createClient({ url: `file:${DB_PATH}` });

  // Create tasks table with lane column
  await db.execute({
    sql: `CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      lane TEXT NOT NULL DEFAULT 'architect',
      result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  });

  const creatorId = "test-user";

  // Insert architect lane task
  await db.execute({
    sql: "INSERT INTO tasks (text, status, creator_id, lane) VALUES (?, ?, ?, ?)",
    args: ["Architect task", "готова", creatorId, "architect"]
  });

  // Insert coder lane task
  await db.execute({
    sql: "INSERT INTO tasks (text, status, creator_id, lane) VALUES (?, ?, ?, ?)",
    args: ["Coder task", "готова", creatorId, "coder"]
  });

  // Test fetchHistory with lane='coder' - should only return coder task
  const history = await fetchHistory(db, creatorId, 999, "coder", 10);
  
  const hasCoder = history.some(row => row.text === "Coder task");
  const hasArchitect = history.some(row => row.text === "Architect task");

  console.log(`History rows for lane='coder': ${history.length}`);
  console.log(`Contains coder task: ${hasCoder}`);
  console.log(`Contains architect task: ${hasArchitect}`);

  // Assert: must contain coder row, must NOT contain architect row
  const pass = hasCoder && !hasArchitect;
  console.log(pass ? "PASS" : "FAIL");

  // Clean up
  try { unlinkSync(DB_PATH); } catch {}

  process.exit(pass ? 0 : 1);
}

runTest().catch(err => {
  console.error("Test error:", err);
  try { unlinkSync(DB_PATH); } catch {}
  process.exit(1);
});