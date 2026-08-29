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
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { ensureTasksFile } from "./init-tasks-md.mjs";

// CHANGED 2026-08-29: this used to be execFile with maxBuffer: 20MB, which
// buffers the ENTIRE stdout stream in memory and kills the child the
// instant that total crosses the limit -- mid-task, not at a clean
// stopping point. A real whole-repo-read task hit exactly this (SIGPIPE,
// docs/DECISIONS.md has the incident). extractFinalAnswer only ever needs
// the LAST run_result-typed line; everything else (every read_files
// result, every thinking block) was being held in memory only to be
// thrown away. This collector does the same selection incrementally, so
// a huge task's tool-call volume no longer has a fixed ceiling -- only
// CLINE_TIMEOUT_MS bounds it now, not memory.
function makeStreamingCollector(tailMaxChars = 2000) {
  let carry = "";      // an incomplete line spanning two chunks
  let lastResult = null;
  let tail = "";        // small, bounded window of raw output for error reports
  function consumeLine(line) {
    const t = line.trim();
    if (!t) return;
    try {
      const d = JSON.parse(t);
      if (d.type === "run_result") lastResult = d;
    } catch {
      // non-JSON line (a warning, etc.) - skip, same as the old code did
    }
  }
  function push(chunk) {
    tail = (tail + chunk).slice(-tailMaxChars);
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? ""; // last element may be a partial line - keep it for the next chunk
    for (const line of lines) consumeLine(line);
  }
  function finalize() {
    if (carry) consumeLine(carry); // stream may end without a trailing newline
    return { lastResult, tail };
  }
  return { push, finalize };
}

function runDockerStreaming(dockerArgs, { timeout, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", dockerArgs, { env });
    const collector = makeStreamingCollector();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collector.push(chunk));
    // stderr is not needed for the result, but draining it prevents the
    // child from ever blocking on a full stderr pipe - the exact class of
    // bug (a full, unread pipe) that produced the original SIGPIPE.
    child.stderr.resume();

    child.on("error", (err) => {
      clearTimeout(timer);
      const { lastResult, tail } = collector.finalize();
      err.lastResult = lastResult;
      err.outputTail = tail;
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const { lastResult, tail } = collector.finalize();
      if (code === 0 && !signal) {
        resolve({ lastResult, tail });
        return;
      }
      const err = new Error(
        timedOut
          ? `docker killed after ${timeout}ms timeout`
          : `docker exited with code ${code}${signal ? `, signal ${signal}` : ""}`
      );
      err.code = code;
      err.signal = signal;
      err.lastResult = lastResult;
      err.outputTail = tail;
      reject(err);
    });
  });
}

// Poll interval in milliseconds (10 seconds)
const POLL_INTERVAL_MS = 10000;

// Max concurrent tasks (e2-micro has limited RAM)
const MAX_CONCURRENT = 1;

// Cline timeout (25 minutes, same as executor.yml)
const CLINE_TIMEOUT_MS = 120 * 60 * 1000;

// Lane → { model, promptFile }
const LANE_CONFIG = {
  architect: { model: "plexus-act", promptFile: "./prompts/architect.md" },
  coder: { model: "plexus-coder", promptFile: "./prompts/coder.md" },
  qa: { model: "plexus-judge", promptFile: "./prompts/qa.md" },
};

async function loadRolePrompt(lane) {
  const cfg = LANE_CONFIG[lane] || LANE_CONFIG.architect;
  const promptText = await fs.readFile(cfg.promptFile, "utf8");
  return { model: cfg.model, systemPrompt: promptText };
}

// Safety cap against genuinely runaway output - not the normal path anymore.
// Real answers now go through notifyTelegram's own chunking, which splits
// at Telegram's actual per-message limit instead of silently discarding
// everything past a much smaller cap (found 2026-08-24: a real retro answer
// got cut mid-sentence at 3500 chars with no way to see the rest).
const MAX_OUTPUT = 60000;

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

// MarkdownV2 (telegramify-markdown) was tried first and dropped: it needs
// ~20 punctuation characters escaped everywhere in the text, not just
// inside formatting, and real multi-paragraph Cline output (numbered
// lists, headers) kept tripping Telegram's parser into a 400, silently
// falling back to raw GFM markdown as plain text - which is exactly the
// "bold looks like plain text, with literal **" the founder saw live.
// HTML mode only requires escaping & < > - far fewer ways to break - so a
// small hand-written converter for the handful of things Cline actually
// writes (bold, italic, inline code, headers) is more predictable than a
// general-purpose Markdown parser here. Tested locally against real
// multi-line output before shipping.
function markdownToTelegramHTML(text) {
  let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, "$1<i>$2</i>$3");
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  return s;
}

// Check if text contains a markdown table (|---| syntax)
function containsMarkdownTable(text) {
  return /|[\s]*:?-{3,}:?[\s]*|/.test(text);
}

function parseMarkdownTable(text) {
  const lines = text.split('\n');
  const tableLines = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableLines.push(trimmed);
      inTable = true;
    } else if (inTable) {
      break;
    }
  }
  if (tableLines.length < 2) return null;
  const rows = tableLines.map(line => line.split('|').slice(1, -1).map(c => c.trim()));
  let headerRow = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].every(cell => /^:?-+:?$/.test(cell))) {
      headerRow = i;
      break;
    }
  }
  const dataRows = rows.slice(headerRow + 1);
  return { headers: rows[0], rows: dataRows, allRows: rows.filter((_, i) => i !== headerRow) };
}

function markdownToRichText(text) {
  const tokenRe = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*/g;
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    if (m[1] !== undefined) parts.push({ type: 'bold', text: m[1] });
    else if (m[2] !== undefined) parts.push({ type: 'code', text: m[2] });
    else parts.push({ type: 'italic', text: m[3] });
    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  if (parts.length === 0) return text;
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  return parts;
}

function messageToRichBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  const tableMatch = parseMarkdownTable(text);
  if (tableMatch) {
    const tableStartIdx = lines.findIndex(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
    const separatorIdx = lines.slice(tableStartIdx).findIndex(l => /|[\s]*:?-{3,}:?[\s]*|/.test(l));
    const actualSeparatorIdx = tableStartIdx + separatorIdx;
    let tableEndIdx = actualSeparatorIdx + 1;
    while (tableEndIdx < lines.length && lines[tableEndIdx].trim().startsWith('|') && lines[tableEndIdx].trim().endsWith('|')) tableEndIdx++;
    const beforeText = lines.slice(0, tableStartIdx).join('\n').trim();
    if (beforeText) blocks.push({ type: 'paragraph', text: markdownToRichText(beforeText) });
    const cells = tableMatch.allRows.map(r => r.map(c => ({ text: markdownToRichText(c), align: 'left', valign: 'middle' })));
    blocks.push({ type: 'table', cells, is_bordered: true, is_striped: true, is_compact: false });
    const afterText = lines.slice(tableEndIdx).join('\n').trim();
    if (afterText) blocks.push({ type: 'paragraph', text: markdownToRichText(afterText) });
    return blocks;
  }
  const paragraphs = text.split('\n\n').filter(p => p.trim());
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed) blocks.push({ type: 'paragraph', text: markdownToRichText(trimmed) });
  }
  return blocks;
}

async function sendRichMessage(botToken, chatId, richBlocks) {
  const url = 'https://api.telegram.org/bot' + botToken + '/sendRichMessage';
  const body = { chat_id: chatId, rich_message: { blocks: richBlocks } };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('telegram sendRichMessage ' + res.status + ': ' + await res.text());
  return await res.text();
}


async function sendOneTelegramMessage(botToken, chatId, rawText) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let converted;
  try {
    converted = markdownToTelegramHTML(rawText);
  } catch (err) {
    console.log(`markdown-to-HTML conversion failed, sending raw: ${err.message}`);
    converted = null;
  }
  for (const [text, parse_mode] of converted ? [[converted, "HTML"], [rawText, undefined]] : [[rawText, undefined]]) {
    const body = parse_mode ? { chat_id: chatId, text, parse_mode } : { chat_id: chatId, text };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return await res.text();
    const errBody = await res.text();
    if (parse_mode) {
      console.log(`sendMessage with HTML failed (${res.status}), retrying plain: ${errBody.slice(0, 200)}`);
      continue;
    }
    throw new Error(`telegram sendMessage ${res.status}: ${errBody}`);
  }
}

async function notifyTelegram(botToken, chatId, message) {
  // Check if message contains markdown table - if so, use sendRichMessage
  if (containsMarkdownTable(message)) {
    try {
      const richBlocks = messageToRichBlocks(message);
      return await sendRichMessage(botToken, chatId, richBlocks);
    } catch (err) {
      console.log(`sendRichMessage failed, falling back to sendMessage: ${err.message}`);
      // Fall through to regular sendMessage path
    }
  }
  
  const chunks = splitForTelegram(message);
  let lastBody;
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks.length > 1 ? `${chunks[i]}\n\n[${i + 1}/${chunks.length}]` : chunks[i];
    lastBody = await sendOneTelegramMessage(botToken, chatId, text);
  }
  return lastBody;
}

export async function fetchHistory(db, creatorId, currentTaskId, lane, limit = 6) {
  // Fetch last N completed/failed tasks for this creator_id AND lane, excluding current task
  const res = await db.execute({
    sql: `SELECT text, result FROM tasks 
          WHERE creator_id = ? AND lane = ? AND status IN (?, ?) AND id != ? 
          ORDER BY created_at DESC LIMIT ?`,
    args: [creatorId, lane, "готова", "провал", currentTaskId, limit]
  });
  return res.rows;
}

// markdownToTelegramHTML (in sendOneTelegramMessage) makes bold/code safe
// automatically now - no need to warn about those. Tables are a separate,
// mode-independent problem: Telegram's supported HTML tag set (b, i, u, s,
// code, pre, a, blockquote, spoiler) has no <table> at all, same as
// MarkdownV2 has no table syntax - a table is unreadable in a Telegram bot
// message under any parse_mode, full stop. That one still needs telling.
const TELEGRAM_FORMAT_HINT =
  "Отвечаешь в Telegram-чат. Простое форматирование (жирный, курсив, код) " +
  "работает само. Markdown-таблицы (|---|) тоже поддерживаются — " +
  "конвертируются в нативный формат Telegram автоматически. Длинный ответ — " +
  "это нормально, он придёт несколькими сообщениями подряд.";

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

async function doWork(db, text, litellmMasterKey, creatorId, currentTaskId, lane) {
  // Load role-specific prompt and model for this lane
  const { model, systemPrompt } = await loadRolePrompt(lane);
  
  // Fetch history from Turso (filtered by lane) and build combined prompt
  const historyRows = await fetchHistory(db, creatorId, currentTaskId, lane, 6);
  const combinedPrompt = `${systemPrompt}\n\n${buildPromptWithHistory(text, historyRows)}`;

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
    "-m", model,
    "--compaction", "off",
    "--retries", "3",
    "--json",
    combinedPrompt
  ];

  console.log(`[${new Date().toISOString()}] Docker command: docker ${dockerArgs.join(" ")}`);

  // Retry logic for transient Docker exit codes 125, 126, 127, 128
  const TRANSIENT_CODES = new Set([125, 126, 127, 128]);
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5000;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { lastResult: result, tail } = await runDockerStreaming(dockerArgs, {
        timeout: CLINE_TIMEOUT_MS,
        env: {
          ...process.env,
          LITELLM_MASTER_KEY: litellmMasterKey,
        }
      });

      if (!result) {
        return {
          success: false,
          message: truncate(`агент не вернул run_result\n${tail.replace(ANSI, "").slice(-1500)}`)
        };
      }

      const ok = result.finishReason === "completed";
      const body = (result.text || "(агент ничего не ответил)").trim();
      if (attempt > 1) {
        console.log(`[${new Date().toISOString()}] Docker succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
      }
      return {
        success: ok,
        message: truncate(ok ? body : `${result.finishReason}: ${body}`)
      };
    } catch (err) {
      lastError = err;
      const code = err.code ?? err.signal ?? "?";
      const numericCode = typeof code === "number" ? code : parseInt(code, 10);

      console.log(`[${new Date().toISOString()}] Docker attempt ${attempt}/${MAX_ATTEMPTS} failed with exit code: ${code}`);

      // Check if we should retry
      const isTransient = !isNaN(numericCode) && TRANSIENT_CODES.has(numericCode);
      const isLastAttempt = attempt === MAX_ATTEMPTS;

      if (isTransient && !isLastAttempt) {
        console.log(`[${new Date().toISOString()}] Transient Docker error (code ${numericCode}), retrying in ${RETRY_DELAY_MS/1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      // Not a transient error, or last attempt - fall through to error handling
      break;
    }
  }

  // If we got here, all retries exhausted or non-transient error
  const err = lastError;
  const result = err.lastResult;
  if (result) {
    return { success: false, message: truncate(`${result.finishReason}: ${(result.text || "").trim()}`) };
  }
  const first = String(err.message || err).split("\n")[0];
  const code = err.code ?? err.signal ?? "?";
  console.log(`[${new Date().toISOString()}] Docker failed after ${MAX_ATTEMPTS} attempt(s), final exit code: ${code}`);
  if (err.outputTail) {
    console.log(`[${new Date().toISOString()}] Last ${err.outputTail.length} chars of output before failure:\n${err.outputTail}`);
  }
  return { success: false, message: truncate(`код ${code}: ${first}`) };
}

async function sendTypingAction(botToken, chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch (err) {
    console.log(`sendChatAction failed (non-fatal): ${err.message}`);
  }
}

// Self-queuing hand-off, Architect lane only. Cline never receives Turso
// credentials directly - the same lesson already learned the hard way with
// a repo-push token (queue-engine-cloud-hosting-pattern.md pitfall #13): a
// secret placed in an LLM's own environment leaks through routine commands
// like `env`, no matter how firmly the prompt says not to run them. Instead
// Architect writes plain-text requests to a file in the mount it already
// shares with the poller (/home/runner/.cline, present in both
// poller.service and the plexus-render container's own -v flags - no new
// mount needed) and this trusted, non-LLM code does the actual INSERT.
const QUEUE_REQUEST_PATH = "/home/runner/.cline/queue-request.jsonl";
const VALID_LANES = new Set(["architect", "coder", "qa"]);

async function processQueueRequests(db, creatorId, lane) {
  if (lane !== "architect") return; // only the Architect role promotes work
  let raw;
  try {
    raw = await fs.readFile(QUEUE_REQUEST_PATH, "utf8");
  } catch {
    return; // no requests this run - the common case
  }
  // Delete first: a malformed or half-written file must not be retried
  // forever on every future Architect turn.
  await fs.unlink(QUEUE_REQUEST_PATH).catch(() => {});

  let queued = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let req;
    try {
      req = JSON.parse(t);
    } catch {
      console.log(`[${new Date().toISOString()}] queue-request: skipped invalid JSON line: ${t.slice(0, 200)}`);
      continue;
    }
    if (!VALID_LANES.has(req.lane) || typeof req.text !== "string" || !req.text.trim()) {
      console.log(`[${new Date().toISOString()}] queue-request: skipped invalid entry (lane=${req.lane}): ${t.slice(0, 200)}`);
      continue;
    }
    await db.execute({
      sql: "INSERT INTO tasks (text, status, creator_id, lane) VALUES (?, ?, ?, ?)",
      args: [req.text.trim(), "ожидает", creatorId, req.lane]
    });
    queued++;
  }
  if (queued > 0) {
    console.log(`[${new Date().toISOString()}] queue-request: queued ${queued} new task(s) from Architect`);
  }
}

async function processTask(db, task, botToken, litellmMasterKey) {
  const taskId = task.id;
  const startTime = Date.now();
  const lane = task.lane || 'architect';

  console.log(`[${new Date().toISOString()}] Processing task ${taskId}: ${task.text.slice(0, 80)} [lane: ${lane}]`);

  // Mark as running - reuse exact same query as executor.mjs
  await db.execute({
    sql: "UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?",
    args: ["выполняется", `poller-${process.pid}-${Date.now()}`, taskId]
  });

  // Execute work - keep typing visible for the whole duration, not just
  // the Worker's one-shot send on receipt.
  const workStart = Date.now();
  await sendTypingAction(botToken, task.creator_id);
  const typingInterval = setInterval(() => sendTypingAction(botToken, task.creator_id), 4000);
  let result;
  try {
    result = await doWork(db, task.text, litellmMasterKey, task.creator_id, taskId, lane);
  } finally {
    clearInterval(typingInterval);
  }
  const workEnd = Date.now();

  // Pick up any tasks Architect asked to queue during this run, before
  // reporting back to Telegram - so a follow-up message the founder sends
  // right after seeing the reply already finds the new rows in place.
  await processQueueRequests(db, task.creator_id, lane).catch((err) => {
    console.log(`[${new Date().toISOString()}] queue-request processing failed (non-fatal): ${err.message}`);
  });

  // Update task - reuse exact same query as executor.mjs
  const status = result.success ? "готова" : "провал";
  const minutesUsed = Math.ceil((workEnd - workStart) / 60000);
  const secondsToFirstWork = Math.floor((workStart - startTime) / 1000);

  await db.execute({
    sql: `UPDATE tasks SET status = ?, result = ?, actions_run_id = ?, seconds_to_first_work = ?, minutes_used = ? WHERE id = ?`,
    args: [status, result.message, `poller-${process.pid}-${Date.now()}`, secondsToFirstWork, minutesUsed, taskId]
  });

  // Notify via Telegram to creator - reuse exact same logic as executor.mjs
  await notifyTelegram(botToken, task.creator_id, result.message);

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

  await ensureTasksFile();

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
