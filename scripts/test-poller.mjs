#!/usr/bin/env node
/**
 * Test script for poller.mjs - runs a single poll cycle
 * Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... TELEGRAM_BOT_TOKEN=... LITELLM_MASTER_KEY=... node test-poller.mjs
 */

import { createClient } from "@libsql/client";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const POLL_INTERVAL_MS = 10000;
const MAX_CONCURRENT = 1;
const CLINE_TIMEOUT_MS = 25 * 60 * 1000;
const MAX_OUTPUT = 3500;

function truncate(s) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (обрезано)` : s;
}
const ANSI = /\x1b\[[0-9;]*m/g;

function extractFinalAnswer(jsonLines) {
  let last = null;
  for (const line of jsonLines.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t);
      if (d.type === "run_result") last = d;
    } catch {}
  }
  return last;
}

async function notifyTelegram(botToken, chatId, message) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`telegram sendMessage ${res.status}: ${body}`);
  return body;
}

async function doWork(text, litellmMasterKey) {
  const dockerArgs = [
    "run", "--rm",
    "-v", "/home/runner/.cline:/home/runner/.cline",
    "-w", "/home/runner",
    "plexus-render:latest",
    "cline",
    "--cwd", "plexus",
    "-P", "openai-compatible",
    "-m", "plexus-act",
    "--compaction", "off",
    "--retries", "3",
    "--json",
    text
  ];

  try {
    const { stdout } = await execFile("docker", dockerArgs, {
      timeout: CLINE_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, LITELLM_MASTER_KEY: litellmMasterKey }
    });

    const result = extractFinalAnswer(stdout);
    if (!result) {
      return { success: false, message: truncate(`агент не вернул run_result\n${stdout.replace(ANSI, "").slice(-1500)}`) };
    }
    const ok = result.finishReason === "completed";
    const body = (result.text || "(агент ничего не ответил)").trim();
    return { success: ok, message: truncate(ok ? body : `${result.finishReason}: ${body}`) };
  } catch (err) {
    const result = extractFinalAnswer(err.stdout || "");
    if (result) return { success: false, message: truncate(`${result.finishReason}: ${(result.text || "").trim()}`) };
    const first = String(err.message || err).split("\n")[0];
    const code = err.code ?? err.signal ?? "?";
    return { success: false, message: truncate(`код ${code}: ${first}`) };
  }
}

async function processTask(db, task, botToken, litellmMasterKey) {
  const taskId = task.id;
  const startTime = Date.now();

  console.log(`Processing task ${taskId}: ${task.text.slice(0, 80)}`);

  await db.execute({
    sql: "UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?",
    args: ["выполняется", `test-${process.pid}-${Date.now()}`, taskId]
  });

  const workStart = Date.now();
  const result = await doWork(task.text, litellmMasterKey);
  const workEnd = Date.now();

  const status = result.success ? "готова" : "провал";
  const minutesUsed = Math.ceil((workEnd - workStart) / 60000);
  const secondsToFirstWork = Math.floor((workStart - startTime) / 1000);

  await db.execute({
    sql: `UPDATE tasks SET status = ?, result = ?, actions_run_id = ?, seconds_to_first_work = ?, minutes_used = ? WHERE id = ?`,
    args: [status, result.message, `test-${process.pid}-${Date.now()}`, secondsToFirstWork, minutesUsed, taskId]
  });

  await notifyTelegram(botToken, task.creator_id, `Задача ${taskId} ${status}: ${result.message}`);

  console.log(`Task ${taskId} completed with status: ${status}`);
  return result;
}

async function main() {
  // Load from env
  const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
  const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY;

  if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN || !TELEGRAM_BOT_TOKEN) {
    console.error("Missing required env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

  // Test connection
  await db.execute({ sql: "SELECT 1", args: [] });
  console.log("Turso connection OK");

  // One poll cycle
  const taskRes = await db.execute({
    sql: "SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?",
    args: ["ожидает", MAX_CONCURRENT]
  });

  const tasks = taskRes.rows;
  if (tasks.length === 0) {
    console.log("No pending tasks found");
    return;
  }

  for (const task of tasks) {
    await processTask(db, task, TELEGRAM_BOT_TOKEN, LITELLM_MASTER_KEY);
  }
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});