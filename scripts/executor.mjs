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
 *
 * 2026-09-12: model-calling layer changed from cline + a local litellm proxy
 * to dsh, calling real providers (Groq/NVIDIA/Mistral/Gemini) directly - no
 * proxy in front of it. Everything else (Turso claim/write, Telegram notify,
 * WORKDIR confinement, output sanitization) is unchanged from the previous
 * cline-based version. See docs/DECISIONS.md in the founder's own
 * "Continue MODELS integration" project for the real provider-config schema
 * and the real bugs found/fixed while building this (litellm routing
 * prefixes on model ids; dsh validates every registered provider's
 * credential at boot, not just the one selected - hence DSH_PROXY_DUMMY_KEY
 * below, defensive, harmless since no plexus-proxy entry exists here).
 */

import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

// Real, direct-provider config (2026-09-12) - no litellm alias model
// strings, no routing prefixes (groq/, mistral/, gemini/ are litellm's own
// convention, confirmed wrong by direct API tests against the real
// providers - see docs/DECISIONS.md). NVIDIA's "nvidia/" prefix IS real -
// confirmed against the one working example in ~/.dsh/settings.yaml's own
// nvidia-direct entry, not a litellm artifact.
const PROVIDER_ORDER = ["groq", "nvidia", "mistral"];
const PROVIDER_CONFIG = {
  groq: { baseURL: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  nvidia: { baseURL: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", model: "nvidia/nemotron-3-ultra-550b-a55b" },
  mistral: { baseURL: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", model: "mistral-medium-3-5" },
};

// Capacity-shaped failure detector - same real pattern used throughout this
// project's own local queue.sh and the parallel GHQ work tonight.
const CAPACITY_RE = /MidStreamFallbackError|ServiceUnavailableError|No deployments available|RateLimitError|Service temporarily overloaded|APIConnectionError|ECONNREFUSED|Connection error|high demand|UNAVAILABLE|hook dispatch failed|operation timed out/i;

function nextProvider(current, tried) {
  const remaining = PROVIDER_ORDER.filter((p) => !tried.has(p));
  if (remaining.length === 0) return null;
  const idx = PROVIDER_ORDER.indexOf(current);
  for (let i = 1; i <= PROVIDER_ORDER.length; i++) {
    const candidate = PROVIDER_ORDER[(idx + i) % PROVIDER_ORDER.length];
    if (!tried.has(candidate)) return candidate;
  }
  return remaining[0];
}

// Telegram caps a message at 4096 characters; keep well under it.
const MAX_OUTPUT = 60000;

function truncate(s) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (обрезано)` : s;
}

// Same guard as poller.mjs (2026-08-30): a raw HTML error page from a
// provider must not be forwarded as if it were model text.
function sanitizeModelText(text) {
  const t = (text || "").trim();
  if (!t) return t;
  const looksLikeHtmlPage = /^<!DOCTYPE html/i.test(t) || /^<html[\s>]/i.test(t);
  const hasHugeUnbrokenToken = /\S{500,}/.test(t);
  if (looksLikeHtmlPage || hasHugeUnbrokenToken) {
    return `[proxy/HTTP error, not a model answer - looks like ${looksLikeHtmlPage ? "an HTML error page" : "a raw binary/encoded blob"}]`;
  }
  return t;
}

/**
 * Runs one real dsh turn against WORKDIR, using the given direct provider.
 * dsh's --patch overlay selects the provider/model via the real, confirmed
 * agent-default-model mechanism (see docs/DECISIONS.md for how this was
 * verified). Real DSH_PERMISSION_MODE=danger-full-access matches every
 * other real dsh call this project has made tonight - a headless runner has
 * no human to approve tool calls interactively.
 */
async function runDshOnce(provider, text) {
  const cfg = PROVIDER_CONFIG[provider];
  const patchContent = `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${cfg.model}\n`;
  const patchFile = path.join(os.tmpdir(), `dsh-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
  await writeFile(patchFile, patchContent, "utf-8");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("dsh", ["--profile", "headless", "--patch", patchFile, text], {
        cwd: WORKDIR,
        env: { ...process.env, DSH_PERMISSION_MODE: "danger-full-access", DSH_PROXY_DUMMY_KEY: "unused" },
      });
      let out = "";
      let err = "";
      // Job-level cap in executor.yml is 30 min total (checkout + install +
      // settings write leaves ~27 min of work budget). Up to 3 providers can
      // be tried in rotation, so each single attempt gets 8 min, not the
      // 120 min a lone cline call could afford - a shorter, self-reported
      // timeout that still notifies Telegram beats a silent hard kill by
      // Actions' own job timeout with no result written at all.
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("dsh timed out after 8min")); }, 8 * 60 * 1000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      // 2026-09-12: was `child.stderr.resume()` (discard) - real bug found
      // this way needed the actual stderr content to diagnose, so it's
      // captured (bounded) instead of thrown away.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
      child.on("close", (code) => {
        clearTimeout(timer);
        console.error(`TEMP DEBUG dsh close: code=${code} out.length=${out.length} err.length=${err.length}`);
        console.error(`TEMP DEBUG out=${JSON.stringify(out)}`);
        console.error(`TEMP DEBUG err=${JSON.stringify(err)}`);
        const trimmed = out.trim();
        if (code === 0 && trimmed === "" && err.trim() !== "") {
          reject(new Error(`dsh exited 0 with empty stdout, stderr: ${err.slice(-1500)}`));
        } else if (code === 0) {
          resolve(trimmed);
        } else {
          reject(new Error(`dsh exited ${code}: ${(out || err).slice(-1500)}`));
        }
      });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  } finally {
    await unlink(patchFile).catch(() => {});
  }
}

/**
 * The task text becomes one dsh turn against plexus/ - real capacity-shaped
 * failures rotate to the next real provider (Groq -> NVIDIA -> Mistral),
 * same real mechanism verified tonight in worker/rotation.js.
 */
async function doWork(text) {
  const tried = new Set();
  let provider = PROVIDER_ORDER[0];
  let lastErr = null;
  for (let attempt = 0; attempt < PROVIDER_ORDER.length; attempt++) {
    tried.add(provider);
    try {
      const rawBody = await runDshOnce(provider, text);
      const sanitized = rawBody ? sanitizeModelText(rawBody) : "";
      const isGarbage = rawBody !== "" && sanitized !== rawBody;
      const body = rawBody ? sanitized : "(агент ничего не ответил)";
      const ok = !isGarbage && rawBody !== "";
      return { success: ok, message: truncate(ok ? body : `empty: ${body}`) };
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      if (!CAPACITY_RE.test(msg)) {
        return { success: false, message: truncate(`код ${err.code ?? "?"}: ${msg.split("\n")[0]}`) };
      }
      const next = nextProvider(provider, tried);
      if (next === null) break;
      console.log(`[${new Date().toISOString()}] capacity-shaped failure on ${provider} (${msg.split("\n")[0]}) - switching to ${next}`);
      provider = next;
    }
  }
  const msg = String(lastErr?.message || lastErr || "unknown error");
  return { success: false, message: truncate(`код ${lastErr?.code ?? "?"}: ${msg.split("\n")[0]}`) };
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
