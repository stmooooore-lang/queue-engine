/**
 * Task executor for the cloud queue.
 *
 * Lives in a file, not inlined into the workflow. It was inlined under
 * `run: node -e "` and the YAML stopped parsing at the first colon inside the
 * JavaScript - three runs failed before a job was ever created, which is why
 * the failures carried no logs and no steps. A script in a file cannot break
 * the workflow that calls it.
 *
 * Reads one pending task from Turso, runs it, writes the result back and tells
 * the owner in Telegram. Secrets come from the environment; none are printed.
 */

import { createClient } from "@libsql/client";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

async function run() {
  const taskId = process.env.TASK_ID;
  const startTime = Date.now();

  // Fetch task
  const taskRes = await client.execute({ sql: 'SELECT * FROM tasks WHERE id = ? AND status = ?', args: [taskId, 'ожидает'] });
  const task = taskRes.rows[0];
  if (!task) { console.log('No pending task found'); return; }

  // Mark as running
  await client.execute({ sql: 'UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?', args: ['выполняется', process.env.GITHUB_RUN_ID, taskId] });

  // Execute work
  const workStart = Date.now();
  const result = await doWork(task.text);
  const workEnd = Date.now();

  // Update task
  const status = result.success ? 'готова' : 'провал';
  const minutesUsed = Math.ceil((workEnd - workStart) / 60000);
  const secondsToFirstWork = Math.floor((workStart - startTime) / 1000);

  await client.execute({ 
    sql: 'UPDATE tasks SET status = ?, result = ?, actions_run_id = ?, seconds_to_first_work = ?, minutes_used = ? WHERE id = ?',
    args: [status, result.message, process.env.GITHUB_RUN_ID, secondsToFirstWork, minutesUsed, taskId]
  });

  // Notify via Telegram to creator
  await notifyTelegram(task.creator_id, `Задача ${taskId} ${status}: ${result.message}`);
}

// The agent works INSIDE plexus/ and nowhere else. Founder's decision
// 2026-08-22: a task arriving from a messenger turns text into work, and the
// only limit that is easy to state and easy to check is where it is allowed to
// touch. Everything the product needs lives under plexus/; nothing outside it
// is a task the phone should be starting.
const WORKDIR = "plexus";

// Telegram caps a message at 4096 characters; keep well under it.
const MAX_OUTPUT = 3500;

function truncate(s) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (обрезано)` : s;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * The task text becomes one Cline turn against plexus/ - not a shell command.
 * A task typed into the phone is meant to work like a task typed into
 * cloud-agent.yml directly: same lane (plexus-act), same proxy, same
 * confinement to plexus/ by --cwd, enforced again from outside by the
 * workflow's post-run git-status check. The workflow step before this one
 * ("proxy with the real lanes") must already be up; this function assumes it
 * is and only shells out to `cline`.
 */
// --json turns cline's output into one JSON object per line - hook_event,
// agent_event (reasoning tokens, tool calls, text tokens as they stream) and,
// last, a single run_result line carrying the assembled final answer in its
// own `text` field. That line, and nothing else, is what belongs in a
// Telegram message: measured on 2026-08-23, a plain-text run sent the whole
// transcript - [thinking], tool calls, everything - which is unreadable in a
// chat.
function extractFinalAnswer(jsonLines) {
  let last = null;
  for (const line of jsonLines.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t);
      if (d.type === "run_result") last = d;
    } catch {
      // a non-JSON line (a warning printed to stdout, e.g. the Node/CA one
      // seen on 2026-08-23) - not the channel we read from, skip it
    }
  }
  return last;
}

async function doWork(text) {
  try {
    const { stdout } = await execFile(
      "cline",
      ["--cwd", WORKDIR, "-P", "openai-compatible", "-m", "plexus-act", "--compaction", "off", "--retries", "3", "--json", text],
      { timeout: 25 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
    );
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

async function notifyTelegram(chatId, message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
}

run().catch(console.error);