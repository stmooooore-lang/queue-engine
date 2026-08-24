/**
 * VM Poller for Telegram Bot Task Queue
 * 
 * Runs on plexus-queue-vm (e2-micro, us-central1-a) as a systemd service.
 * Polls Turso for pending tasks, executes them via Cline in the prebuilt
 * plexus-render:latest Docker image, and writes results back to Turso/Telegram.
 * 
 * Reuses the exact same schema, queries, and execution logic as executor.yml
 * and scripts/executor.mjs - no new schema invented.
 * 
 * Required env vars (written to files, never echoed):
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TELEGRAM_BOT_TOKEN
 *   LITELLM_MASTER_KEY (for auth to Render LiteLLM endpoint)
 */

import { createClient } from "@libsql/client";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// Poll interval in milliseconds (10 seconds)
const POLL_INTERVAL_MS = 10000;

// Max concurrent tasks (e2-micro has limited RAM)
const MAX_CONCURRENT = 1;

// Cline timeout (25 minutes, same as executor.yml)
const CLINE_TIMEOUT_MS = 25 * 60 * 1000;

// Telegram message cap
const MAX_OUTPUT = 3500;

function truncate(s) {
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n… (обрезано)`
    : s;
}

// ANSI escape code stripper
const ANSI = /\x1b\[[0-9;]*m/g;

function extractFinalAnswer(jsonLines) {
  let last = null;
  for (const line of jsonLines.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t);
      if (d.type === "run_result") last = d;
    } catch {
      // non-JSON line (warning, etc.) - skip
    }
  }
  return last;
}

async function loadSecrets() {
  // Secrets are written to files by the systemd service (EnvironmentFile)
  // or can be passed directly via environment. We support both.
  const secrets = {};
  
  const secretFiles = {
    TURSO_DATABASE_URL: "/run/secrets/TURSO_DATABASE_URL",
    TURSO_AUTH_TOKEN: "/run/secrets/TURSO_AUTH_TOKEN",
    TELEGRAM_BOT_TOKEN: "/run/secrets/TELEGRAM_BOT_TOKEN",
    LITELLM_MASTER_KEY: "/run/secrets/LITELLM_MASTER_KEY",
  };

  for (const [key, path] of Object.entries(secretFiles)) {
    try {
      const content = await fs.readFile(path, "utf8");
      secrets[key] = content.trim();
    } catch {
      // Fall back to env var (for local testing)
      if (process.env[key]) {
        secrets[key] = process.env[key];
      }
    }
  }

  // Validate required secrets
  const required = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "TELEGRAM_BOT_TOKEN"];
  for (const key of required) {
    if (!secrets[key]) {
      throw new Error(`Missing required secret: ${key}`);
    }
  }

  return secrets;
}

async function notifyTelegram(botToken, chatId, message) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`telegram sendMessage ${res.status}: ${body}`);
  }
  return body;
}

async function doWork(text, litellmMasterKey) {
  // Run Cline inside the prebuilt plexus-render:latest Docker image.
  // The image already has Cline, Node, and the providers.json pointing to
  // Render LiteLLM with Authorization: Bearer <LITELLM_MASTER_KEY>.
  //
  // We mount the host's ~/.cline directory so Cline can read providers.json
  // and write its data. The WORKDIR is /home/runner/plexus inside the container.
  //
  // The cline command matches executor.yml exactly:
  // cline --cwd plexus -P openai-compatible -m plexus-act --compaction off --retries 3 --json "<text>"
  
  const dockerArgs = [
    "run", "--rm",
    "-v", "/home/runner/.cline:/home/runner/.cline",
    "-w", "/home/runner",
    "plexus-render:latest",
    "cline",
    "--config", "/home/runner/.cline",
    "--data-dir", "/home/runner/.cline/data",
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
      env: {
        ...process.env,
        LITELLM_MASTER_KEY: litellmMasterKey,
      }
    });

    const result = extractFinalAnswer(stdout);
    if (!result) {
      return {
        success: false,
        message: truncate(`агент не вернул run_result\n${stdout.replace(ANSI, "").slice(-1500)}`)
      };
    }

    const ok = result.finishReason === "completed";
    const body = (result.text || "(агент ничего не ответил)").trim();
    return {
      success: ok,
      message: truncate(ok ? body : `${result.finishReason}: ${body}`)
    };
  } catch (err) {
    const result = extractFinalAnswer(err.stdout || "");
    if (result) {
      return { success: false, message: truncate(`${result.finishReason}: ${(result.text || "").trim()}`) };
    }
    const first = String(err.message || err).split("\n")[0];
    const code = err.code ?? err.signal ?? "?";
    return { success: false, message: truncate(`код ${code}: ${first}`) };
  }
}

async function processTask(db, task, botToken, litellmMasterKey) {
  const taskId = task.id;
  const startTime = Date.now();

  console.log(`[${new Date().toISOString()}] Processing task ${taskId}: ${task.text.slice(0, 80)}`);

  // Mark as running - reuse exact same query as executor.mjs
  await db.execute({
    sql: "UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?",
    args: ["выполняется", `poller-${process.pid}-${Date.now()}`, taskId]
  });

  // Execute work
  const workStart = Date.now();
  const result = await doWork(task.text, litellmMasterKey);
  const workEnd = Date.now();

  // Update task - reuse exact same query as executor.mjs
  const status = result.success ? "готова" : "провал";
  const minutesUsed = Math.ceil((workEnd - workStart) / 60000);
  const secondsToFirstWork = Math.floor((workStart - startTime) / 1000);

  await db.execute({
    sql: `UPDATE tasks SET status = ?, result = ?, actions_run_id = ?, seconds_to_first_work = ?, minutes_used = ? WHERE id = ?`,
    args: [status, result.message, `poller-${process.pid}-${Date.now()}`, secondsToFirstWork, minutesUsed, taskId]
  });

  // Notify via Telegram to creator - reuse exact same logic as executor.mjs
  await notifyTelegram(botToken, task.creator_id, `Задача ${taskId} ${status}: ${result.message}`);

  console.log(`[${new Date().toISOString()}] Task ${taskId} completed with status: ${status}`);
}

async function pollLoop(db, botToken, litellmMasterKey) {
  while (true) {
    try {
      // Find pending tasks - reuse exact same query as executor.mjs
      const taskRes = await db.execute({
        sql: "SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?",
        args: ["ожидает", MAX_CONCURRENT]
      });

      const tasks = taskRes.rows;
      if (tasks.length === 0) {
        // No pending tasks, sleep and continue
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      // Process tasks sequentially (MAX_CONCURRENT=1 for e2-micro)
      for (const task of tasks) {
        await processTask(db, task, botToken, litellmMasterKey);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Poll loop error:`, err.message);
      // On error, wait a bit before retrying
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS * 2));
    }
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting VM poller...`);

  const secrets = await loadSecrets();
  console.log(`[${new Date().toISOString()}] Secrets loaded`);

  // Create Turso client - same as executor.mjs
  const db = createClient({
    url: secrets.TURSO_DATABASE_URL,
    authToken: secrets.TURSO_AUTH_TOKEN
  });

  // Test connection
  try {
    await db.execute({ sql: "SELECT 1", args: [] });
    console.log(`[${new Date().toISOString()}] Turso connection OK`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Turso connection failed:`, err.message);
    throw err;
  }

  // Start polling
  await pollLoop(db, secrets.TELEGRAM_BOT_TOKEN, secrets.LITELLM_MASTER_KEY);
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, err.message);
  process.exit(1);
});
