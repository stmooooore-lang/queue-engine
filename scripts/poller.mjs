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
import telegramifyMarkdown from "telegramify-markdown";

const execFile = promisify(execFileCb);

// Poll interval in milliseconds (10 seconds)
const POLL_INTERVAL_MS = 10000;

// Max concurrent tasks (e2-micro has limited RAM)
const MAX_CONCURRENT = 1;

// Cline timeout (25 minutes, same as executor.yml)
const CLINE_TIMEOUT_MS = 25 * 60 * 1000;

// Safety cap against genuinely runaway output - not the normal path anymore.
// Real answers now go through notifyTelegram's own chunking, which splits
// at Telegram's actual per-message limit instead of silently discarding
// everything past a much smaller cap (found 2026-08-24: a real retro answer
// got cut mid-sentence at 3500 chars with no way to see the rest).
const MAX_OUTPUT = 12000;

function truncate(s) {
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n… (обрезано, ответ был необычно длинным)`
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

// Telegram's own hard limit is 4096 chars per message. A long real answer
// (e.g. a retro) must arrive as several consecutive messages, never
// silently cut - splitting on paragraph breaks where possible keeps each
// chunk readable instead of severing mid-sentence.
const TELEGRAM_CHUNK_LIMIT = 3900;

function splitForTelegram(text) {
  if (text.length <= TELEGRAM_CHUNK_LIMIT) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > TELEGRAM_CHUNK_LIMIT) {
    let cut = rest.lastIndexOf("\n\n", TELEGRAM_CHUNK_LIMIT);
    if (cut < TELEGRAM_CHUNK_LIMIT * 0.5) cut = rest.lastIndexOf("\n", TELEGRAM_CHUNK_LIMIT);
    if (cut < TELEGRAM_CHUNK_LIMIT * 0.5) cut = TELEGRAM_CHUNK_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendOneTelegramMessage(botToken, chatId, rawText) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  // telegramify-markdown converts Cline's plain markdown (including GFM
  // tables, which Telegram cannot render under any parse_mode) into valid
  // Telegram MarkdownV2 - correct escaping, tables become a monospace
  // block. Converted per-chunk (not on the whole message before splitting)
  // so a bold/italic span never straddles a chunk boundary and breaks
  // mid-entity. If conversion or Telegram's own parse still fails for some
  // unexpected input, fall back to the raw chunk as plain text rather than
  // losing the message over a formatting bug.
  let converted;
  try {
    converted = telegramifyMarkdown(rawText, "escape");
  } catch (err) {
    console.log(`telegramify-markdown failed, sending raw: ${err.message}`);
    converted = null;
  }
  for (const [text, parse_mode] of converted ? [[converted, "MarkdownV2"], [rawText, undefined]] : [[rawText, undefined]]) {
    const body = parse_mode ? { chat_id: chatId, text, parse_mode } : { chat_id: chatId, text };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return await res.text();
    const errBody = await res.text();
    if (parse_mode) {
      console.log(`sendMessage with MarkdownV2 failed (${res.status}), retrying plain: ${errBody.slice(0, 200)}`);
      continue;
    }
    throw new Error(`telegram sendMessage ${res.status}: ${errBody}`);
  }
}

async function notifyTelegram(botToken, chatId, message) {
  const chunks = splitForTelegram(message);
  let lastBody;
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks.length > 1 ? `${chunks[i]}\n\n[${i + 1}/${chunks.length}]` : chunks[i];
    lastBody = await sendOneTelegramMessage(botToken, chatId, text);
  }
  return lastBody;
}

async function fetchHistory(db, creatorId, currentTaskId, limit = 6) {
  // Fetch last N completed/failed tasks for this creator_id, excluding current task
  const res = await db.execute({
    sql: `SELECT text, result FROM tasks 
          WHERE creator_id = ? AND status IN (?, ?) AND id != ? 
          ORDER BY created_at DESC LIMIT ?`,
    args: [creatorId, "готова", "провал", currentTaskId, limit]
  });
  return res.rows;
}

// telegramify-markdown (in sendOneTelegramMessage) makes *bold*/`code`/etc.
// safe automatically now - no need to warn about those. Tables are a
// separate problem it does NOT solve: verified locally, it just escapes
// the pipes/dashes (`\| a \| b \|`) rather than reformatting them, so a
// table is still unreadable in Telegram even after conversion. That one
// still needs telling.
const TELEGRAM_FORMAT_HINT =
  "Отвечаешь в Telegram-чат: **не используй markdown-таблицы, пиши списком** " +
  "(таблицы там нечитаемы даже после конвертации). Простое форматирование " +
  "(жирный, код) работает само. Длинный ответ — это нормально, " +
  "он придёт несколькими сообщениями подряд.";

function buildPromptWithHistory(currentText, historyRows) {
  if (historyRows.length === 0) {
    return `${TELEGRAM_FORMAT_HINT}\n\n${currentText}`;
  }
  // Reverse to chronological order (oldest first)
  const chronological = historyRows.reverse();
  let prompt = `${TELEGRAM_FORMAT_HINT}\n\nПредыдущий разговор с этим пользователем (для контекста, не для ответа на старые сообщения):\n`;
  for (const row of chronological) {
    const userText = row.text.slice(0, 500);
    const assistantText = (row.result || "").slice(0, 500);
    prompt += `Пользователь: ${userText}\nАссистент: ${assistantText}\n`;
  }
  prompt += `\nНовое сообщение пользователя:\n${currentText}`;
  return prompt;
}

async function doWork(db, text, litellmMasterKey, creatorId, currentTaskId) {
  // Fetch history from Turso and build combined prompt
  const historyRows = await fetchHistory(db, creatorId, currentTaskId, 6);
  const combinedPrompt = buildPromptWithHistory(text, historyRows);

  // Run Cline inside the prebuilt plexus-render:latest Docker image.
  // The image already has Cline, Node, and the providers.json pointing to
  // Render LiteLLM. No --id flag - we pass history manually in the prompt.
  const dockerArgs = [
    "run", "--rm",
    "-v", "/home/runner/.cline:/home/runner/.cline",
    "-v", "/home/runner/plexus-doc:/home/runner/plexus-doc",
    "-w", "/home/runner/plexus-doc",
    "plexus-render:latest",
    "cline",
    "--config", "/home/runner/.cline",
    "--data-dir", "/home/runner/.cline/data",
    "--cwd", "/home/runner/plexus-doc",
    "-P", "openai-compatible",
    "-m", "plexus-act",
    "--compaction", "off",
    "--retries", "3",
    "--json",
    combinedPrompt
  ];

  console.log(`[${new Date().toISOString()}] Docker command: docker ${dockerArgs.join(" ")}`);

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
  const result = await doWork(db, task.text, litellmMasterKey, task.creator_id, taskId);
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
