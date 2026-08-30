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

// 2026-08-30: same class of error queue.sh's own CAPACITY_RE already
// handles locally (docs/DECISIONS.md, 2026-08-21) - "the provider is busy
// right now" is not the same fact as "this task is broken," and treating
// them the same either hides a real transient wait behind a false failure,
// or (worse, as tonight) drops the founder with silence and no path
// forward. The VM poller never had this at all until now.
// 2026-08-30: two more shapes joined this list after being seen in the
// wild without ever triggering a retry. (1) "proxy/HTTP error" is
// sanitizeModelText's own label - a raw HTML/binary error page from Render
// isn't a litellm exception, so none of the patterns above ever matched it,
// and it went straight to the founder as if it were a real (if odd)
// answer. (2) "hook dispatch failed" / "operation timed out" is a Cline
// CLI-level hiccup, confirmed via queue-log/ going back to 2026-08-19 across
// unrelated tasks/models/lanes with no correlation to task content - a
// tooling glitch, not a real task failure, exactly like the others here.
// 2026-08-30: "агент ничего не ответил" joined this list after task 63
// completed with finishReason "completed" and empty text - doWork() now
// treats that as a failure too (see the isGarbage/rawBody check below), and
// it needs the same retry-with-recovery-path treatment as everything else
// here rather than a silent false "готова".
const CAPACITY_RE = /MidStreamFallbackError|ServiceUnavailableError|No deployments available|RateLimitError|Service temporarily overloaded|APIConnectionError|ECONNREFUSED|Connection error|high demand|UNAVAILABLE|proxy\/HTTP error|hook dispatch failed|operation timed out|агент ничего не ответил/i;
const CAPACITY_RETRY_MAX = 3;
const CAPACITY_RETRY_DELAY_MS = 2 * 60 * 1000;

// Human-readable reason for the mid-retry notice - the founder sees this,
// not the regex that triggered it.
function classifyRetryReason(message) {
  if (/агент ничего не ответил/i.test(message)) {
    return "Ассистент не прислал текстовый ответ, хотя поработал";
  }
  if (/proxy\/HTTP error/i.test(message)) {
    return "Провайдер вернул техническую ошибку вместо ответа";
  }
  if (/hook dispatch failed|operation timed out/i.test(message)) {
    return "Техническая заминка в обработке запроса";
  }
  return "Провайдер сейчас перегружен";
}

// 2026-08-30: the FINAL failure notice (the one attached to failureKeyboard,
// after retries are exhausted or on an immediate non-capacity failure) was
// still sending the raw result.message - things like "код 137: ..." or
// "completed: (агент ничего не ответил)" - so the Retry/coder/cheap/gemini
// buttons showed up next to unreadable technical text instead of an actual
// explanation. classifyRetryReason() alone doesn't cover this: it assumes
// CAPACITY_RE already matched, which isn't true for a same-attempt failure
// that broke the retry loop on its first try.
function classifyFinalReason(message) {
  if (CAPACITY_RE.test(message)) {
    return `${classifyRetryReason(message)}, и это не исправилось за ${CAPACITY_RETRY_MAX} попытки`;
  }
  if (/агент не вернул run_result/i.test(message)) {
    return "Не удалось получить ответ от ассистента";
  }
  if (/код -?\d+:/i.test(message)) {
    return "Техническая ошибка при выполнении задачи";
  }
  return "Произошла техническая ошибка при обработке запроса";
}

// Button-tap-as-text: a Telegram reply keyboard sends its label as an
// ordinary text message, indistinguishable at the Worker from anything the
// founder typed by hand - recognized here, not in worker/index.js, so the
// already-working message path there needs no changes at all.
const BUTTON_RETRY = "Retry";
const BUTTON_MODEL_MAP = { coder: "plexus-coder", cheap: "plexus-cheap", gemini: "plexus-gemini" };
// 2026-08-30: separate from failureKeyboard() below - this one shows up
// mid-retry (task still "выполняется"), before there's any failed task for
// Retry/coder/cheap/gemini to replay. Its only job is to let the founder
// stop an unwanted retry early instead of watching it play out to the end.
const BUTTON_CANCEL = "Отмена";
function cancelKeyboard() {
  return {
    keyboard: [[BUTTON_CANCEL]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}
// Checked between retry-wait slices (see processTask). A tap lands as an
// ordinary new "ожидает" row - same mechanism as Retry/coder/cheap/gemini -
// but nothing else ever consumes it, so it would otherwise sit there until
// this processTask() call returns and the poll loop finally reaches it,
// well after the retries it was meant to stop had already finished.
async function checkForCancel(db, creatorId) {
  const res = await db.execute({
    sql: `SELECT id FROM tasks WHERE creator_id = ? AND status = ? AND text = ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [creatorId, "ожидает", BUTTON_CANCEL]
  });
  if (res.rows.length === 0) return false;
  await db.execute({
    sql: "UPDATE tasks SET status = ?, result = ? WHERE id = ?",
    args: ["готова", "Отмена учтена.", res.rows[0].id]
  });
  return true;
}
function detectButtonAction(text) {
  const t = (text || "").trim().toLowerCase();
  if (t === BUTTON_RETRY.toLowerCase()) return "retry";
  if (Object.prototype.hasOwnProperty.call(BUTTON_MODEL_MAP, t)) return t;
  return null;
}
function failureKeyboard() {
  return {
    keyboard: [[BUTTON_RETRY], Object.keys(BUTTON_MODEL_MAP)],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

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

// 2026-08-30: a Render 502 returned a raw HTML error page (complete with
// inline <style> and base64-encoded font data) instead of JSON. Nothing in
// the pipeline distinguished that from a real model answer - it went
// through truncate() and Telegram's own chunker as if it were text, and
// arrived as 16 messages, the tail end of which is one unbroken base64
// token with no spaces: it reads as noise regardless of whether HTML tags
// survive Telegram's rendering. Catch this before it reaches truncate().
function sanitizeModelText(text) {
  const t = (text || "").trim();
  if (!t) return t;
  const looksLikeHtmlPage = /^<!DOCTYPE html/i.test(t) || /^<html[\s>]/i.test(t);
  // A run of 500+ characters with no whitespace is never legitimate model
  // prose - it is exactly the shape of a base64 blob or a minified asset
  // accidentally captured as "the answer".
  const hasHugeUnbrokenToken = /\S{500,}/.test(t);
  if (looksLikeHtmlPage || hasHugeUnbrokenToken) {
    // 2026-08-30: used to append a 300-char raw snippet "for debugging" -
    // that snippet starts at char 0 of the same garbage this exists to
    // hide, so the founder still received a base64/HTML fragment, just a
    // shorter one. The raw text is still on stdout via the caller's own
    // console.log before this runs; nothing is lost by not re-sending it.
    return `[proxy/HTTP error, not a model answer - looks like ${looksLikeHtmlPage ? "an HTML error page" : "a raw binary/encoded blob"}]`;
  }
  return t;
}

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


async function sendOneTelegramMessage(botToken, chatId, rawText, replyMarkup) {
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
    if (replyMarkup) body.reply_markup = replyMarkup;
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

async function notifyTelegram(botToken, chatId, message, replyMarkup) {
  // Check if message contains markdown table - if so, use sendRichMessage
  // (a keyboard on a rich message isn't supported by this path - if that
  // combination is ever needed, it needs its own handling, not assumed here)
  if (!replyMarkup && containsMarkdownTable(message)) {
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
    // The keyboard only makes sense attached to the last chunk - it is the
    // one the founder sees right before deciding whether to tap a button.
    const isLast = i === chunks.length - 1;
    lastBody = await sendOneTelegramMessage(botToken, chatId, text, isLast ? replyMarkup : undefined);
  }
  return lastBody;
}

export async function fetchHistory(db, creatorId, currentTaskId, lane, limit = 6) {
  // 2026-08-30: this used to pull "провал" rows into history too - a failed
  // task's own `result` is a raw error string (a docker command line with
  // real host paths, a litellm exception, a SIGKILL/SIGPIPE code, once even
  // a leaked sanitizer stand-in like "[Tool call(s) read_files were made
  // earlier...]"), never a real answer. Replaying that as "Ассистент: <raw
  // error>" in a prior turn hands the model garbage dressed up as its own
  // past words - a plausible contributor to it answering with nothing at
  // all, or (observed the same night, in a cloud-agent run) emitting
  // malformed tool-call-shaped tokens. Only a genuine answer belongs in
  // replayed history; a failure's own record stays in Turso for
  // diagnostics, it just does not get fed back in as false context.
  const res = await db.execute({
    sql: `SELECT text, result FROM tasks
          WHERE creator_id = ? AND lane = ? AND status = ? AND id != ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [creatorId, lane, "готова", currentTaskId, limit]
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

async function doWork(db, text, litellmMasterKey, creatorId, currentTaskId, lane, modelOverride) {
  // Load role-specific prompt and model for this lane. An explicit
  // modelOverride (from a "coder"/"cheap"/"gemini" button tap) bypasses the
  // lane's own model choice but keeps its system prompt and history scope -
  // the founder picked a different model for the same role, not a
  // different role.
  const { model: laneModel, systemPrompt } = await loadRolePrompt(lane);
  const model = modelOverride || laneModel;

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

      const rawBody = (result.text || "").trim();
      const sanitized = rawBody ? sanitizeModelText(rawBody) : "";
      // sanitizeModelText only rewrites non-empty text when it detected an
      // HTML error page or a raw binary/encoded blob - a real answer always
      // comes back unchanged. Treat that case as a failure (not a garbage
      // "success") so it enters the CAPACITY_RE retry loop in processTask()
      // instead of reaching the founder as a completed task.
      const isGarbage = rawBody !== "" && sanitized !== rawBody;
      if (isGarbage) {
        console.log(`[${new Date().toISOString()}] sanitizeModelText caught garbage output, raw (first 500 chars): ${rawBody.slice(0, 500)}`);
      }
      const body = rawBody ? sanitized : "(агент ничего не ответил)";
      // 2026-08-30: task 63 finished with finishReason "completed" and an
      // empty text - counted as success, delivered to Telegram as a silent
      // "готова" with nothing in it. rawBody !== "" closes that: an empty
      // answer is now a failure like any other, eligible for the same
      // retry-with-recovery-path as everything else in this function.
      const ok = result.finishReason === "completed" && !isGarbage && rawBody !== "";
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
    return { success: false, message: truncate(`${result.finishReason}: ${sanitizeModelText(result.text)}`) };
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

// A button tap arrives as plain text identical to its label - looked up
// against the founder's own most recent failure, not tied to a specific
// message via callback data, because that's the only state a plain reply
// keyboard carries. Scoped to this creator_id only; lane is deliberately
// not filtered here - a retry should find whatever actually just failed.
async function findLastFailedTask(db, creatorId, excludeTaskId) {
  const res = await db.execute({
    sql: `SELECT id, text FROM tasks WHERE creator_id = ? AND status = ? AND id != ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [creatorId, "провал", excludeTaskId]
  });
  return res.rows[0] || null;
}

async function processTask(db, task, botToken, litellmMasterKey) {
  const taskId = task.id;
  const startTime = Date.now();
  const lane = task.lane || 'architect';

  console.log(`[${new Date().toISOString()}] Processing task ${taskId}: ${task.text.slice(0, 80)} [lane: ${lane}]`);

  // A tap on "Retry" / "coder" / "cheap" / "gemini" is indistinguishable
  // from typed text at this point - detect it before treating this as a
  // brand new request, and substitute the failed task's own text.
  const buttonAction = detectButtonAction(task.text);
  let effectiveText = task.text;
  let modelOverride = null;
  if (buttonAction) {
    const prev = await findLastFailedTask(db, task.creator_id, taskId);
    if (!prev) {
      await db.execute({
        sql: "UPDATE tasks SET status = ?, result = ? WHERE id = ?",
        args: ["готова", "Nothing to retry - no recent failed task found.", taskId]
      });
      await notifyTelegram(botToken, task.creator_id, "Nothing to retry - no recent failed task found.");
      console.log(`[${new Date().toISOString()}] Task ${taskId}: button "${task.text}" tapped, no prior failure to act on`);
      return;
    }
    effectiveText = prev.text;
    if (buttonAction !== "retry") modelOverride = BUTTON_MODEL_MAP[buttonAction];
    console.log(`[${new Date().toISOString()}] Task ${taskId}: button action "${buttonAction}" -> replaying task ${prev.id}${modelOverride ? ` on ${modelOverride}` : ""}`);
  }

  // Mark as running - reuse exact same query as executor.mjs
  await db.execute({
    sql: "UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?",
    args: ["выполняется", `poller-${process.pid}-${Date.now()}`, taskId]
  });

  // Execute work - keep typing visible for the whole duration, not just
  // the Worker's one-shot send on receipt. Includes any capacity-retry
  // waits below, so the indicator stays honest about "still working."
  const workStart = Date.now();
  await sendTypingAction(botToken, task.creator_id);
  const typingInterval = setInterval(() => sendTypingAction(botToken, task.creator_id), 4000);
  let result;
  try {
    // A provider being busy right now is not the same fact as this task
    // being broken - retry the same request a few times, spaced out,
    // before treating it as a real failure. Loop lives here (inside one
    // processTask call), not across poll iterations, so no persisted
    // retry-count state is needed.
    let attempt = 0;
    let cancelled = false;
    do {
      attempt++;
      result = await doWork(db, effectiveText, litellmMasterKey, task.creator_id, taskId, lane, modelOverride);
      if (result.success || !CAPACITY_RE.test(result.message) || attempt >= CAPACITY_RETRY_MAX) break;
      if (attempt === 1) {
        await notifyTelegram(
          botToken, task.creator_id,
          `${classifyRetryReason(result.message)}, пробую ещё раз (попытка ${attempt} из ${CAPACITY_RETRY_MAX}). Если не нужно - нажми «${BUTTON_CANCEL}».`,
          cancelKeyboard()
        );
      }
      // Waited in short slices, not one setTimeout for the full 2 minutes,
      // so a tap on "Отмена" is caught before the NEXT attempt fires -
      // otherwise the founder has no way to stop an unwanted retry short of
      // waiting out all CAPACITY_RETRY_MAX attempts.
      const sliceMs = 15000;
      for (let waited = 0; waited < CAPACITY_RETRY_DELAY_MS; waited += sliceMs) {
        await new Promise(r => setTimeout(r, Math.min(sliceMs, CAPACITY_RETRY_DELAY_MS - waited)));
        if (await checkForCancel(db, task.creator_id)) {
          cancelled = true;
          break;
        }
      }
      if (cancelled) break;
    } while (attempt < CAPACITY_RETRY_MAX);
    if (cancelled) {
      result = { success: false, message: "Отменено по запросу." };
    }
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

  // Notify via Telegram to creator - reuse exact same logic as executor.mjs.
  // A real (non-capacity, or capacity exhausted 3 times) failure offers a
  // way forward instead of a dead end: retry, or try a different model on
  // the same request. The raw result.message still goes into the DB above
  // (for debugging/history) but the founder gets a human sentence, not
  // "код 137: ..." next to a Retry button - cancelled is already a clean
  // sentence and skips the classifier so it isn't reworded into something
  // that sounds like an error.
  const founderMessage = result.success || result.message === "Отменено по запросу."
    ? result.message
    : `${classifyFinalReason(result.message)}. Задача не потерялась - выбери действие ниже.`;
  await notifyTelegram(botToken, task.creator_id, founderMessage, result.success ? undefined : failureKeyboard());

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
