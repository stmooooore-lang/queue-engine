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
import { spawn, execSync } from "node:child_process";
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

  // GHQ2-c, 2026-09-14: a triage-split subtask does not run before its
  // earlier, still-unaccepted sibling - leaves status untouched ('ожидает')
  // so a future dispatch for this same taskId gets a fresh chance once the
  // real blocker clears, rather than being marked done or failed for
  // simply arriving out of order.
  if (!(await siblingOrderOk(task))) {
    console.log(`[${new Date().toISOString()}] sibling-order: task ${taskId} is waiting on an earlier unaccepted sibling, not running yet`);
    return;
  }

  // Mark as running
  await client.execute({ sql: 'UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?', args: ['выполняется', process.env.GITHUB_RUN_ID, taskId] });

  // Triage: is this genuinely one unit of work, or several that should
  // run as independent, smaller dsh calls? (founder's own repeated
  // instruction, 2026-09-12 - see the triageCheck/triageSplit block
  // below for why this isn't just the local project's existing
  // worker/triage.js reused as-is.) Fail-safe: any error here just
  // proceeds to doWork() as one unit, same as before this existed.
  const triageDecision = await triageCheck(task.text);
  if (triageDecision.split) {
    const subtaskIds = await triageSplit(task, triageDecision).catch((err) => {
      console.log(`[${new Date().toISOString()}] triage split failed (${err.message}), proceeding as one unit instead`);
      return null;
    });
    if (subtaskIds && subtaskIds.length > 0) {
      const note = `ТРИАЖ: разбита на ${subtaskIds.length} подзадач: ${subtaskIds.join(", ")}`;
      await client.execute({
        sql: 'UPDATE tasks SET status = ?, result = ? WHERE id = ?',
        args: ['готова', note, taskId],
      });
      await notifyTelegram(task.creator_id, `Задача ${taskId} ${note}`);
      return;
    }
  }

  // GHQ4, 2026-09-14: real bug found via plexus-doc-ce's task 21 - this
  // job's own actions/checkout@v4 for plexus-doc has no ref:, so it always
  // lands on the default branch regardless of what the task text asks for.
  // actions/checkout's ref can't be templated from a value only known once
  // this script reads the real task row, so the branch switch happens
  // here instead, with real git commands, before any work starts.
  checkoutTaskBranch(task.text);

  // Execute work
  const workStart = Date.now();
  const result = await doWork(task.text, task);
  if (result.decomposed) {
    // TIMECEIL-CLOUD, 2026-09-14: real re-decomposition happened instead
    // of a normal pass/fail - the original oversized task is done in the
    // sense that it's been replaced by its own real subtasks (same
    // convention triageCheck's own split path already uses above).
    const note = `ТРИАЖ (после реального прогресса, обрезанного таймаутом): разбита на ${result.subtaskIds.length} подзадач: ${result.subtaskIds.join(", ")}`;
    await client.execute({ sql: 'UPDATE tasks SET status = ?, result = ? WHERE id = ?', args: ['готова', note, taskId] });
    await notifyTelegram(task.creator_id, `Задача ${taskId} ${note}`);
    return;
  }
  const workEnd = Date.now();

  // GHQ2-e, 2026-09-14 (built directly by Claude Code, founder's own
  // real-time call): a model's own answer/error text can genuinely
  // contain a real credential (an env var dump, a copy-pasted log line) -
  // scan and redact BEFORE it goes to Turso or Telegram, reusing the same
  // shapes queue-engine's own scripts/pre-commit-secret-scan.sh already
  // checks for (GCP service-account JSON, LiteLLM sk-.../MASTER_KEY).
  result.message = redactSecrets(result.message);

  // Update task
  // GHQ2-b, 2026-09-14: a permanent, founder-fixable verdict (no_address,
  // no_access, impossible_as_written, brief_conflicts_rules) gets a
  // persistent "заблокирована" status instead of "провал" - retrying the
  // same brief on a different provider cannot fix any of these, mirroring
  // queue.sh's own queue-blocked.txt semantics.
  const status = result.success ? 'готова' : (result.permanent ? 'заблокирована' : 'провал');
  const minutesUsed = Math.ceil((workEnd - workStart) / 60000);
  const secondsToFirstWork = Math.floor((workStart - startTime) / 1000);

  await client.execute({
    sql: 'UPDATE tasks SET status = ?, result = ?, actions_run_id = ?, seconds_to_first_work = ?, minutes_used = ? WHERE id = ?',
    args: [status, result.message, process.env.GITHUB_RUN_ID, secondsToFirstWork, minutesUsed, taskId]
  });

  // Notify via Telegram to creator
  await notifyTelegram(task.creator_id, `Задача ${taskId} ${status}: ${result.message}`);
}

// The agent works INSIDE WORKDIR and nowhere else. Founder's decision
// 2026-08-22: a task arriving from a messenger turns text into work, and the
// only limit that is easy to state and easy to check is where it is allowed to
// touch.
//
// 2026-09-13: changed from "plexus" (a partial, hand-synced snapshot checked
// into this repo) to a real checkout of the actual product repo, done as a
// second checkout step in executor.yml (same lightweight job, no VM) - a real
// no_access diagnost verdict on plexus-doc-ce's task 11 showed briefs written
// against the real repo's paths (notes/, site/engine/, etc) structurally
// couldn't work against the stale snapshot. Founder confirmed: the queue
// should see the real repo. Still read-mostly by convention - see
// executor.yml's confinement check and plexus-corridor.yml's header for why
// nothing here pushes back to plexus-doc on its own.
const WORKDIR = "plexus-doc";

// GHQ4, 2026-09-14 (built directly by Claude Code, founder's own real-time
// call - the local queue's own automated attempts at this exhausted every
// model without converging). Convention, confirmed against plexus-doc's own
// AGENTS.md: "ONE TASK, ONE BRANCH" - a brief names its target branch by
// name in its text (e.g. "branch cursor-build (NOT main)"). No match = no
// branch requested = leave the default checkout untouched, same as before
// this existed. Only safe branch-name characters are captured by the regex
// (alnum, dot, dash, underscore, slash) - never interpolated unsanitized
// into a shell command.
function checkoutTaskBranch(text) {
  const m = String(text || "").match(/\bbranch[:\s]+([A-Za-z0-9][A-Za-z0-9._\/-]*)/i);
  if (!m) {
    console.log(`[${new Date().toISOString()}] branch: none named in task text, staying on default checkout`);
    return null;
  }
  const branch = m[1].replace(/[.,;:]+$/, "");
  try {
    execSync(`git fetch origin ${branch}`, { cwd: WORKDIR, stdio: "pipe" });
    execSync(`git checkout ${branch}`, { cwd: WORKDIR, stdio: "pipe" });
    const actual = execSync("git branch --show-current", { cwd: WORKDIR }).toString().trim();
    console.log(`[${new Date().toISOString()}] branch: task named "${branch}", checked out (git reports: ${actual})`);
    return actual;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] branch: task named "${branch}" but checkout failed (${err.message}) - staying on default checkout`);
    return null;
  }
}

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
//
// 2026-09-12: real gap found via plexus-doc-ce's first real (non-trivial)
// task - dsh's own direct-provider error shape for Groq's rate limit is
// `RATE_LIMIT: 429: {...,"code":"rate_limit_exceeded"}`, not the
// `RateLimitError` string this regex already had (that shape came from
// litellm, which dsh doesn't use) - so a genuine capacity failure exited
// immediately on the first provider instead of rotating to NVIDIA/Mistral.
// Added both the dsh-native tag and the JSON body's own code field so
// either shape matches.
const CAPACITY_RE = /MidStreamFallbackError|ServiceUnavailableError|No deployments available|RateLimitError|RATE_LIMIT|rate_limit_exceeded|Service temporarily overloaded|APIConnectionError|ECONNREFUSED|Connection error|high demand|UNAVAILABLE|hook dispatch failed|operation timed out/i;

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

// GHQ2-e, 2026-09-14: reuses the exact same three real credential shapes
// `scripts/pre-commit-secret-scan.sh` already checks for at commit time -
// same repo, same real secrets it actually handles, just applied to a
// model's runtime output instead of staged git content. Fails safe: a
// regex that doesn't match anything just leaves the text untouched, never
// throws.
function redactSecrets(text) {
  let out = String(text || "");
  let hit = false;
  // GCP service-account JSON key - both markers together, same
  // specificity rule as the pre-commit script (avoids flagging ordinary
  // text that only mentions one of the two in isolation).
  if (/"type"\s*:\s*"service_account"/.test(out) && /BEGIN PRIVATE KEY/.test(out)) {
    out = out.replace(/\{[^{}]*"type"\s*:\s*"service_account"[\s\S]*?\}/g, "[REDACTED: GCP service-account JSON key]");
    hit = true;
  }
  // LiteLLM sk-... style key
  if (/sk-[A-Za-z0-9_-]{20,}/.test(out)) {
    out = out.replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED: sk-... key]");
    hit = true;
  }
  // *MASTER_KEY* assigned a 64-char hex value (openssl rand -hex 32 shape)
  const masterKeyRe = /(MASTER_KEY|LITELLM_MASTER_KEY)([\s]*[:=][\s]*)["']?[a-f0-9]{64}["']?/gi;
  if (masterKeyRe.test(out)) {
    out = out.replace(masterKeyRe, "$1$2[REDACTED: master key]");
    hit = true;
  }
  if (hit) console.log(`[${new Date().toISOString()}] secret-leak guard: redacted real credential shape(s) from task result before writing/notifying`);
  return out;
}

// GHQ2-d / TIMECEIL-CLOUD, 2026-09-14: real progress-vs-loop
// classification, ported verbatim (same heuristic, same threshold, same
// <2-segments fallback to "loop") from the local queue's own
// classify_kill_progress() (queue.sh, built for TIMECEIL earlier
// tonight) - see docs/DECISIONS.md's TIMECEIL entry in the founder's own
// "Continue MODELS integration" project for the original. dsh's own
// transcript marks each turn with a literal "dsh: reasoning:" line;
// consecutive segments are compared by word-set overlap - real
// repetition restates nearly the same sentence (high overlap), real
// progress reads as different text turn to turn even about the same
// file (low overlap). Returns exactly "loop" or "progress" - matching
// the local version's own two-value taxonomy, no third state invented.
function classifyTimeoutKill(text) {
  const clean = String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
  const segs = clean
    .split(/^dsh: reasoning:\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length < 2) return "loop";
  const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9а-я_./-]{3,}/g)) || []);
  let total = 0;
  let count = 0;
  for (let i = 1; i < segs.length; i++) {
    const wa = words(segs[i - 1]);
    const wb = words(segs[i]);
    if (wa.size === 0 || wb.size === 0) { total += 0; count++; continue; }
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter++;
    const union = new Set([...wa, ...wb]).size;
    total += union === 0 ? 0 : inter / union;
    count++;
  }
  const avg = count > 0 ? total / count : 0;
  return avg < 0.5 ? "progress" : "loop";
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
  // 2026-09-13: real bug found via plexus-doc-ce's Groq 413s on trivial
  // tasks after WORKDIR became the real plexus-doc repo (commit e84a572).
  // dsh's own "standard" preset (dsh-agent-presets/presets/standard/
  // agent.cordis.yml) sets agent-instructions' maxBytes: 65536 by
  // default - large enough to swallow plexus-doc's whole AGENTS.md/
  // CLAUDE.md unencoded on every single call, a fixed tax that alone can
  // exceed Groq's 8000 TPM budget before the real task prompt is even
  // considered.
  //
  // First attempt at this cap was 4096 bytes - founder correctly caught
  // that this would truncate plexus-doc's real AGENTS.md+CLAUDE.md
  // (27363 bytes even after plexus-doc-ce's own same-night router split,
  // confirmed via `gh api repos/.../contents`), risking real rule loss
  // (renderInstructionContext drops least-specific files then truncates
  // the most-specific remaining one - a genuine "incomplete brain" risk,
  // not just a token-count optimization). Set high enough here to hold
  // the current real file whole with real margin for growth (32768), not
  // tight enough to force truncation - the actual over-Groq-limit case
  // still relies on the already-working CAPACITY_RE rotation to NVIDIA
  // (no meaningful token limit there) rather than on truncating real
  // instructions to force-fit Groq specifically.
  // GHQ3, 2026-09-14 (built directly by Claude Code, founder's own
  // real-time call): CLAUDE.md's own content says it's a pointer for a
  // real interactive Claude Code session (canon/START-HERE.md), not
  // content dsh's headless calls need on top of the real AGENTS.md -
  // confirmed live tonight via a real `dsh --profile headless --patch
  // <file> --dump-config` run: instructionFileCandidates: ["AGENTS.md"]
  // against plexus-doc's real files produced full AGENTS.md content and
  // zero CLAUDE.md content, saving ~2.4KB/call with no loss.
  const patchContent = `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${cfg.model}\n- id: agent-instructions\n  config:\n    maxBytes: 32768\n    instructionFileCandidates: ["AGENTS.md"]\n`;
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
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        // GHQ2-d, 2026-09-14 (built directly by Claude Code, founder's own
        // real-time call): the brief this task started from named a file
        // (worker/loop-detection.js) that does not exist anywhere in this
        // repo's real history - a genuine brief defect, not something to
        // port as described. Real, working loop-detection DOES exist on
        // the local queue's own queue.sh (classify_kill_progress, built
        // earlier tonight for TIMECEIL) - ported that real algorithm here
        // instead: dsh's own transcript marks each turn with a literal
        // "dsh: reasoning:" line, split the captured stdout on that marker
        // and compare consecutive segments by word-set overlap. Real
        // repetition restates nearly the same sentence (high overlap);
        // real progress reads as different text turn to turn even about
        // the same file (low overlap).
        const timeoutErr = new Error("dsh timed out after 8min");
        // TIMECEIL-CLOUD, 2026-09-14: real classification, not just a
        // boolean - "progress" routes to re-decomposition below instead
        // of a same-task model-swap retry.
        timeoutErr.timeoutVerdict = classifyTimeoutKill(out);
        timeoutErr.isLoop = timeoutErr.timeoutVerdict === "loop";
        reject(timeoutErr);
      }, 8 * 60 * 1000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      // 2026-09-12: was `child.stderr.resume()` (discard) - real bug found
      // this way needed the actual stderr content to diagnose, so it's
      // captured (bounded) instead of thrown away.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
      child.on("close", (code) => {
        clearTimeout(timer);
        const trimmed = out.trim();
        if (code === 0 && trimmed === "" && err.trim() !== "") {
          reject(new Error(`dsh exited 0 with empty stdout, stderr: ${err.slice(-1500)}`));
        } else if (code === 0) {
          resolve(trimmed);
        } else {
          // 2026-09-12: real bug found via plexus-doc-ce's captured output -
          // `out` can be a non-empty but USELESS string (a stray "\n", or
          // dsh's own verbose reasoning trace) - a bare `out || err` (or
          // even a "prefer non-empty out" rule) can pick that over the
          // real structured error sitting in `err`, discarding the actual
          // RATE_LIMIT/etc. message before CAPACITY_RE ever sees it, so
          // rotation silently never triggered. Confirmed against two real
          // ground-truth failures (Groq 413, Mistral 429) that the
          // authoritative error text is reliably in `err`, not `out` -
          // prefer `err` whenever it has real content, `out` only as a
          // last-resort fallback if `err` is genuinely empty too.
          const body = err.trim() !== "" ? err : out;
          reject(new Error(`dsh exited ${code}: ${body.slice(-1500)}`));
        }
      });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  } finally {
    await unlink(patchFile).catch(() => {});
  }
}

/**
 * The task text becomes one dsh turn against WORKDIR - real capacity-shaped
 * failures rotate to the next real provider (Groq -> NVIDIA -> Mistral),
 * same real mechanism verified tonight in worker/rotation.js.
 */
async function doWork(text, task) {
  const tried = new Set();
  let provider = PROVIDER_ORDER[0];
  let lastErr = null;
  let attemptLog = "";
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
      attemptLog += `--- attempt on ${provider} ---\n${msg}\n\n`;
      // TIMECEIL-CLOUD, 2026-09-14 (built directly by Claude Code,
      // founder's own real-time call - ports the real fix already landed
      // in the local queue's queue.sh for TIMECEIL, not a new design).
      // A timeout that shows genuine, distinct progress (not real
      // repetition) is a task too large for one 8-minute window, not a
      // model problem - retrying it on a different provider just repeats
      // the same too-big-for-one-window failure. Real re-decomposition
      // via triageCheck()/triageSplit() instead, same machinery already
      // used before a task is ever first attempted.
      if (err.timeoutVerdict === "progress" && task) {
        const decision = await triageCheck(text).catch(() => ({ split: false }));
        if (decision.split) {
          const subtaskIds = await triageSplit(task, decision).catch(() => null);
          if (subtaskIds && subtaskIds.length > 0) {
            console.log(`[${new Date().toISOString()}] timeout showed real progress, not a loop - re-decomposed into ${subtaskIds.length} subtasks instead of retrying on a different provider`);
            return { decomposed: true, subtaskIds };
          }
        }
        // Judge disagreed there's anything left to split, or the split
        // itself failed - fall through to the ordinary failure path
        // below rather than silently dropping the real progress finding.
      }
      // GHQ2-d, 2026-09-14: a real loop-detected failure (genuine
      // repetition, not just a capacity-shaped one) escalates to the next
      // real provider the same way a capacity failure already does -
      // retrying the identical prompt on the identical provider that just
      // looped cannot help, a different model can.
      if (err.isLoop) {
        const next = nextProvider(provider, tried);
        if (next === null) break;
        console.log(`[${new Date().toISOString()}] loop-detected failure on ${provider} - switching to ${next}`);
        provider = next;
        continue;
      }
      if (!CAPACITY_RE.test(msg)) {
        const diag = await diagnose(text, attemptLog).catch(() => null);
        const base = `код ${err.code ?? "?"}: ${msg.split("\n")[0]}`;
        return {
          success: false,
          message: truncate(diag ? `${base}\n\n${diag.line}` : base),
          permanent: diag ? diag.permanent : false,
        };
      }
      const next = nextProvider(provider, tried);
      if (next === null) break;
      console.log(`[${new Date().toISOString()}] capacity-shaped failure on ${provider} (${msg.split("\n")[0]}) - switching to ${next}`);
      provider = next;
    }
  }
  const msg = String(lastErr?.message || lastErr || "unknown error");
  const diag = await diagnose(text, attemptLog).catch(() => null);
  const base = `код ${lastErr?.code ?? "?"}: ${msg.split("\n")[0]}`;
  return {
    success: false,
    message: truncate(diag ? `${base}\n\n${diag.line}` : base),
    permanent: diag ? diag.permanent : false,
  };
}

async function notifyTelegram(chatId, message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
}

// ============================================================================
// Triage/decomposition (2026-09-12, founder's own repeated instruction -
// provider rotation alone isn't an escalation path for a task that's
// genuinely too big for any single provider's context/TPM ceiling, e.g.
// real Groq 8000 TPM + Mistral 429 + a still-unclear NVIDIA failure all on
// the SAME oversized prompt, task 1, same day).
//
// This project already has a triageCheck()/triageSplit() pair
// (worker/triage-check.js, worker/triage.js) built and tested during
// tonight's GHQ-h-h work, but it targets a different, superseded
// architecture entirely (Cloud Run + Docker, a checked-out `plexus-doc`
// git repo, file-based `.md` task briefs matching the LOCAL queue.sh
// convention). This queue's own `tasks.text` column is plain, self-
// contained natural-language text with no file-path convention at all -
// dropping that code in as-is would create subtask rows whose `text` is
// a nonexistent file path, which dsh would receive as a literal (garbage)
// prompt. Reusing the real, tested CLASSIFICATION prompt/logic below, but
// writing a new, plain-text-only split function matching this queue's
// real shape.
// ============================================================================

const TRIAGE_PROMPT = `Задача ниже написана как ОДНА единица работы для агента, но выглядит большой или упоминает несколько разных файлов/шагов. Оцени честно: это реально одна связная единица, или несколько независимых шагов, каждый из которых можно сделать и проверить отдельно?

Целевой размер каждой подзадачи - то, что один вызов модели может реально выполнить без превышения лимита провайдера по токенам (ориентир - несколько тысяч токенов на весь промпт, не десятки тысяч).

Если ОДНА связная единица (даже большая) - ответь ровно: {"split": false}

Если НЕСКОЛЬКО - ответь JSON строго такой формы, без пояснений вокруг:
{"split": true, "subtasks": [{"title": "короткий заголовок", "text": "самодостаточный текст этой подзадачи - ВСЁ, что нужно агенту знать, включая любые конкретные пути/файлы/язык/метод из исходной задачи, повторённые ДОСЛОВНО как в исходном тексте, не только в первой подзадаче - не пересказывай своими словами и не заменяй методологию"}]}

КАЖДАЯ подзадача выполняется ОТДЕЛЬНЫМ процессом без общей памяти с другими подзадачами - если один шаг узнаёт путь к файлу, следующий шаг про этот же файл должен получить этот путь явно в своём собственном "text", а не полагаться на то, что предыдущий шаг его "запомнил".

ВАЖНО - реальный случай, пойманный 2026-09-12: если шаг Б реально нуждается в КОНКРЕТНОМ ВЫЧИСЛЕННОМ РЕЗУЛЬТАТЕ шага А (не просто в том же файле/контексте, а в конкретном числе/значении, которое шаг А должен сначала реально получить - например "число, которое найдёт предыдущий шаг"), НЕ дели такую задачу - подзадачи выполняются отдельными процессами без связи между собой, шаг Б физически не может получить настоящий результат шага А и либо провалится, либо ВЫДУМАЕТ значение вместо реального - это хуже, чем не делить вообще. В таком случае ответь {"split": false}, даже если задача большая.

ВАЖНО - реальный случай, пойманный 2026-09-13: твоя работа здесь - ТОЛЬКО резать исходную задачу на упорядоченные куски, а НЕ придумывать заново, КАК её делать. Если исходный текст уже называет конкретный язык/файлы/модуль для переиспользования/конвенцию (например "JS, переиспользуя site/engine/*.js", "фичи-окна {20,50,100} как в impulse.py", "разбиение по календарной середине на IS/OOS") - каждая подзадача должна повторить эти детали ДОСЛОВНО, как есть в исходном тексте. НЕЛЬЗЯ: менять язык реализации, придумывать новые имена файлов/модулей, ссылаться на несуществующие файлы (например "notes/...plan.txt"), заменять уже заданный метод на другой. Если исходная методология непонятна или противоречива - это повод ответить {"split": false} и оставить как есть, а не заменить её собственной придуманной версией.

---
`;

function extractTriageJson(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

// Cheap, plain chat-completion call for classification only - no dsh, no
// tool use, no provider rotation needed here (if the classifier call
// itself hits a real capacity failure, fail safe and just run the task
// as one unit rather than risk never processing it at all).
async function triageCheck(text) {
  const provider = PROVIDER_ORDER[0];
  const cfg = PROVIDER_CONFIG[provider];
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return { split: false };
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: TRIAGE_PROMPT + text }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { split: false };
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    const parsed = extractTriageJson(raw);
    if (!parsed) return { split: false };
    if (parsed.split === true && Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
      const valid = parsed.subtasks.filter(
        (st) => st && typeof st.title === "string" && st.title.trim() && typeof st.text === "string" && st.text.trim()
      );
      if (valid.length > 0) return { split: true, subtasks: valid };
    }
    return { split: false };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] triage check failed (${err.message}), proceeding as one unit (fail-safe)`);
    return { split: false };
  }
}

// Inserts each subtask as a real, independent plain-text row - no files,
// no separate repo, matching this queue's actual `tasks.text` shape.
//
// GHQ2-c, 2026-09-14 (built directly by Claude Code, founder's own
// real-time call - the local queue's own automated attempts at this
// exhausted every model without converging). Real gap: subtasks are
// inserted with no ordering marker at all, so a later sibling's own
// dispatch could run before an earlier, still-unaccepted sibling - the
// exact class of bug the LOCAL queue.sh's sibling-order guard already
// exists to prevent. No schema change (parentTask.id/index would need a
// new column on `tasks`, a real migration, not done tonight) - instead
// the order is embedded directly in `text` as a `[SIB i/n parent:P]`
// marker, parsed back out by siblingOrderOk() below before a subtask is
// ever allowed to run.
async function triageSplit(parentTask, decision) {
  const ids = [];
  const total = decision.subtasks.length;
  for (let i = 0; i < total; i++) {
    const st = decision.subtasks[i];
    const sibMarker = `[SIB ${i + 1}/${total} parent:${parentTask.id}]`;
    const res = await client.execute({
      sql: "INSERT INTO tasks (text, status, creator_id, lane) VALUES (?, ?, ?, ?)",
      args: [`${sibMarker} [${st.title}] ${st.text}`, "ожидает", parentTask.creator_id, parentTask.lane || "architect"],
    });
    ids.push(Number(res.lastInsertRowid));
  }
  return ids;
}

// GHQ2-c, 2026-09-14: parses the `[SIB i/n parent:P]` marker triageSplit()
// embeds in a subtask's own text. Returns null for a task that isn't a
// triage-split subtask at all (no marker) - siblingOrderOk() then always
// allows it, unchanged behavior for every non-subtask task.
function parseSiblingMarker(text) {
  const m = String(text || "").match(/^\[SIB (\d+)\/(\d+) parent:(\d+)\]/);
  if (!m) return null;
  return { index: Number(m[1]), total: Number(m[2]), parentId: Number(m[3]) };
}

// GHQ2-c, 2026-09-14: a subtask at index i>1 may only run once the
// sibling at index i-1 (same parentId) has real status 'готова'. Fails
// OPEN (allows the run) on any lookup error or if the earlier sibling
// can't be found at all - a missing/ambiguous guard should never be the
// reason real work never happens, matching the local queue.sh's own
// "advisory, not a hard block on uncertainty" posture.
async function siblingOrderOk(task) {
  const sib = parseSiblingMarker(task.text);
  if (!sib || sib.index <= 1) return true;
  try {
    const res = await client.execute({
      sql: "SELECT status FROM tasks WHERE text LIKE ? LIMIT 1",
      args: [`[SIB ${sib.index - 1}/${sib.total} parent:${sib.parentId}]%`],
    });
    const prev = res.rows[0];
    if (!prev) return true;
    return prev.status === "готова";
  } catch {
    return true;
  }
}

// ============================================================================
// Diagnost (2026-09-13, ported from this project's own local queue.sh /
// queue-diagnose.py - founder's own instruction: a failed task should
// tell you WHY it failed, not just that it did, and the local queue
// already has exactly this real, tested mechanism. NOT reused as-is:
// the local script calls a LOCAL litellm proxy (127.0.0.1:4000) that
// doesn't exist on a GitHub Actions runner - ported the real prompt/
// verdict-list/parsing logic to JS, using the same direct-provider call
// as triageCheck() instead. Deliberately NOT ported: the local script's
// docs/queue-failure-playbook.md pattern-matching (a whole separate,
// project-local learned-patterns file this repo has no equivalent of
// yet) - this always reports "no known pattern", same as a fresh/empty
// playbook locally. Advisory only, same as the original: this only
// classifies and explains, it never changes what actually ran.
// ============================================================================

const DIAGNOSE_VERDICTS = {
  no_address: "бриф просит прочитать/использовать то, адрес чего в нём не назван",
  no_access: "нужный факт существует, но у модели нет доступа (нет ключа, нет CLI, нет прав)",
  impossible_as_written: "бриф просит действие, для которого нет механизма (не построено/не подключено)",
  provider_down: "провайдер действительно не ответил",
  model_looped: "модель действительно ходила по кругу, имея всё необходимое",
  brief_conflicts_rules: "бриф противоречит правилам стека, модель встала между двумя указаниями",
  unclear: "по логу причину назвать нельзя",
};

// GHQ2-b, 2026-09-14 (built directly by Claude Code, founder's own
// real-time call - the local queue's own automated attempts at this
// exhausted every model without converging). These four verdicts are the
// ones only a human can actually fix (missing address/access/mechanism, or
// a real conflict in the brief) - retrying the same brief on a different
// model cannot help any of them, mirroring queue.sh's own queue-blocked.txt
// semantics for exactly this class of verdict.
const PERMANENT_VERDICTS = new Set([
  "no_address",
  "no_access",
  "impossible_as_written",
  "brief_conflicts_rules",
]);

const DIAGNOSE_PROMPT = `Ниже лог провалившейся попытки выполнить задачу и сам бриф задачи (в этой очереди бриф - это просто текст задачи, без отдельного файла).

Ответь СТРОГО в этом формате, четыре строки, ничего больше:

VERDICT: <одна метка из списка>
FACT: <какого КОНКРЕТНОГО факта не хватило, одной строкой; или NONE>
EVIDENCE: <дословная цитата из лога, доказывающая вердикт, одной строкой>

Допустимые метки VERDICT и что каждая значит:
{verdicts}

Правила:
- VERDICT ровно одна метка и ровно из списка. Свои не придумывай.
- FACT - это недостающий факт (путь к файлу, имя модели, команда), а не пересказ задачи. Если ничего не не хватало - NONE.
- EVIDENCE - настоящая строка из лога, не твой пересказ.
- Не предлагай, что делать. Только диагноз.

БРИФ:
---
{brief}
---

ЛОГ ПРОВАЛИВШЕЙСЯ ПОПЫТКИ:
---
{log}
---
`;

function parseDiagnosis(answer) {
  const out = {};
  for (const key of ["VERDICT", "FACT", "EVIDENCE"]) {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(answer || "");
    out[key] = m ? m[1].trim() : "";
  }
  return out;
}

// Same direct-provider call as triageCheck() - a cheap classification
// call, not dsh/tool-use. Fails safe (returns null) on any error, same
// as the original script's exit-2 "не смог отработать" - never treated
// as a real verdict.
async function diagnose(brief, log) {
  const provider = PROVIDER_ORDER[0];
  const cfg = PROVIDER_CONFIG[provider];
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return null;
  const verdictList = Object.entries(DIAGNOSE_VERDICTS)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const prompt = DIAGNOSE_PROMPT
    .replace("{verdicts}", verdictList)
    .replace("{brief}", brief.slice(0, 6000))
    .replace("{log}", log.slice(-8000));
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const answer = (data?.choices?.[0]?.message?.content || "").trim();
    const got = parseDiagnosis(answer);
    if (!(got.VERDICT in DIAGNOSE_VERDICTS)) return null;
    let line = `ДИАГНОЗ: ${got.VERDICT} - ${DIAGNOSE_VERDICTS[got.VERDICT]}`;
    if (got.FACT && got.FACT.toUpperCase() !== "NONE") line += `\n  не хватило: ${got.FACT.slice(0, 300)}`;
    if (got.EVIDENCE) line += `\n  из лога: ${got.EVIDENCE.slice(0, 300)}`;
    line += "\n  (диагност только предполагает; правку в бриф вносит человек)";
    return { line, permanent: PERMANENT_VERDICTS.has(got.VERDICT) };
  } catch {
    return null;
  }
}

run().catch(console.error);
