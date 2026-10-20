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
import { writeFile, readFile, unlink, mkdir, readdir, stat, appendFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CLOUD-MAINT-c-d, 2026-10-09: the sibling-task parser - the [SIB i/n
// parent:P] marker format, parseSiblingMarker/extractParentAndSiblingInfo,
// and the order-guard factory - now lives in this one shared module,
// imported by BOTH scripts/executor.mjs (here) and scripts/dispatcher.mjs.
// Before it, dispatcher.mjs carried a hand-synced second copy of
// parseSiblingMarker/siblingOrderOk, and CLOUD-MAINT-c-c had to apply the
// same fail-closed fix twice, once per copy.
import {
  parseSiblingMarker,
  buildSiblingMarker,
  extractParentAndSiblingInfo,
  makeSiblingOrderOk,
} from "./sibling-parser.mjs";

// Preserve original console and stream write methods for clean internal logging
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleInfo = console.info.bind(console);

let hookInstalled = false;
let inHook = false;

/**
 * Sanitizes arguments passed to console and stream output.
 */
function sanitizeLogArg(arg) {
  if (typeof arg === "string") {
    return redactSecrets(arg);
  }
  if (arg instanceof Error) {
    const err = new Error(redactSecrets(arg.message));
    err.name = arg.name;
    for (const key of Object.keys(arg)) {
      if (key !== "message" && key !== "stack" && key !== "name") {
        try {
          err[key] = typeof arg[key] === "string" ? redactSecrets(arg[key]) : arg[key];
        } catch {}
      }
    }
    if (arg.stack) err.stack = redactSecrets(arg.stack);
    return err;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      const json = JSON.stringify(arg);
      if (json) {
        return JSON.parse(redactSecrets(json));
      }
    } catch {
      return arg;
    }
  }
  return arg;
}

/**
 * Installs logging hooks on console and standard output/error streams
 * to ensure sensitive credentials are never leaked to logs or terminals.
 */
function installSecretRedactionHook() {
  if (hookInstalled) return;
  hookInstalled = true;

  console.log = function (...args) {
    if (inHook) {
      originalConsoleLog(...args);
      return;
    }
    inHook = true;
    try {
      originalConsoleLog(...args.map(sanitizeLogArg));
    } finally {
      inHook = false;
    }
  };

  console.error = function (...args) {
    if (inHook) {
      originalConsoleError(...args);
      return;
    }
    inHook = true;
    try {
      originalConsoleError(...args.map(sanitizeLogArg));
    } finally {
      inHook = false;
    }
  };

  console.warn = function (...args) {
    if (inHook) {
      originalConsoleWarn(...args);
      return;
    }
    inHook = true;
    try {
      originalConsoleWarn(...args.map(sanitizeLogArg));
    } finally {
      inHook = false;
    }
  };

  console.info = function (...args) {
    if (inHook) {
      originalConsoleInfo(...args);
      return;
    }
    inHook = true;
    try {
      originalConsoleInfo(...args.map(sanitizeLogArg));
    } finally {
      inHook = false;
    }
  };

  const hookStream = (stream) => {
    if (!stream || typeof stream.write !== "function") return;
    const origWrite = stream.write.bind(stream);
    stream.write = function (chunk, encoding, callback) {
      if (inHook) {
        return origWrite(chunk, encoding, callback);
      }
      inHook = true;
      try {
        if (typeof chunk === "string") {
          return origWrite(redactSecrets(chunk), encoding, callback);
        } else if (Buffer.isBuffer(chunk)) {
          const enc = typeof encoding === "string" ? encoding : "utf8";
          const str = chunk.toString(enc);
          const redacted = redactSecrets(str);
          if (redacted !== str) {
            const cb = typeof encoding === "function" ? encoding : callback;
            return origWrite(Buffer.from(redacted, enc), cb);
          }
        }
        return origWrite(chunk, encoding, callback);
      } finally {
        inHook = false;
      }
    };
  };

  hookStream(process.stdout);
  hookStream(process.stderr);
}

// Automatically install secret redaction hook on module load
installSecretRedactionHook();

/**
 * Gathers active sensitive credentials from environment variables and loaded configs
 * for dynamic literal value redaction.
 */
function getLiveSecrets() {
  const secrets = [];
  const sensitiveKeyRe = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE)/i;
  const skipValues = new Set([
    "true", "false", "none", "null", "undefined", "memory", "default",
    "localhost", "danger-full-access", "unused", "file::memory:", "standard",
  ]);

  if (typeof process !== "undefined" && process.env) {
    for (const [key, val] of Object.entries(process.env)) {
      if (!val || typeof val !== "string") continue;
      const trimmed = val.trim();
      if (trimmed.length < 8) continue;
      if (skipValues.has(trimmed.toLowerCase())) continue;

      if (
        sensitiveKeyRe.test(key) ||
        key.startsWith("TURSO_") ||
        key.startsWith("TELEGRAM_") ||
        key.startsWith("REPO_") ||
        key.startsWith("DISPATCH_") ||
        key.startsWith("GH_") ||
        key.startsWith("GITHUB_")
      ) {
        secrets.push({ name: key, value: trimmed });
      }
    }
  }

  try {
    if (typeof tursoCreds !== "undefined" && tursoCreds?.authToken) {
      const trimmed = String(tursoCreds.authToken).trim();
      if (trimmed.length >= 8 && !skipValues.has(trimmed.toLowerCase())) {
        secrets.push({ name: "TURSO_AUTH_TOKEN", value: trimmed });
      }
    }
  } catch {}

  secrets.sort((a, b) => b.value.length - a.value.length);
  return secrets;
}

/**
 * Loads Turso database credentials from environment variables or keys.txt.
 * Falls back to in-memory database if no credentials are configured.
 * 2026-10-11: hardcoded absolute path убран — этот файл пушится в
 * публичный репо, и путь владельца в нём не место. Fallback для
 * локального dev работает через HOME.
 */
function loadTursoCredentials() {
  let url = process.env.TURSO_DATABASE_URL;
  let authToken = process.env.TURSO_AUTH_TOKEN;
  if (url && (authToken || url.startsWith("file:"))) {
    return { url, authToken };
  }

  const candidateDirs = [
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    path.resolve(process.env.HOME || "", "my work", "Continue MODELS integration"),
  ];

  for (const dir of candidateDirs) {
    const keyPath = path.join(dir, "keys.txt");
    if (existsSync(keyPath)) {
      try {
        const content = readFileSync(keyPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!url && trimmed.startsWith("TURSO_DATABASE_URL=")) {
            url = trimmed.slice("TURSO_DATABASE_URL=".length).trim();
          }
          if (!authToken && trimmed.startsWith("TURSO_AUTH_TOKEN=")) {
            authToken = trimmed.slice("TURSO_AUTH_TOKEN=".length).trim();
          }
        }
        if (url && authToken) break;
      } catch {}
    }
  }

  return {
    url: url || "file::memory:",
    authToken: authToken || undefined,
  };
}

const tursoCreds = loadTursoCredentials();
const client = createClient({
  url: tursoCreds.url,
  authToken: tursoCreds.authToken,
});

// CLOUD-MAINT-c-d: sibling-order guard from the shared parser module, bound
// to this executor's own client - the same single implementation
// dispatcher.mjs binds to its own. The local copy of
// parseSiblingMarker/siblingOrderOk that used to live further down this file
// is gone. Semantics unchanged (GHQ2-c / CLOUD-MAINT-c-c): a subtask at
// index i>1 waits for sibling i-1 of the same parent to be 'готова'; a
// missing predecessor or a DB error fails closed.
const siblingOrderOk = makeSiblingOrderOk(client);

const WORKDIR = process.env.WORKDIR || (existsSync("plexus-doc") ? "plexus-doc" : ".");
const CHECKPOINT_DIR = process.env.CHECKPOINT_DIR || path.join(WORKDIR, "checkpoints");

/**
 * Detects whether a job is explicitly marked as long compute.
 * Inspects job metadata, flags, type, lane, text prefixes, or inline directives.
 *
 * @param {object} [task] - Task object from database
 * @param {string} [text] - Task text/prompt
 * @returns {boolean}
 */
function isLongComputeJob(task, text) {
  const content = (text || task?.text || '').trim();

  // 1. Text prefixes
  if (
    content.startsWith('LONG_RUN_COMMAND:') ||
    content.startsWith('LONG_COMPUTE:') ||
    content.startsWith('RUN_COMMAND_LONG:') ||
    content.startsWith('RESUME_COMMAND:') ||
    content.startsWith('RESUME:')
  ) {
    return true;
  }

  // 2. RUN_COMMAND prefix with inline tag, e.g. RUN_COMMAND: [long_compute], [longrun], or [resume]
  if (/^RUN_COMMAND:\s*\[(long[_-]?compute|longrun|compute|resume)\]/i.test(content)) {
    return true;
  }

  // 3. Leading bracket tag, e.g. [long_compute], [longrun], or [resume]
  if (/^\[(long[_-]?compute|longrun|resume)\]/i.test(content)) {
    return true;
  }

  // 4. Text flags / directives, e.g. "long_compute: true", "job_type: long_compute", "resume: true"
  if (/(?:^|\n)\s*(?:long[_-]?compute|is_long_compute|resume|is_resume)\s*[:=]\s*(?:true|1|yes)\b/i.test(content)) {
    return true;
  }
  if (/(?:^|\n)\s*(?:job[_-]?type|type|lane)\s*[:=]\s*(?:long[_-]?compute|longrun|compute)\b/i.test(content)) {
    return true;
  }
  // 2026-10-07: job_cap и computation_duration — синонимы. Любой из
  // них переводит задачу в long-compute-путь. Раньше job_cap читался
  // только как потолок в extractJobCap, и задача без явного
  // LONG_COMPUTE: маркера оставалась на 5-минутном таймауте.
  // Поймано тестом test-timeout-and-compute-path.mjs:124.
  // Directives for computation duration or job cap
  if (/(?:^|\n)\s*(?:computation[_-]?duration|compute[_-]?duration|job[_-]?cap(?:[_-]?ms)?)\s*[:=]/i.test(content)) {
    return true;
  }

  // 5. Database columns / metadata on task object
  if (task) {
    // task status partial / checkpoint or resume flag
    if (task.status === 'partial' || task.status === 'checkpoint' || task.is_resume === true || task.resume === true) {
      return true;
    }
    // lane
    if (typeof task.lane === 'string' && /^(longrun|long[_-]?compute|compute)$/i.test(task.lane)) {
      return true;
    }
    // type or job_type
    if (typeof task.type === 'string' && /^(longrun|long[_-]?compute|compute)$/i.test(task.type)) {
      return true;
    }
    if (typeof task.job_type === 'string' && /^(longrun|long[_-]?compute|compute)$/i.test(task.job_type)) {
      return true;
    }
    // boolean / flag properties
    if (task.is_long_compute === true || task.is_long_compute === 1 || task.is_long_compute === 'true') {
      return true;
    }
    if (task.long_compute === true || task.long_compute === 1 || task.long_compute === 'true') {
      return true;
    }
    // 2026-10-07: job_cap — синоним computation_duration (решение владельца,
    // полный комментарий у текстовых директив выше): свойство job_cap /
    // job_cap_ms на объекте задачи тоже переводит её в long-compute-путь,
    // как и meta.job_cap в metadata-ветке ниже (тест :132).
    if (task.computation_duration || task.compute_duration || task.job_cap || task.job_cap_ms) {
      return true;
    }
    // metadata column (JSON or object)
    if (task.metadata) {
      try {
        const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
        if (
          meta.long_compute === true ||
          meta.is_long_compute === true ||
          meta.resume === true ||
          meta.is_resume === true ||
          meta.compute_path === true ||
          meta.computation_duration ||
          meta.compute_duration ||
          meta.job_cap ||
          meta.job_cap_ms ||
          /^(longrun|long[_-]?compute|compute)$/i.test(meta.type || '') ||
          /^(longrun|long[_-]?compute|compute)$/i.test(meta.job_type || '') ||
          /^(longrun|long[_-]?compute|compute)$/i.test(meta.lane || '') ||
          meta.exempt_timeout === true
        ) {
          return true;
        }
      } catch {}
    }
  }

  // 6. Environment variable override
  if (
    process.env.LONG_COMPUTE === 'true' ||
    process.env.JOB_TYPE === 'longrun' ||
    process.env.TASK_LANE === 'longrun' ||
    process.env.RESUME === 'true' ||
    process.env.TASK_RESUME === 'true'
  ) {
    return true;
  }

  return false;
}

/**
 * Detects whether a job is marked for resume or is continuing from a partial state.
 *
 * @param {object} [task] - Task object from database
 * @param {string} [text] - Task text/prompt
 * @returns {boolean}
 */
function isResumeJob(task, text) {
  const content = (text || task?.text || '').trim();

  // 1. Text prefixes for resume
  if (
    content.startsWith('RESUME_COMMAND:') ||
    content.startsWith('RESUME:')
  ) {
    return true;
  }

  // 2. RUN_COMMAND prefix with [resume] tag
  if (/^RUN_COMMAND:\s*\[resume\]/i.test(content)) {
    return true;
  }

  // 3. Leading bracket tag [resume]
  if (/^\[resume\]/i.test(content)) {
    return true;
  }

  // 4. Text flags / directives
  if (/(?:^|\n)\s*(?:resume|is_resume)\s*[:=]\s*(?:true|1|yes)\b/i.test(content)) {
    return true;
  }
  if (/(?:^|\n)\s*resume[_-]?from\s*[:=]/i.test(content)) {
    return true;
  }

  // 5. Task database columns / metadata
  if (task) {
    if (task.status === 'partial' || task.status === 'checkpoint') {
      return true;
    }
    if (task.is_resume === true || task.is_resume === 1 || task.is_resume === 'true') {
      return true;
    }
    if (task.resume === true || task.resume === 1 || task.resume === 'true') {
      return true;
    }
    if (task.resume_from || task.resumeFrom) {
      return true;
    }
    if (task.metadata) {
      try {
        const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
        if (meta.resume === true || meta.is_resume === true || meta.resume_from || meta.resumeFrom) {
          return true;
        }
      } catch {}
    }
  }

  // 6. Environment variable overrides
  if (process.env.RESUME === 'true' || process.env.TASK_RESUME === 'true' || process.env.IS_RESUME === 'true') {
    return true;
  }

  return false;
}

/**
 * Extracts resume_from identifier from task, text directives, metadata, or environment.
 *
 * @param {object} [task]
 * @param {string} [text]
 * @returns {string|null}
 */
function extractResumeFrom(task, text) {
  const content = (text || task?.text || '').trim();
  const m = content.match(/(?:^|\n|\s|\[)(?:resume[_-]?from)[:\s=]+(\d+|[a-zA-Z0-9_-]+)/i);
  if (m) return m[1];

  if (task?.resume_from) return String(task.resume_from);
  if (task?.resumeFrom) return String(task.resumeFrom);

  if (task?.metadata) {
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
      if (meta.resume_from || meta.resumeFrom) return String(meta.resume_from || meta.resumeFrom);
    } catch {}
  }

  if (process.env.RESUME_FROM) return process.env.RESUME_FROM;

  return null;
}

/**
 * Extracts executable shell command if the task is a direct command execution.
 *
 * @param {string} text - Task text
 * @param {object} [task] - Task record from database
 * @returns {string|null} - Command string or null if not a command task
 */
function extractCommand(text, task) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  const directiveLineRe = /^\s*(?:\[(long[_-]?compute|longrun|compute|resume)\]\s*)?(?:job[_-]?cap|computation[_-]?duration|compute[_-]?duration|long[_-]?compute|is_long_compute|resume|is_resume|resume[_-]?from|parent[_-]?id|parent|job[_-]?type|type|lane|timeout)\s*[:=].*$/i;

  const prefixes = [
    'LONG_RUN_COMMAND:',
    'RUN_COMMAND_LONG:',
    'LONG_COMPUTE:',
    'RESUME_COMMAND:',
    'RESUME:',
    'RUN_COMMAND:'
  ];

  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) {
      let cmd = trimmed.slice(prefix.length).trim();
      // Strip optional inline bracket tag like [long_compute], [longrun], or [resume]
      cmd = cmd.replace(/^\[(long[_-]?compute|longrun|compute|resume)\]\s*/i, '');
      cmd = cmd.split('\n').filter(l => !directiveLineRe.test(l)).join('\n').trim();
      return cmd;
    }
  }

  // Handle leading bracket tag e.g. [long_compute] <command> or [resume] <command>
  const bracketMatch = trimmed.match(/^\[(long[_-]?compute|longrun|resume)\]\s+(.+)$/is);
  if (bracketMatch) {
    let cmd = bracketMatch[2].trim();
    for (const prefix of prefixes) {
      if (cmd.startsWith(prefix)) {
        cmd = cmd.slice(prefix.length).trim();
        break;
      }
    }
    cmd = cmd.split('\n').filter(l => !directiveLineRe.test(l)).join('\n').trim();
    return cmd;
  }

  // Handle case where directives precede the prefix (e.g. "job_cap: 30m\nRUN_COMMAND: ./sim")
  const lines = trimmed.split('\n');
  const nonDirectiveLines = lines.filter(l => !directiveLineRe.test(l) && !/^\s*\[(long[_-]?compute|longrun|compute|resume)\]\s*$/i.test(l));
  const cleanedText = nonDirectiveLines.join('\n').trim();

  for (const prefix of prefixes) {
    if (cleanedText.startsWith(prefix)) {
      let cmd = cleanedText.slice(prefix.length).trim();
      cmd = cmd.replace(/^\[(long[_-]?compute|longrun|compute|resume)\]\s*/i, '');
      return cmd;
    }
  }

  const cleanedBracketMatch = cleanedText.match(/^\[(long[_-]?compute|longrun|resume)\]\s+(.+)$/is);
  if (cleanedBracketMatch) {
    let cmd = cleanedBracketMatch[2].trim();
    for (const prefix of prefixes) {
      if (cmd.startsWith(prefix)) {
        cmd = cmd.slice(prefix.length).trim();
        break;
      }
    }
    cmd = cmd.split('\n').filter(l => !directiveLineRe.test(l)).join('\n').trim();
    return cmd;
  }

  // If task is explicitly in compute or longrun lane and text is a shell command
  if (task && typeof task.lane === 'string' && /^(longrun|compute)$/i.test(task.lane)) {
    return cleanedText || trimmed;
  }
  if (task && typeof task.type === 'string' && /^(longrun|compute)$/i.test(task.type)) {
    return cleanedText || trimmed;
  }
  if (task && (task.long_compute === true || task.is_long_compute === true) && cleanedText) {
    return cleanedText;
  }
  if (task && (task.status === 'partial' || task.status === 'checkpoint' || task.is_resume === true || task.resume === true) && cleanedText) {
    return cleanedText;
  }
  if (cleanedText && isLongComputeJob(task, trimmed)) {
    return cleanedText;
  }

  return null;
}

/**
 * Parses duration strings like "30m", "1800s", "1h", "5000ms" or numeric milliseconds.
 * 
 * @param {string|number} val 
 * @returns {number|null} Duration in milliseconds, or null if unparseable
 */
function parseDuration(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val > 0 ? val : null;
  const str = String(val).trim();
  if (!str) return null;
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?|hrs?)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (/^(h|hours?|hrs?)$/.test(unit)) return Math.round(num * 3600 * 1000);
  if (/^(m|min|minutes?)$/.test(unit)) return Math.round(num * 60 * 1000);
  if (/^(s|sec|seconds?)$/.test(unit)) return Math.round(num * 1000);
  if (/^(ms|milliseconds?)$/.test(unit)) return Math.round(num);
  // If no unit provided, assume seconds if small (< 3600), otherwise ms
  return num < 3600 ? Math.round(num * 1000) : Math.round(num);
}

/**
 * Extracts agreed job cap or computation duration from task and text.
 * When both job cap and computation duration are present, agrees on the effective
 * cap duration (bounding computation duration by the agreed job cap ceiling).
 * 
 * @param {object} [task] 
 * @param {string} [text] 
 * @returns {number|null} Duration in milliseconds
 */
function extractJobCap(task, text) {
  const content = (text || task?.text || '').trim();

  let jobCap = null;
  let compDuration = null;

  // 1. Text directives: "job_cap: 30m", "computation_duration: 1800s", etc.
  const capMatch = content.match(/(?:^|\n)\s*(?:job[_-]?cap|job[_-]?cap[_-]?ms)\s*[:=]\s*([0-9]+(?:\.[0-9]+)?\s*[a-zA-Z]*)/i);
  if (capMatch) {
    jobCap = parseDuration(capMatch[1]);
  }

  const compMatch = content.match(/(?:^|\n)\s*(?:computation[_-]?duration|compute[_-]?duration)\s*[:=]\s*([0-9]+(?:\.[0-9]+)?\s*[a-zA-Z]*)/i);
  if (compMatch) {
    compDuration = parseDuration(compMatch[1]);
  }

  const timeoutMatch = content.match(/(?:^|\n)\s*timeout\s*[:=]\s*([0-9]+(?:\.[0-9]+)?\s*[a-zA-Z]*)/i);
  if (timeoutMatch && !jobCap) {
    jobCap = parseDuration(timeoutMatch[1]);
  }

  // 2. Task properties
  if (task) {
    if (!jobCap) {
      if (task.job_cap_ms) jobCap = parseDuration(task.job_cap_ms);
      else if (task.job_cap) jobCap = parseDuration(task.job_cap);
    }
    if (!compDuration) {
      if (task.computation_duration) compDuration = parseDuration(task.computation_duration);
      else if (task.compute_duration) compDuration = parseDuration(task.compute_duration);
    }
    if (task.metadata) {
      try {
        const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
        if (!jobCap) {
          const metaCap = meta.job_cap_ms || meta.job_cap || meta.timeout_ms;
          if (metaCap) jobCap = parseDuration(metaCap);
        }
        if (!compDuration) {
          const metaComp = meta.computation_duration || meta.compute_duration;
          if (metaComp) compDuration = parseDuration(metaComp);
        }
      } catch {}
    }
  }

  // 3. Environment variables
  if (!jobCap && process.env.JOB_CAP_MS) jobCap = parseDuration(process.env.JOB_CAP_MS);
  if (!jobCap && process.env.LONG_COMPUTE_TIMEOUT_MS) jobCap = parseDuration(process.env.LONG_COMPUTE_TIMEOUT_MS);

  // Agree computation duration with job cap (cap acts as ceiling)
  if (jobCap && compDuration) {
    return Math.min(jobCap, compDuration);
  }
  return jobCap || compDuration || null;
}

/**
 * Determines effective timeout in milliseconds based on job type and options.
 * - Standard jobs: 5-minute timeout (300,000 ms) unless overridden by options.timeoutMs
 * - Long compute jobs: exempt from 5-minute limit. Uses explicit jobCapMs/timeoutMs or env vars if provided, otherwise 0 (unlimited/runner-bound).
 * 
 * @param {object|boolean|number} [options]
 * @returns {number} Effective timeout in ms (0 = no timeout)
 */
function getEffectiveTimeout(options = {}) {
  let isLongCompute = false;
  let timeoutMs = null;
  let jobCapMs = null;

  if (typeof options === 'boolean') {
    isLongCompute = options;
  } else if (typeof options === 'number') {
    timeoutMs = options;
  } else if (options && typeof options === 'object') {
    if (options.isLongCompute !== undefined) isLongCompute = Boolean(options.isLongCompute);
    if (options.timeoutMs !== undefined) timeoutMs = options.timeoutMs;
    if (options.jobCapMs !== undefined) jobCapMs = options.jobCapMs;
    if (options.jobCap !== undefined) jobCapMs = options.jobCap;
  }

  if (isLongCompute) {
    if (timeoutMs && timeoutMs > 0) {
      return timeoutMs;
    } else if (jobCapMs && jobCapMs > 0) {
      return jobCapMs;
    } else if (process.env.LONG_COMPUTE_TIMEOUT_MS) {
      return Number(process.env.LONG_COMPUTE_TIMEOUT_MS);
    } else if (process.env.JOB_CAP_MS) {
      return Number(process.env.JOB_CAP_MS);
    } else {
      return 0; // Completely exempt from 5-minute timeout limit
    }
  } else {
    return (timeoutMs && timeoutMs > 0) ? timeoutMs : 5 * 60 * 1000;
  }
}

/**
 * Executes a shell command directly in WORKDIR without LLM/dsh.
 * Used for tasks that need actual code execution (scripts, tests, builds).
 * Jobs explicitly marked as long compute are exempt from the 5-minute timeout limit.
 * 
 * @param {string} command - The shell command to execute
 * @param {object|boolean|number} [options] - Options object, boolean isLongCompute, or number timeoutMs
 * @param {boolean} [options.isLongCompute=false] - Whether job is marked as long compute (exempts from 5-min limit)
 * @param {number} [options.timeoutMs] - Explicit timeout in ms. If omitted and isLongCompute=true, no timeout is applied
 * @param {number} [options.jobCapMs] - Upper job cap in ms (defaults to env.JOB_CAP_MS or env.LONG_COMPUTE_TIMEOUT_MS)
 * @returns {Promise<{success: boolean, stdout: string, stderr: string, exitCode: number}>}
 */
async function runCommand(command, options = {}) {
  const effectiveTimeout = getEffectiveTimeout(options);

  return await new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: options.cwd || WORKDIR,
      env: { ...process.env, ...(options.env || {}) },
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (stderr.length < 10000) stderr += d; });
    
    // Timeout enforcement: only armed if effectiveTimeout > 0.
    // Long compute jobs are exempt from the standard 5-minute limit.
    let timer = null;
    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        const timeoutMinutes = Math.round(effectiveTimeout / 60000);
        resolve({
          success: false,
          stdout,
          stderr: stderr + `\n[TIMEOUT] Command killed after ${timeoutMinutes > 0 ? timeoutMinutes + ' minutes' : effectiveTimeout + 'ms'}`,
          exitCode: -1
        });
      }, effectiveTimeout);
    }
    
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code
      });
    });
    
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: -1
      });
    });
  });
}

/**
 * Saves stderr and partial results as partial artifacts (not complete results).
 * Writes structured JSON metadata, raw stderr log, and partial stdout into CHECKPOINT_DIR.
 *
 * @param {string|number} taskId - Task ID
 * @param {object} data - Partial execution details { stdout, stderr, exitCode, jobCapMs, command, metadata }
 * @param {object} [options] - Additional options
 * @returns {Promise<{isPartial: boolean, status: string, jsonPath: string, stderrPath: string, stdoutPath: string|null, checkpointFiles: string[]}>}
 */
async function savePartialArtifact(taskId, data = {}, options = {}) {
  const dir = options.checkpointDir || CHECKPOINT_DIR;
  await mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const safeTaskId = String(taskId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

  const jsonFileName = `task-${safeTaskId}-partial.json`;
  const stderrFileName = `task-${safeTaskId}-stderr.log`;
  const stdoutFileName = `task-${safeTaskId}-partial-stdout.log`;

  const jsonPath = path.join(dir, jsonFileName);
  const stderrPath = path.join(dir, stderrFileName);
  const stdoutPath = data.stdout ? path.join(dir, stdoutFileName) : null;

  // CLOUD-MAINT-c-e, 2026-10-09: partial artifacts are written to disk AND
  // then committed+pushed to origin by uploadTaskCheckpointsAndArtifacts
  // below - that made them the one remaining channel where a real credential
  // in raw command/model output (an env dump, a provider error body) could
  // travel from a child process's stderr straight into a public-ish git
  // repo, bypassing redactSecrets entirely. Redact at write time, same
  // shapes as everywhere else. Non-secret content (error text, progress
  // markers like "[TIMEOUT]") passes through untouched - the contract
  // suite's partial-artifact assertions all check non-secret substrings
  // and stay green.
  // 1. Write stderr log, redacted before it ever touches disk
  const stderrContent = redactSecrets(String(data.stderr || '(no stderr captured)'));
  await writeFile(stderrPath, stderrContent, 'utf-8');

  // 2. Write partial stdout log if present (same redaction)
  const stdoutContent = redactSecrets(String(data.stdout || ''));
  if (stdoutPath && data.stdout) {
    await writeFile(stdoutPath, stdoutContent, 'utf-8');
  }

  // 3. Scan existing checkpoint files in dir
  let checkpointFiles = [];
  try {
    const entries = await readdir(dir);
    checkpointFiles = entries.filter(f => f.startsWith(`task-${safeTaskId}`) || f.endsWith('.ckpt') || f.endsWith('.pt') || f.includes('checkpoint'));
  } catch {}

  // 4. Write structured partial artifact JSON metadata
  const artifactPayload = {
    task_id: taskId,
    status: 'partial',
    is_partial: true,
    is_complete: false,
    timestamp,
    exit_code: data.exitCode ?? -1,
    job_cap_ms: data.jobCapMs ?? null,
    command: data.command ? redactSecrets(String(data.command)) : null,
    stderr: stderrContent.slice(0, 10000),
    stderr_file: stderrFileName,
    stdout_preview: stdoutContent.slice(0, 10000),
    stdout_file: stdoutFileName,
    checkpoint_files: checkpointFiles,
    metadata: data.metadata || {}
  };

  await writeFile(jsonPath, JSON.stringify(artifactPayload, null, 2), 'utf-8');
  console.log(`[${new Date().toISOString()}] CHECKPOINT: saved partial artifact to ${jsonPath} and stderr to ${stderrPath}`);

  return {
    isPartial: true,
    status: 'partial',
    jsonPath,
    stderrPath,
    stdoutPath,
    checkpointFiles
  };
}

/**
 * Uploads/pushes checkpoints and artifacts to origin git repository or artifact storage.
 * Handles both complete artifacts and partial checkpoint artifacts.
 *
 * @param {string|number} taskId - Task ID
 * @param {object} [options]
 * @param {boolean} [options.isPartial=false] - Whether these are partial artifacts
 * @param {string} [options.workdir] - Target working directory (defaults to WORKDIR)
 * @returns {Promise<boolean>}
 */
async function uploadTaskCheckpointsAndArtifacts(taskId, options = {}) {
  const isPartial = Boolean(options.isPartial);
  const targetDir = options.workdir || WORKDIR;
  const dir = options.checkpointDir || CHECKPOINT_DIR;

  try {
    // If checkpoint directory exists and is outside targetDir, copy checkpoint files to targetDir/checkpoints
    if (existsSync(dir)) {
      const rel = path.relative(targetDir, dir);
      const isInsideTarget = !rel.startsWith('..') && !path.isAbsolute(rel);
      if (!isInsideTarget) {
        const destDir = path.join(targetDir, "checkpoints");
        await mkdir(destDir, { recursive: true });
        const cpFiles = await readdir(dir);
        for (const f of cpFiles) {
          const srcFile = path.join(dir, f);
          const destFile = path.join(destDir, f);
          try {
            const content = await readFile(srcFile);
            await writeFile(destFile, content);
          } catch {}
        }
      }
    }

    const status = execSync("git status --porcelain", { cwd: targetDir, stdio: "pipe" }).toString().trim();
    if (!status) {
      console.log(`[${new Date().toISOString()}] ARTIFACT_UPLOAD: no changes in ${targetDir}, skipping push`);
      return true;
    }

    execSync("git config user.name 'queue-engine[bot]'", { cwd: targetDir, stdio: "pipe" });
    execSync("git config user.email 'queue-engine@users.noreply.github.com'", { cwd: targetDir, stdio: "pipe" });
    execSync("git add -A", { cwd: targetDir, stdio: "pipe" });

    const modeLabel = isPartial ? "partial checkpoint/artifact" : "completed artifacts";
    const commitMsg = `task ${taskId} (${modeLabel}): ${status.split('\n')[0].slice(0, 50)}`;
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\"')}"`, { cwd: targetDir, stdio: "pipe" });

    const branch = execSync("git branch --show-current", { cwd: targetDir, stdio: "pipe" }).toString().trim();
    if (branch) {
      execSync(`git push origin ${branch}`, { cwd: targetDir, stdio: "pipe" });
      console.log(`[${new Date().toISOString()}] ARTIFACT_UPLOAD: committed and pushed ${status.split('\n').length} file(s) (${modeLabel}) to origin/${branch}`);
    } else {
      console.log(`[${new Date().toISOString()}] ARTIFACT_UPLOAD: detached HEAD or no branch, committed locally only`);
    }
    return true;
  } catch (err) {
    // CLOUD-MAINT-c-e: git push failures echo the remote URL, and in CI that
    // URL is routinely built from REPO_TOKEN - redact before printing.
    console.log(`[${new Date().toISOString()}] ARTIFACT_UPLOAD: FAILED - ${redactSecrets(err.message)}`);
    return false;
  }
}

/**
 * Locates the latest checkpoint or partial artifact file for a task to support resume.
 *
 * @param {string|number} taskId - Task ID
 * @param {object} [options]
 * @param {string} [options.checkpointDir] - Directory containing checkpoints
 * @param {number|string} [options.resumeFrom] - Alternative task ID to resume from
 * @returns {Promise<{path: string, filename: string, isPartial: boolean, data: object|null, mtime: Date}|null>}
 */
async function findLatestCheckpoint(taskId, options = {}) {
  const dir = options.checkpointDir || CHECKPOINT_DIR;
  if (!existsSync(dir)) return null;

  const targetId = options.resumeFrom || taskId;
  const safeId = targetId ? String(targetId).replace(/[^a-zA-Z0-9_-]/g, '_') : null;

  try {
    const files = await readdir(dir);
    if (!files || files.length === 0) return null;

    const candidates = [];
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let isTarget = !safeId;
      if (safeId) {
        const targetPattern = new RegExp(`(^|[^0-9a-zA-Z])${safeId}([^0-9a-zA-Z]|$)`, 'i');
        isTarget = file.includes(`task-${safeId}`) || file.includes(`task_${safeId}`) || targetPattern.test(file);
      }
      const isLog = file.endsWith('.log') || file.endsWith('.txt');
      const isCheckpoint = (
        file.endsWith('.json') ||
        file.endsWith('.ckpt') ||
        file.endsWith('.pt') ||
        file.endsWith('.h5') ||
        file.endsWith('.bin') ||
        file.endsWith('.parquet') ||
        file.includes('checkpoint') ||
        file.includes('partial')
      ) && !isLog;

      if (isCheckpoint && isTarget) {
        try {
          const st = await stat(fullPath);
          if (st.isFile()) {
            candidates.push({ file, path: fullPath, mtime: st.mtime });
          }
        } catch {}
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const latest = candidates[0];

    let data = null;
    let isPartial = !latest.file.includes('complete');

    if (latest.file.endsWith('.json')) {
      try {
        const raw = await readFile(latest.path, 'utf-8');
        data = JSON.parse(raw);
        if (data.is_partial !== undefined) {
          isPartial = Boolean(data.is_partial);
        } else if (data.is_complete !== undefined) {
          isPartial = !Boolean(data.is_complete);
        } else if (data.status) {
          isPartial = data.status === 'partial';
        }
      } catch {}
    }

    return {
      path: latest.path,
      filename: latest.file,
      mtime: latest.mtime,
      isPartial,
      data
    };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] CHECKPOINT: error finding checkpoint in ${dir}: ${redactSecrets(err.message)}`);
    return null;
  }
}

/**
 * Executes a long compute job resuming from a previous checkpoint or partial artifact.
 *
 * @param {string} command - Shell command to resume
 * @param {object} [task] - Task object from database
 * @param {string} [text] - Task text/prompt
 * @param {object} [options] - Additional options
 * @returns {Promise<{success: boolean, message: string, exitCode: number, stdout: string, stderr: string, isResume: boolean, checkpoint: object|null}>}
 */
async function executeResume(command, task = null, text = '', options = {}) {
  const taskId = task?.id || process.env.TASK_ID || 'compute';
  const checkpointDir = options.checkpointDir || CHECKPOINT_DIR;
  console.log(`[${new Date().toISOString()}] RESUME: initiating resume execution for task ${taskId}`);

  const resumeTarget = task?.resume_from || options.resumeFrom || extractResumeFrom(task, text);
  const checkpoint = await findLatestCheckpoint(taskId, {
    checkpointDir: checkpointDir,
    resumeFrom: resumeTarget
  });

  const envOverrides = {
    IS_RESUME: "true",
    RESUME_TASK_ID: String(taskId),
  };

  if (checkpoint) {
    console.log(`[${new Date().toISOString()}] RESUME: found checkpoint at ${checkpoint.path} (mtime ${checkpoint.mtime.toISOString()}, partial=${checkpoint.isPartial})`);
    process.env.RESUME_CHECKPOINT = checkpoint.path;
    process.env.CHECKPOINT_PATH = checkpoint.path;
    process.env.IS_RESUME = "true";
    envOverrides.RESUME_CHECKPOINT = checkpoint.path;
    envOverrides.CHECKPOINT_PATH = checkpoint.path;
    if (checkpoint.data && typeof checkpoint.data === 'object') {
      envOverrides.RESUME_METADATA = JSON.stringify(checkpoint.data);
    }
  } else {
    console.log(`[${new Date().toISOString()}] RESUME: no previous checkpoint file found in ${checkpointDir}, starting from initial state`);
    process.env.IS_RESUME = "true";
  }

  const computeResult = await executeLongCompute(command, task, text, {
    ...options,
    checkpointDir: checkpointDir,
    isResume: true,
    checkpoint: checkpoint,
    env: { ...envOverrides, ...(options.env || {}) }
  });

  return {
    ...computeResult,
    isResume: true,
    checkpoint: checkpoint
  };
}

/**
 * Checks and ensures correct tree completion when jobs are completed or resumed.
 * When all siblings of a parent task reach 'готова', updates the parent task status to 'готова'
 * and records completion metadata.
 *
 * @param {string|number} taskId - Current task ID
 * @param {object} [task] - Current task object
 * @param {object} [db=client] - Database client
 * @returns {Promise<{treeComplete: boolean, parentId?: number|string, totalSiblings?: number, completedSiblings?: number, reason?: string, error?: string}>}
 */
async function checkTreeCompletion(taskId, task = null, db = client) {
  if (!db) return { treeComplete: false, reason: "no_db" };
  if (!task && taskId) {
    try {
      const res = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [taskId] });
      task = res?.rows?.[0] || null;
    } catch {}
  }
  const content = task?.text || "";
  const info = extractParentAndSiblingInfo(task, content);

  if (!info || !info.parentId) {
    try {
      const childrenRes = await db.execute({
        sql: `SELECT id, status, text, result FROM tasks WHERE text LIKE ? OR text LIKE ? /* parent:${taskId} */`,
        args: [`%parent:${taskId}]%`, `%parent:${taskId}%`]
      });
      const children = childrenRes.rows || [];
      if (children.length > 0) {
        const allDone = children.every(r => r.status === 'готова');
        const anyPartial = children.some(r => r.status === 'partial');
        const anyFailed = children.some(r => r.status === 'провал' || r.status === 'заблокирована');
        if (allDone) {
          const completionNote = `ДЕРЕВО ЗАДАЧ ЗАВЕРШЕНО: все ${children.length} подзадач выполнены успешно (подзадачи: ${children.map(c => c.id).join(', ')})`;
          await db.execute({
            sql: "UPDATE tasks SET status = 'готова', result = ? WHERE id = ?",
            args: [completionNote, taskId]
          });
          console.log(`[${new Date().toISOString()}] TREE_COMPLETION: parent task ${taskId} marked 'готова' (all ${children.length} subtasks done)`);
          return {
            treeComplete: true,
            parentId: taskId,
            totalSiblings: children.length,
            completedSiblings: children.length
          };
        }
        return {
          treeComplete: false,
          parentId: taskId,
          totalSiblings: children.length,
          completedSiblings: children.filter(c => c.status === 'готова').length,
          anyPartial,
          anyFailed
        };
      }
    } catch (err) {
      console.log(`[${new Date().toISOString()}] TREE_COMPLETION: parent check error: ${redactSecrets(err.message)}`);
    }
    return { treeComplete: false, reason: "not_in_tree" };
  }

  const parentId = info.parentId;
  const expectedTotal = info.total;

  try {
    const sibRes = await db.execute({
      sql: `SELECT id, status, text, result FROM tasks WHERE text LIKE ? OR text LIKE ? /* parent:${parentId} */`,
      args: [`%parent:${parentId}]%`, `%parent:${parentId}%`]
    });

    const siblings = sibRes.rows || [];
    if (siblings.length === 0) {
      return { treeComplete: false, parentId, reason: "no_siblings_found" };
    }

    const totalCount = expectedTotal || siblings.length;
    const completedSiblings = siblings.filter(s => s.status === 'готова');
    const partialSiblings = siblings.filter(s => s.status === 'partial');
    const failedSiblings = siblings.filter(s => s.status === 'провал' || s.status === 'заблокирована');
    const pendingSiblings = siblings.filter(s => s.status === 'ожидает' || s.status === 'выполняется');

    const isAllCompleted = siblings.length >= totalCount && completedSiblings.length === siblings.length;

    if (isAllCompleted) {
      console.log(`[${new Date().toISOString()}] TREE_COMPLETION: all ${siblings.length} siblings for parent ${parentId} are 'готова'. Marking parent complete.`);
      const parentNote = `ДЕРЕВО ЗАДАЧ ЗАВЕРШЕНО: все ${siblings.length} подзадач выполнены успешно (подзадачи: ${siblings.map(s => s.id).join(', ')})`;

      await db.execute({
        sql: "UPDATE tasks SET status = 'готова', result = ? WHERE id = ?",
        args: [parentNote, parentId]
      });

      return {
        treeComplete: true,
        parentId,
        totalSiblings: siblings.length,
        completedSiblings: completedSiblings.length,
        siblings: siblings.map(s => ({ id: s.id, status: s.status }))
      };
    } else {
      console.log(`[${new Date().toISOString()}] TREE_COMPLETION: tree for parent ${parentId} not yet complete (${completedSiblings.length}/${siblings.length} completed, ${partialSiblings.length} partial, ${pendingSiblings.length} pending)`);
      return {
        treeComplete: false,
        parentId,
        totalSiblings: siblings.length,
        completedSiblings: completedSiblings.length,
        partialCount: partialSiblings.length,
        pendingCount: pendingSiblings.length,
        failedCount: failedSiblings.length
      };
    }
  } catch (err) {
    console.log(`[${new Date().toISOString()}] TREE_COMPLETION: error: ${redactSecrets(err.message)}`);
    return { treeComplete: false, parentId, error: redactSecrets(err.message) };
  }
}

/**
 * Separate compute path for executing long compute jobs with extended duration per agreed job cap.
 * Exempt from the 5-minute timeout limit of standard jobs.
 * Saves stderr and partial results as partial artifacts (not complete results) on failure/timeout.
 * 
 * @param {string} command - Shell command to execute
 * @param {object} [task] - Task object from database
 * @param {string} [text] - Task text
 * @param {object} [options] - Additional execution options
 * @returns {Promise<{success: boolean, message: string, exitCode: number, stdout: string, stderr: string, isLongCompute: boolean, jobCapMs: number|null, partial?: boolean, partialArtifacts?: object}>}
 */
/**
 * Atomically claims a task by updating its status to 'выполняется'
 * ONLY if its current status in the database matches expectedStatus.
 * Compare-and-swap semantics prevent race conditions between concurrent workers.
 *
 * @param {number|string} taskId - Target task ID
 * @param {string} expectedStatus - Expected current status (e.g. 'ожидает' or 'partial')
 * @param {string} [runId] - GitHub Actions run ID or runner ID
 * @param {object} [db] - Database client
 * @returns {Promise<boolean>} true if claimed successfully (1 row affected), false otherwise
 */
async function claimTask(taskId, expectedStatus, runId = process.env.GITHUB_RUN_ID, db = client) {
  const claimRes = await db.execute({
    sql: "UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ? AND status = ?",
    args: ["выполняется", runId || null, taskId, expectedStatus]
  });
  return Boolean(claimRes.rowsAffected && claimRes.rowsAffected > 0);
}

async function executeLongCompute(command, task = null, text = '', options = {}) {
  const taskId = task?.id || process.env.TASK_ID || 'compute';
  const jobCapMs = options.jobCapMs || options.jobCap || extractJobCap(task, text) || null;
  const isResume = Boolean(options.isResume || isResumeJob(task, text));
  const checkpointDir = options.checkpointDir || CHECKPOINT_DIR;
  let checkpoint = options.checkpoint || null;

  if (isResume && !checkpoint) {
    const resumeTarget = task?.resume_from || options.resumeFrom || extractResumeFrom(task, text);
    checkpoint = await findLatestCheckpoint(taskId, {
      checkpointDir: checkpointDir,
      resumeFrom: resumeTarget
    });
    if (checkpoint) {
      console.log(`[${new Date().toISOString()}] COMPUTE_PATH: resuming from checkpoint ${checkpoint.path}`);
      process.env.RESUME_CHECKPOINT = checkpoint.path;
      process.env.CHECKPOINT_PATH = checkpoint.path;
      process.env.IS_RESUME = "true";
    }
  }

  console.log(`[${new Date().toISOString()}] COMPUTE_PATH: executing long compute job${isResume ? ' (resumed)' : ''} (jobCapMs=${jobCapMs ? jobCapMs + 'ms' : 'unlimited/runner-bound'})`);
  
  try {
    await mkdir(checkpointDir, { recursive: true });
  } catch {}

  const env = {
    ...(options.env || {})
  };
  if (isResume) {
    env.IS_RESUME = "true";
    if (checkpoint?.path) {
      env.RESUME_CHECKPOINT = checkpoint.path;
      env.CHECKPOINT_PATH = checkpoint.path;
    }
  }

  const cmdResult = await runCommand(command, {
    isLongCompute: true,
    jobCapMs: jobCapMs,
    timeoutMs: options.timeoutMs,
    cwd: options.cwd || WORKDIR,
    env: env
  });

  if (cmdResult.success) {
    let compArtifact = null;
    try {
      // CLOUD-MAINT-c-e: same write-time redaction as savePartialArtifact -
      // the "complete" artifact is also committed+pushed to origin by
      // uploadTaskCheckpointsAndArtifacts, so raw output must not reach the
      // file. The in-memory return value keeps the raw cmdResult (run()'s
      // own result.message redaction at the DB/Telegram boundary still
      // applies on top).
      compArtifact = {
        task_id: taskId,
        status: 'complete',
        is_partial: false,
        is_complete: true,
        exit_code: 0,
        stdout: redactSecrets(cmdResult.stdout),
        stderr: redactSecrets(cmdResult.stderr),
        timestamp: new Date().toISOString(),
        job_cap_ms: jobCapMs,
        is_resume: isResume,
        resumed_from_checkpoint: checkpoint ? checkpoint.path : null
      };
      await writeFile(
        path.join(checkpointDir, `task-${taskId}-complete.json`),
        JSON.stringify(compArtifact, null, 2),
        'utf-8'
      );
    } catch {}

    const uploaded = await uploadTaskCheckpointsAndArtifacts(taskId, {
      isPartial: false,
      checkpointDir: checkpointDir,
      workdir: options.cwd || options.workdir || WORKDIR
    });

    return {
      success: true,
      message: cmdResult.stdout || 'Command executed successfully',
      exitCode: cmdResult.exitCode,
      stdout: cmdResult.stdout,
      stderr: cmdResult.stderr,
      isLongCompute: true,
      isResume,
      checkpoint,
      artifactUploaded: uploaded,
      jobCapMs: jobCapMs
    };
  }

  // Save stderr and partial results as partial artifacts, not as complete results
  console.log(`[${new Date().toISOString()}] COMPUTE_PATH: job did not complete cleanly (exitCode ${cmdResult.exitCode}). Saving stderr and partial results as partial artifacts.`);

  const partialArtifactInfo = await savePartialArtifact(taskId, {
    stdout: cmdResult.stdout,
    stderr: cmdResult.stderr,
    exitCode: cmdResult.exitCode,
    jobCapMs,
    command,
    metadata: {
      is_resume: isResume,
      resumed_from_checkpoint: checkpoint ? checkpoint.path : null
    }
  }, { checkpointDir: checkpointDir });

  const partialUploaded = await uploadTaskCheckpointsAndArtifacts(taskId, {
    isPartial: true,
    checkpointDir: checkpointDir,
    workdir: options.cwd || options.workdir || WORKDIR
  });

  let failureMsg = cmdResult.stderr;
  if (cmdResult.stdout) {
    failureMsg = failureMsg ? `${failureMsg}\n[STDOUT]: ${cmdResult.stdout}` : cmdResult.stdout;
  }

  return {
    success: false,
    partial: true,
    status: 'partial',
    message: `ЧАСТИЧНЫЙ РЕЗУЛЬТАТ (exit ${cmdResult.exitCode}): сохранены частичные артефакты и stderr в ${checkpointDir}.\n${failureMsg || 'Partial execution'}`,
    exitCode: cmdResult.exitCode,
    stdout: cmdResult.stdout,
    stderr: cmdResult.stderr,
    isLongCompute: true,
    isResume,
    checkpoint,
    artifactUploaded: partialUploaded,
    jobCapMs: jobCapMs,
    partialArtifacts: partialArtifactInfo
  };
}

async function run() {
  const taskId = process.env.TASK_ID;
  const startTime = Date.now();

  // Fetch task (supports pending and partial tasks for resume)
  const taskRes = await client.execute({ sql: "SELECT * FROM tasks WHERE id = ? AND status IN ('ожидает', 'partial')", args: [taskId] });
  const task = taskRes.rows[0];
  if (!task) { console.log('No pending or partial task found'); return; }

  // GHQ2-c, 2026-09-14: a triage-split subtask does not run before its
  // earlier, still-unaccepted sibling - leaves status untouched ('ожидает')
  // so a future dispatch for this same taskId gets a fresh chance once the
  // real blocker clears, rather than being marked done or failed for
  // simply arriving out of order.
  if (!(await siblingOrderOk(task))) {
    console.log(`[${new Date().toISOString()}] sibling-order: task ${taskId} is waiting on an earlier unaccepted sibling, not running yet`);
    return;
  }

  // Mark as running via atomic UPDATE guarded by expected status (task.status).
  // Compare-and-swap prevents racing runners from claiming or executing the same task.
  const expectedStatus = task.status;
  const claimed = await claimTask(taskId, expectedStatus, process.env.GITHUB_RUN_ID, client);
  if (!claimed) {
    console.log(`[${new Date().toISOString()}] Task ${taskId}: atomic claim failed (expected status "${expectedStatus}" no longer matches or task claimed by another executor), skipping`);
    return;
  }

  // Triage: is this genuinely one unit of work, or several that should
  // run as independent, smaller dsh calls? (founder's own repeated
  // instruction, 2026-09-12 - see the triageCheck/triageSplit block
  // below for why this isn't just the local project's existing
  // worker/triage.js reused as-is.) Fail-safe: any error here just
  // proceeds to doWork() as one unit, same as before this existed.
  // Shell command tasks and long compute jobs bypass triage to avoid misclassification or splitting.
  const isCommandOrLongCompute = extractCommand(task.text, task) !== null || isLongComputeJob(task, task.text);
  // 2026-10-07: [NO-TRIAGE] marker (hasNoTriageMarker below) - a
  // self-declared leaf-level task skips claim-time decomposition entirely.
  const noTriage = hasNoTriageMarker(task.text);
  if (!isCommandOrLongCompute && !noTriage) {
    const triageDecision = await triageCheck(task.text, CLAIM_TIME_PAYLOAD_FACT);
    if (triageDecision.split) {
      const subtaskIds = await triageSplit(task, triageDecision).catch((err) => {
        console.log(`[${new Date().toISOString()}] triage split failed (${redactSecrets(err.message)}), proceeding as one unit instead`);
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
  } else if (noTriage) {
    console.log(`[${new Date().toISOString()}] no-triage marker present, skipping decomposition`);
  } else {
    console.log(`[${new Date().toISOString()}] triage: bypassed for ${isLongComputeJob(task, task.text) ? 'long compute' : 'shell command'} job`);
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
    // 2026-10-04: the note names the real reason - the exhausted-provider
    // path splits because every provider rejected the payload, not because
    // a timeout cut off real progress.
    const note = result.decomposeReason === "capacity-exhausted"
      ? `ТРИАЖ (все провайдеры отвергли payload задачи): разбита на ${result.subtaskIds.length} подзадач: ${result.subtaskIds.join(", ")}`
      : `ТРИАЖ (после реального прогресса, обрезанного таймаутом): разбита на ${result.subtaskIds.length} подзадач: ${result.subtaskIds.join(", ")}`;
    await client.execute({ sql: 'UPDATE tasks SET status = ?, result = ? WHERE id = ?', args: ['готова', note, taskId] });
    await notifyTelegram(task.creator_id, `Задача ${taskId} ${note}`);
    return;
  }
  const workEnd = Date.now();

  // Push artifacts to origin BEFORE marking task as done
  if (result.success) {
    const pushed = await pushTaskArtifacts();
    if (!pushed) {
      // Push failed - mark as failed instead of done
      result.success = false;
      result.message = "Artifact push to origin failed: " + result.message;
    }
  }

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
  const status = result.success
    ? 'готова'
    : (result.partial || result.status === 'partial' ? 'partial' : (result.permanent ? 'заблокирована' : 'провал'));
  const minutesUsed = Math.ceil((workEnd - workStart) / 60000);
  const secondsToFirstWork = Math.floor((workStart - startTime) / 1000);

  await client.execute({
    sql: 'UPDATE tasks SET status = ?, result = ?, actions_run_id = ?, seconds_to_first_work = ?, minutes_used = ? WHERE id = ?',
    args: [status, result.message, process.env.GITHUB_RUN_ID, secondsToFirstWork, minutesUsed, taskId]
  });

  // Ensure correct tree completion when jobs are completed or resumed
  if (status === 'готова') {
    try {
      const treeRes = await checkTreeCompletion(taskId, task, client);
      if (treeRes && treeRes.treeComplete) {
        console.log(`[${new Date().toISOString()}] TREE_COMPLETION: tree finished successfully for parent ${treeRes.parentId} (${treeRes.completedSiblings}/${treeRes.totalSiblings} subtasks done)`);
        if (task.creator_id && treeRes.parentId) {
          await notifyTelegram(task.creator_id, `Дерево задач завершено: родительская задача ${treeRes.parentId} готова`);
        }
      }
    } catch (treeErr) {
      console.log(`[${new Date().toISOString()}] TREE_COMPLETION: check error: ${redactSecrets(treeErr.message)}`);
    }
  }

  // Notify via Telegram to creator
  await notifyTelegram(task.creator_id, `Задача ${taskId} ${status}: ${result.message}`);

  if (status === 'провал' || status === 'заблокирована') {
    await writeChatAlert({
      type: "failure",
      task: taskId,
      from: result.provider || null,
      to: null,
      error: String(result.message).split("\n")[0],
      details: result.message,
    });
  }

  // 2026-09-30: everything a task actually did or failed to do was written to
  // Turso and to Telegram, and NOTHING was written to this process's own
  // stdout - the run printed one line about the branch and then exited 0. So
  // GitHub reported a green workflow for a run whose task ended in
  // провал/заблокирована (real case: run 36687803570, task 64 - the real
  // blocker lived only in the database row). Print the verdict to the log and
  // exit non-zero when the task did not complete, so a green job means the
  // task was really done. The two early returns above (no pending task,
  // waiting on an unaccepted sibling) deliberately still exit 0 - those are
  // "nothing to do", not "the work failed".
  console.log(`[${new Date().toISOString()}] task ${taskId}: ${status} - ${String(result.message).split("\n")[0]}`);
  if (status !== "готова") process.exitCode = 1;
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
// 2026-10-07: само объявление const WORKDIR переехало наверх файла (к
// CHECKPOINT_DIR, env-настраиваемое - рефакторинг задач CLOUD-MAINT-d).
// Здесь осталась вторая копия от того же рефакторинга, из-за которой файл
// перестал парситься (SyntaxError: Identifier 'WORKDIR' has already been
// declared, node --check падал ещё до правок Vertex). Копия убрана,
// исторические комментарии сохранены.


/**
 * Push any changes made in WORKDIR (plexus-doc) back to origin.
 * Called after successful task completion, before marking task as 'готова'.
 * Uses REPO_TOKEN from executor.yml environment (scoped to plexus-doc push).
 */
async function pushTaskArtifacts() {
  try {
    const status = execSync("git status --porcelain", { cwd: WORKDIR, stdio: "pipe" }).toString().trim();
    if (!status) {
      console.log(`[${new Date().toISOString()}] push: no changes in ${WORKDIR}, skipping`);
      return true;
    }
    execSync("git config user.name 'queue-engine[bot]'", { cwd: WORKDIR, stdio: "pipe" });
    execSync("git config user.email 'queue-engine@users.noreply.github.com'", { cwd: WORKDIR, stdio: "pipe" });
    execSync("git add -A", { cwd: WORKDIR, stdio: "pipe" });
    const firstFile = status.split('\n')[0].slice(0, 50);
    const commitMsg = `task ${process.env.TASK_ID}: ${firstFile}`;
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\"')}"`, { cwd: WORKDIR, stdio: "pipe" });
    const branch = execSync("git branch --show-current", { cwd: WORKDIR, stdio: "pipe" }).toString().trim();
    execSync(`git push origin ${branch}`, { cwd: WORKDIR, stdio: "pipe" });
    console.log(`[${new Date().toISOString()}] push: committed and pushed ${status.split('\n').length} file(s) to origin/${branch}`);
    return true;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] push: FAILED - ${redactSecrets(err.message)}`);
    return false;
  }
}

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
  const m = String(text || "").match(/\bbranch[:\s]+(?!directive\b)([A-Za-z0-9][A-Za-z0-9._\/-]*)/i);
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
    console.log(`[${new Date().toISOString()}] branch: task named "${branch}" but checkout failed (${redactSecrets(err.message)}) - staying on default checkout`);
    return null;
  }
}

// Real, direct-provider config (2026-09-12) - no litellm alias model
// strings, no routing prefixes (groq/, mistral/, gemini/ are litellm's own
// convention, confirmed wrong by direct API tests against the real
// providers - see docs/DECISIONS.md). NVIDIA's "nvidia/" prefix IS real -
// confirmed against the one working example in ~/.dsh/settings.yaml's own
// nvidia-direct entry, not a litellm artifact.
//
// 2026-09-15 (CONFIG-ENRICH-b): added Google (Gemini API) and Vertex AI
// as fallback pair - Google quota errors (RESOURCE_EXHAUSTED, quota
// exceeded) trigger auto-switch to Vertex. Both use native Google SDK
// compatible endpoints, not litellm prefixes.
// 2026-10-13: groq временно исключён из ротации (провайдер падает
// capacity-shaped на каждой задаче, причина — GROQ-REASONING-FAILURE
// в бэклоге). PROVIDER_CONFIG.groq НЕ удалён — вернётся одной строкой,
// когда причина разобрана. Порядок после исключения: nvidia →
// mistral → google → vertex.
// 2026-10-18: google временно исключён из ротации тем же паттерном.
// Его OpenAI-compat endpoint отвергает какое-то поле dsh-запроса (400,
// класс CONTEXT_WINDOW_EXCEEDED — терминальный, не capacity, ротация
// на нём останавливается), а тело 400 дропается самим dsh ("no body"):
// имя поля недоступно ни через compat (run 39158906926 — полный
// non-OpenAI набор на уровне провайдера не спас), ни на executor-слое
// (run 39169576462 — сырого тела нет). Причина передана бэклог-задаче
// про «умный конфиг» (редизайн ротатора и эскалаций). PROVIDER_CONFIG.google
// НЕ удалён, settings.yaml google-блок не тронут (dsh валидирует все
// объявленные провайдеры на старте). Порядок после исключения:
// nvidia → mistral → vertex.
const PROVIDER_ORDER = ["nvidia", "mistral", "openrouter"];
const PROVIDER_CONFIG = {
  groq: { baseURL: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  nvidia: { baseURL: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", model: "nvidia/nemotron-3-ultra-550b-a55b" },
  mistral: { baseURL: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", model: "mistral-medium-3-5" },
  // 2026-10-04: model was gemini-1.5-pro - verified dead against the real
  // endpoint (HTTP 404 "no longer available to new users"; every pro-tier
  // model carries free-tier limit 0 on the current key, 429). gemini-3.8-flash
  // verified with a real HTTP 200 chat completion. Same id now in the
  // workflow's settings.yaml google entry - the dsh --patch overlay (line
  // 473) selects the model from HERE, so code and yaml must agree.
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKeyEnv: "GOOGLE_API_KEY", model: "gemini-3.8-flash" },
  // 2026-10-07: baseURL переведён на OpenAI-совместимый endpoint Vertex
  // (/endpoints/openapi), потому что код ниже склеивает к нему
  // /chat/completions. Native путь /publishers/google/models/ не подходит.
  // model обновлена на gemini-3.8-flash (1.5-pro мертва, 404). location
  // по умолчанию global — Gemini 3.x на региональных endpoint'ах не
  // находит эти модели.
  vertex: { baseURL: "https://${VERTEX_LOCATION:-global}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION:-global}/endpoints/openapi", apiKeyEnv: "VERTEX_ACCESS_TOKEN", model: "gemini-3.8-flash" },
  openrouter: { 
    api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1', 
    apiKeyEnv: 'OPENROUTER_API_KEY', 
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    fallbackModels: [
      'thinking-machines/inkling:free',
      'z-ai/glm-5.2:free'
    ],
  },
};

// Helper to resolve Vertex baseURL with env vars at runtime (shell-style ${VAR:-default} not interpolated in JS)
function resolveVertexBaseURL(cfg) {
  if (cfg.baseURL.includes("${")) {
    const location = process.env.VERTEX_LOCATION || "global";
    const projectId = process.env.VERTEX_PROJECT_ID || "";
    return cfg.baseURL
      .replace(/\$\{VERTEX_LOCATION:-([^}]+)\}/g, location)
      .replace(/\$\{VERTEX_PROJECT_ID\}/g, projectId);
  }
  return cfg.baseURL;
}

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
//
// 2026-09-15 (CONFIG-ENRICH-b): added Google quota errors (RESOURCE_EXHAUSTED,
// quota exceeded, 429) to trigger auto-switch from Google to Vertex.
const CAPACITY_RE = /MidStreamFallbackError|ServiceUnavailableError|Service Unavailable|503|No deployments available|RateLimitError|RATE_LIMIT|rate_limit_exceeded|Service temporarily overloaded|APIConnectionError|ECONNREFUSED|Connection error|high demand|UNAVAILABLE|hook dispatch failed|operation timed out|timed out after|RESOURCE_EXHAUSTED|quota exceeded|429|413|Payload Too Large|rate limit/i;

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
  // An HTML error page or raw binary blob shows a huge unbroken token from
  // the very first characters. A long hash/minified line/a long URL buried
  // inside otherwise normal prose is a legitimate answer and must NOT be
  // condemned wholesale. So scope the unbroken-token check to the start of
  // the response only (0.5KB is far more than any honest prose prefix and
  // far less than the error-page/blob signal size): if a run of >=500
  // non-whitespace chars appears within the opening prefix, treat it as a
  // blob; otherwise leave the full text alone even if a long token appears
  // later. (CLOUD-EXECUTOR-LOOP-DETECTOR-FIX)
  const hasHugeUnbrokenToken = /^\S{500,}/.test(t);
  if (looksLikeHtmlPage || hasHugeUnbrokenToken) {
    return `[proxy/HTTP error, not a model answer - looks like ${looksLikeHtmlPage ? "an HTML error page" : "a raw binary/encoded blob"}]`;
  }
  return t;
}

// GHQ2-e, 2026-09-14: credential redaction guard.
// CLOUD-MAINT-c-e-progress-loop-distinction-b: comprehensive secret sanitization
// covering API keys, tokens, passwords, private keys, cloud service account credentials,
// and dynamic environment secrets before logging, printing, or storage.
function redactSecrets(text) {
  let out = String(text || "");
  let hit = false;

  // 1. GCP service-account JSON key - both markers together (preserves contract of test-chat-alerts)
  if (/"type"\s*:\s*"service_account"/.test(out) && /BEGIN PRIVATE KEY/.test(out)) {
    out = out.replace(/\{[^{}]*"type"\s*:\s*"service_account"[\s\S]*?\}/g, "[REDACTED: GCP service-account JSON key]");
    hit = true;
  }

  // 2. Standalone PEM private keys (RSA, EC, DSA, OPENSSH, or unlabelled)
  const pemKeyRe = /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g;
  if (pemKeyRe.test(out)) {
    out = out.replace(pemKeyRe, "[REDACTED: private key]");
    hit = true;
  }

  // 3. LiteLLM / OpenAI / Anthropic sk-... style key
  if (/\bsk-[A-Za-z0-9_-]{20,}/.test(out)) {
    out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED: sk-... key]");
    hit = true;
  }

  // 4. *MASTER_KEY* assigned a 64-char hex value (openssl rand -hex 32 shape)
  const masterKeyRe = /(MASTER_KEY|LITELLM_MASTER_KEY)([\s]*[:=][\s]*)(["']?)[a-f0-9]{64}\3/gi;
  if (masterKeyRe.test(out)) {
    out = out.replace(masterKeyRe, "$1$2$3[REDACTED: master key]$3");
    hit = true;
  }

  // 5. Provider-specific API keys & tokens
  // Groq API keys (gsk_...)
  if (/\bgsk_[A-Za-z0-9_-]{20,}\b/.test(out)) {
    out = out.replace(/\bgsk_[A-Za-z0-9_-]{20,}\b/g, "[REDACTED: groq key]");
    hit = true;
  }
  // NVIDIA API keys (nvapi-...)
  if (/\bnvapi-[A-Za-z0-9_-]{20,}\b/.test(out)) {
    out = out.replace(/\bnvapi-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED: nvidia key]");
    hit = true;
  }
  // Google / Gemini API keys (AIzaSy...)
  if (/\bAIzaSy[A-Za-z0-9_-]{20,}\b/.test(out)) {
    out = out.replace(/\bAIzaSy[A-Za-z0-9_-]{20,}\b/g, "[REDACTED: google key]");
    hit = true;
  }
  // Vertex AI OAuth2 access tokens (ya29....)
  if (/\bya29\.[A-Za-z0-9_-]{20,}\b/.test(out)) {
    out = out.replace(/\bya29\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED: vertex token]");
    hit = true;
  }
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  const ghTokenRe = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
  if (ghTokenRe.test(out)) {
    out = out.replace(ghTokenRe, "[REDACTED: GitHub token]");
    hit = true;
  }

  // 6. Telegram Bot tokens & URLs
  const tgUrlRe = /(https:\/\/api\.telegram\.org\/bot)[^\/\s]+(\/[^\s]*)?/gi;
  if (tgUrlRe.test(out)) {
    out = out.replace(tgUrlRe, "$1[REDACTED: Telegram bot token]$2");
    hit = true;
  }
  const tgTokenRe = /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/g;
  if (tgTokenRe.test(out)) {
    out = out.replace(tgTokenRe, "[REDACTED: Telegram bot token]");
    hit = true;
  }

  // 7. Embedded basic authentication credentials in URLs (e.g. https://user:pass@host)
  const urlCredsRe = /(https?:\/\/)([^:\/\s@]+):([^@\/\s]+)@/g;
  if (urlCredsRe.test(out)) {
    out = out.replace(urlCredsRe, "$1$2:[REDACTED]@");
    hit = true;
  }

  // 8. Sensitive URL query parameters (authToken=..., token=..., password=...)
  const urlParamRe = /([?&](?:authToken|access_token|api[_-]?key|bot_token|token|password|passwd|secret)=)([^&\s]+)/gi;
  if (urlParamRe.test(out)) {
    out = out.replace(urlParamRe, "$1[REDACTED]");
    hit = true;
  }

  // 9. Bearer tokens
  const bearerRe = /(Bearer\s+)[A-Za-z0-9_\-\.+=]{16,}/gi;
  if (bearerRe.test(out)) {
    out = out.replace(bearerRe, "$1[REDACTED: token]");
    hit = true;
  }

  // 10. JWT tokens
  const jwtRe = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
  if (jwtRe.test(out)) {
    out = out.replace(jwtRe, "[REDACTED: JWT token]");
    hit = true;
  }

  // 11. Sensitive assignment lines (VAR=value, VAR: value) in configs/env-dumps/logs
  const assignRe = /\b([A-Za-z0-9_-]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BOT_TOKEN|REPO_TOKEN|DISPATCH_TOKEN|TURSO_AUTH|ADMIN_BOT_TOKEN|TELEGRAM_BOT_TOKEN|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|CLIENT_SECRET)[A-Za-z0-9_-]*)\s*([:=])\s*(["']?)([^"'\s\r\n]{4,})\3/gi;
  if (assignRe.test(out)) {
    out = out.replace(assignRe, "$1$2$3[REDACTED: $1]$3");
    hit = true;
  }

  // 12. JSON sensitive key-value pairs ("password": "...", "apiKey": "...")
  const jsonKeyRe = /(["'](?:[^"']*(?:api[_-]?key|auth[_-]?token|access[_-]?token|bot[_-]?token|repo[_-]?token|token|password|passwd|secret|private[_-]?key)[^"']*)["']\s*:\s*)(["'])([^"'\r\n]{4,})\2/gi;
  if (jsonKeyRe.test(out)) {
    out = out.replace(jsonKeyRe, "$1$2[REDACTED]$2");
    hit = true;
  }

  // 13. CLI command-line flags with secrets (--password=..., --token ...)
  const cliOptionRe = /(--(?:password|token|api[_-]?key|secret|auth|access[_-]?token)[=\s]+)(["']?)[^\s"']+\2/gi;
  if (cliOptionRe.test(out)) {
    out = out.replace(cliOptionRe, "$1$2[REDACTED]$2");
    hit = true;
  }

  // 14. Dynamic redaction of live environment secrets and loaded tokens
  const liveSecrets = getLiveSecrets();
  for (const s of liveSecrets) {
    if (out.includes(s.value)) {
      out = out.replaceAll(s.value, `[REDACTED: ${s.name}]`);
      hit = true;
    }
  }

  if (hit) {
    const logFn = typeof originalConsoleLog === "function" ? originalConsoleLog : console.log;
    logFn(`[${new Date().toISOString()}] secret-leak guard: redacted real credential shape(s) from task result before writing/notifying`);
  }
  return out;
}

// ============================================================================
// Structured Error Handling (CLOUD-MAINT-b-e)
// Machine-readable error codes, contextual metadata, and recovery hints.
// Ensures errors are structured objects rather than unstructured string blobs,
// maintaining backward compatibility with standard Error semantics.
// ============================================================================

/**
 * Standard machine-readable error codes.
 */
const ERROR_CODES = {
  QUOTA: "QUOTA",
  RATE_LIMIT: "ERR_RATE_LIMIT",
  CONTEXT_WINDOW_EXCEEDED: "CONTEXT_WINDOW_EXCEEDED",
  PAYLOAD_TOO_LARGE: "ERR_PAYLOAD_TOO_LARGE",
  SERVICE_UNAVAILABLE: "ERR_SERVICE_UNAVAILABLE",
  CAPACITY_EXHAUSTED: "ERR_CAPACITY_EXHAUSTED",
  AUTH_FAILURE: "ERR_AUTH_FAILURE",
  PERMISSION_DENIED: "ERR_PERMISSION_DENIED",
  TIMEOUT_PROGRESS: "ERR_TIMEOUT_PROGRESS",
  TIMEOUT_LOOP: "ERR_TIMEOUT_LOOP",
  PROCESS_EXIT: "ERR_PROCESS_EXIT",
  EMPTY_OUTPUT: "ERR_EMPTY_OUTPUT",
  COMMAND_FAILED: "ERR_COMMAND_FAILED",
  BOOTSTRAP_FAILURE: "ERR_BOOTSTRAP_FAILURE",
  UNKNOWN: "ERR_UNKNOWN",
};

/**
 * Standard recovery hints for structured failure remediation.
 */
const RECOVERY_HINTS = {
  ROTATE_PROVIDER: "rotate_provider",
  SPLIT_SUBTASKS: "split_subtasks",
  ESCALATE_FOUNDER: "escalate_founder",
  PERMANENT_BLOCKER: "permanent_blocker",
  CHECK_CREDENTIALS: "check_credentials",
  INSPECT_LOGS: "inspect_logs",
  RETRY: "retry",
  COOLDOWN: "cooldown",
  ROTATE: "rotate",
  FAIL: "fail",
};

/**
 * Parses dsh's structured JSON output and extracts error.code and metadata.
 * Implements the error code mapping:
 *   QUOTA                   -> rotate   (switch to next provider immediately)
 *   RATE_LIMIT              -> cooldown (pause per retryDelay or backoff, retry same provider)
 *   CONTEXT_WINDOW_EXCEEDED -> fail     (immediate failure, retries/rotations useless)
 *
 * @param {string} text - Raw stderr / stdout text from dsh execution
 * @returns {{errorCode: string, action: "rotate"|"cooldown"|"fail", retryDelay: number, errorMsg: string, rawErrorObj: object|null}|null}
 */
function parseDshStructuredError(text) {
  if (!text || typeof text !== "string") return null;

  // Strip ANSI escape codes
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  let errorCode = null;
  let action = null;
  let retryDelay = 0;
  let errorMsg = "";
  let rawErrorObj = null;

  function inspectObj(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;

    const err = data.error;
    let code = null;
    let status = null;
    let msg = "";
    let details = [];

    if (err && typeof err === "object" && !Array.isArray(err)) {
      code = err.code ?? null;
      status = err.status ?? null;
      msg = err.message ?? "";
      details = Array.isArray(err.details) ? err.details : [];
    } else if (typeof err === "string") {
      code = err;
    }

    let reason = null;
    if (data.event && typeof data.event === "object") {
      reason = data.event.data?.reason;
    }
    if (!reason && data.data && typeof data.data === "object") {
      reason = data.data.reason || data.data.chunk?.reason;
    }
    if (!reason && data.reason && typeof data.reason === "object") {
      reason = data.reason;
    }

    if (reason && typeof reason === "object" && reason.kind === "error") {
      const f = reason.error || reason.failure;
      if (f && typeof f === "object") {
        if (!code && f.code) code = f.code;
        if (!msg && f.message) msg = f.message;
        if (details.length === 0 && Array.isArray(f.details)) details = f.details;
      } else if (typeof f === "string" && !code) {
        code = f;
      }
    }

    if (details.length === 0 && Array.isArray(data.details)) {
      details = data.details;
    }

    if (!code && data.code) code = data.code;
    if (!code && data.error_code) code = data.error_code;
    if (!status && data.status) status = data.status;

    let hasPerMinute = false;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d && typeof d === "object") {
          if (d.retryDelay) {
            const dm = String(d.retryDelay).match(/(\d+)/);
            if (dm) retryDelay = parseInt(dm[1], 10);
          }
          const qid = String(d.quotaId || "");
          if (qid.includes("PerMinute")) {
            hasPerMinute = true;
          }
        }
      }
    }

    if (!code && status) {
      code = status;
    }

    if (code !== null && code !== undefined) {
      const cStr = String(code);
      let objCode = cStr;
      if (cStr === "429") {
        if ((status === "RESOURCE_EXHAUSTED" || status === "QUOTA_EXHAUSTED") && !hasPerMinute) {
          objCode = "QUOTA";
        } else {
          objCode = "RATE_LIMIT";
        }
      }

      if (!errorCode || ["SERVER", "API_ERROR", "ERROR"].includes(errorCode)) {
        errorCode = objCode;
      } else if (errorCode === "QUOTA" && objCode === "RATE_LIMIT" && !hasPerMinute) {
        // Keep QUOTA
      } else if (["QUOTA", "RATE_LIMIT", "CONTEXT_WINDOW_EXCEEDED"].includes(objCode)) {
        errorCode = objCode;
      }

      if (msg) {
        errorMsg = String(msg);
      }
      rawErrorObj = data;
      return true;
    }
    return false;
  }

  const stripped = clean.trim();
  const lines = stripped.split(/\r?\n/);

  // 1. Check lines in reverse
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check dsh: <CODE>: <REST>
    const m = line.match(/^dsh:\s*([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (m) {
      const prefixCode = m[1];
      const rest = m[2].trim();
      errorCode = prefixCode;
      errorMsg = rest;
      const sIdx = rest.indexOf("{");
      const eIdx = rest.lastIndexOf("}");
      if (sIdx !== -1 && eIdx > sIdx) {
        try {
          const robj = JSON.parse(rest.slice(sIdx, eIdx + 1));
          inspectObj(robj);
        } catch {}
      }
      break;
    }

    // Check if line contains JSON object
    const startIdx = line.indexOf("{");
    const endIdx = line.lastIndexOf("}");
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        const obj = JSON.parse(line.slice(startIdx, endIdx + 1));
        if (inspectObj(obj)) break;
      } catch {}
    }
  }

  // 2. Try parsing full text as JSON or multiline JSON blocks if errorCode not found
  if (!errorCode && clean.includes("{") && clean.includes("}")) {
    try {
      const parsed = JSON.parse(stripped);
      if (typeof parsed === "object" && parsed !== null) {
        inspectObj(parsed);
      }
    } catch {}
  }

  if (!errorCode && clean.includes("{") && clean.includes("}")) {
    const jsonMatches = clean.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
    if (jsonMatches) {
      for (let i = jsonMatches.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(jsonMatches[i]);
          if (inspectObj(obj)) break;
        } catch {}
      }
    }
  }

  // Final code and action normalization
  if (errorCode) {
    const ecUpper = String(errorCode).toUpperCase();
    if (
      ecUpper.includes("CONTEXT_WINDOW") ||
      ecUpper.includes("CONTEXT_LENGTH") ||
      ecUpper === "REQUEST_TOO_LARGE" ||
      ecUpper === "MAX_TOKENS"
    ) {
      errorCode = "CONTEXT_WINDOW_EXCEEDED";
      action = "fail";
    } else if (
      ecUpper.includes("QUOTA") ||
      ecUpper === "RESOURCE_EXHAUSTED" ||
      ecUpper === "QUOTA_EXHAUSTED" ||
      ecUpper === "DAILY_QUOTA"
    ) {
      errorCode = "QUOTA";
      action = "rotate";
    } else if (
      ecUpper.includes("RATE_LIMIT") ||
      ecUpper === "429" ||
      ecUpper === "RATE_LIMIT_EXCEEDED"
    ) {
      errorCode = "RATE_LIMIT";
      action = "cooldown";
    }
  }

  if (!errorCode) return null;

  return {
    errorCode,
    action,
    retryDelay,
    errorMsg,
    rawErrorObj,
  };
}

/**
 * Standard task execution statuses for tracking progress vs loop and outcomes.
 */
const TASK_STATUSES = {
  PENDING: "ожидает",
  RUNNING: "выполняется",
  COMPLETED: "готова",
  FAILED: "провал",
  BLOCKED: "заблокирована",
  PARTIAL: "partial",
  LOOP: "loop",
  PROGRESS: "progress",
};

/**
 * Standard execution event types for telemetry, chat alerts, and stuck detection.
 */
const EXECUTION_EVENTS = {
  PROGRESS: "progress",
  LOOP: "loop",
  TIMEOUT_PROGRESS: "timeout_progress",
  TIMEOUT_LOOP: "timeout_loop",
  STUCK_TASK: "stuck_task",
};

/**
 * StructuredError encapsulates an error code, context metadata, and recovery hint.
 * Inherits from standard Error to preserve message, stack, and instanceof Error checks.
 */
class StructuredError extends Error {
  /**
   * @param {string} message - Human-readable error message (redacted)
   * @param {object} [options]
   * @param {string} [options.code] - Machine-readable error code (from ERROR_CODES)
   * @param {string} [options.category] - Error category ('capacity', 'auth', 'timeout', 'process', 'bootstrap')
   * @param {object} [options.context] - Structured contextual metadata (provider, taskId, exitCode, snippets)
   * @param {string} [options.recoveryHint] - Actionable recovery hint (from RECOVERY_HINTS)
   * @param {string} [options.timestamp] - ISO timestamp
   * @param {Error} [options.cause] - Underlying causal error
   */
  constructor(message, options = {}) {
    const redactedMsg = redactSecrets(message || "An error occurred");
    super(redactedMsg);
    this.name = "StructuredError";
    this.code = options.code || ERROR_CODES.UNKNOWN;
    this.category = options.category || "unknown";
    this.context = options.context ? JSON.parse(redactSecrets(JSON.stringify(options.context))) : {};
    this.recoveryHint = options.recoveryHint || RECOVERY_HINTS.INSPECT_LOGS;
    this.timestamp = options.timestamp || new Date().toISOString();
    if (options.dshError) {
      this.dshError = options.dshError;
    }
    if (options.cause) {
      this.cause = options.cause;
    }
    // Backward-compatibility properties
    if (options.timeoutVerdict) this.timeoutVerdict = options.timeoutVerdict;
    if (options.isLoop !== undefined) this.isLoop = options.isLoop;
    if (options.isProgress !== undefined) this.isProgress = options.isProgress;
    if (options.avgSimilarity !== undefined) this.avgSimilarity = options.avgSimilarity;
    if (options.iterationCount !== undefined) this.iterationCount = options.iterationCount;
    if (options.failedPlugins) this.failedPlugins = options.failedPlugins;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      context: this.context,
      recoveryHint: this.recoveryHint,
      timestamp: this.timestamp,
      ...(this.dshError ? { dshError: this.dshError } : {}),
    };
  }
}

/**
 * Maps raw error strings, exit codes, or Error instances into a StructuredError.
 *
 * @param {Error|string|unknown} rawError - Incoming error
 * @param {object} [context] - Contextual metadata (provider, taskId, exitCode, etc.)
 * @returns {StructuredError}
 */
function createStructuredError(rawError, context = {}) {
  if (rawError instanceof StructuredError) {
    if (context && Object.keys(context).length > 0) {
      rawError.context = { ...rawError.context, ...context };
      if (context.dshError) {
        rawError.dshError = context.dshError;
      }
    }
    return rawError;
  }

  const msg = redactSecrets(rawError?.message || String(rawError || ""));
  const exitCode = context.exitCode ?? rawError?.exitCode ?? (typeof rawError?.code === "number" ? rawError.code : null);

  const textToScan = [
    context.stderrSnippet,
    context.stdoutSnippet,
    rawError?.stderr,
    rawError?.stdout,
    rawError?.body,
    msg,
  ].filter(Boolean).join("\n");

  const dshError = context.dshError || parseDshStructuredError(textToScan);

  let code = ERROR_CODES.UNKNOWN;
  let category = "unknown";
  let recoveryHint = RECOVERY_HINTS.INSPECT_LOGS;

  if (dshError && dshError.errorCode) {
    code = dshError.errorCode;
    if (dshError.errorCode === "CONTEXT_WINDOW_EXCEEDED") {
      category = "capacity";
      recoveryHint = RECOVERY_HINTS.FAIL;
    } else if (dshError.errorCode === "QUOTA") {
      category = "capacity";
      recoveryHint = RECOVERY_HINTS.ROTATE_PROVIDER;
    } else if (dshError.errorCode === "RATE_LIMIT") {
      category = "capacity";
      recoveryHint = RECOVERY_HINTS.COOLDOWN;
    } else {
      if (dshError.action === "rotate") {
        category = "capacity";
        recoveryHint = RECOVERY_HINTS.ROTATE_PROVIDER;
      } else if (dshError.action === "cooldown") {
        category = "capacity";
        recoveryHint = RECOVERY_HINTS.COOLDOWN;
      } else if (dshError.action === "fail") {
        category = "auth";
        recoveryHint = RECOVERY_HINTS.PERMANENT_BLOCKER;
      }
    }
  } else if (/401|unauthorized|invalid api key|invalid_api_key/i.test(msg)) {
    code = ERROR_CODES.AUTH_FAILURE;
    category = "auth";
    recoveryHint = RECOVERY_HINTS.CHECK_CREDENTIALS;
  } else if (/403|forbidden|permission denied|access denied/i.test(msg)) {
    code = ERROR_CODES.PERMISSION_DENIED;
    category = "auth";
    recoveryHint = RECOVERY_HINTS.PERMANENT_BLOCKER;
  } else if (/413|payload too large|token limit.*exceeded/i.test(msg)) {
    code = ERROR_CODES.PAYLOAD_TOO_LARGE;
    category = "capacity";
    recoveryHint = RECOVERY_HINTS.SPLIT_SUBTASKS;
  } else if (/429|rate_limit|rate limit|quota exceeded|RESOURCE_EXHAUSTED/i.test(msg)) {
    code = ERROR_CODES.RATE_LIMIT;
    category = "capacity";
    recoveryHint = RECOVERY_HINTS.ROTATE_PROVIDER;
  } else if (/503|service unavailable|overloaded|connection refused|ECONNREFUSED/i.test(msg)) {
    code = ERROR_CODES.SERVICE_UNAVAILABLE;
    category = "capacity";
    recoveryHint = RECOVERY_HINTS.ROTATE_PROVIDER;
  } else if (CAPACITY_RE.test(msg)) {
    code = ERROR_CODES.CAPACITY_EXHAUSTED;
    category = "capacity";
    recoveryHint = RECOVERY_HINTS.ROTATE_PROVIDER;
  } else if (/timed out/i.test(msg)) {
    code = ERROR_CODES.TIMEOUT_LOOP;
    category = "timeout";
    recoveryHint = RECOVERY_HINTS.ROTATE_PROVIDER;
  } else if (exitCode !== null && exitCode !== 0) {
    code = ERROR_CODES.PROCESS_EXIT;
    category = "process";
    recoveryHint = RECOVERY_HINTS.INSPECT_LOGS;
  }

  const structured = new StructuredError(msg, {
    code,
    category,
    context: {
      ...context,
      exitCode,
      ...(dshError ? { dshError } : {}),
    },
    recoveryHint,
    dshError,
    cause: rawError instanceof Error ? rawError : undefined,
  });

  if (rawError?.timeoutVerdict) structured.timeoutVerdict = rawError.timeoutVerdict;
  if (rawError?.isLoop !== undefined) structured.isLoop = rawError.isLoop;
  if (rawError?.isProgress !== undefined) structured.isProgress = rawError.isProgress;
  if (rawError?.avgSimilarity !== undefined) structured.avgSimilarity = rawError.avgSimilarity;
  if (rawError?.iterationCount !== undefined) structured.iterationCount = rawError.iterationCount;
  if (rawError?.failedPlugins) structured.failedPlugins = rawError.failedPlugins;

  return structured;
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

/**
 * Classifies whether task execution represents forward progress or a repeating loop / stuck state.
 *
 * Compares consecutive reasoning segments using Jaccard word-set similarity.
 *
 * @param {string|string[]} input - dsh reasoning text or array of reasoning segments
 * @param {object} [options]
 * @param {number} [options.threshold=0.5] - Similarity threshold. avgSimilarity >= threshold -> "loop"
 * @returns {{verdict: "progress"|"loop", avgSimilarity: number, segmentsCount: number, isLoop: boolean, isProgress: boolean}}
 */
function classifyProgressVsLoop(input, options = {}) {
  const threshold = options.threshold ?? 0.5;
  let segs = [];
  if (Array.isArray(input)) {
    segs = input.map((s) => String(s || "").trim()).filter(Boolean);
  } else {
    const clean = String(input || "").replace(/\x1b\[[0-9;]*m/g, "");
    segs = clean
      .split(/^dsh: reasoning:\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Fail-closed guard: if < 2 segments, cannot verify progression -> default to loop
  if (segs.length < 2) {
    return {
      verdict: "loop",
      avgSimilarity: 1.0,
      segmentsCount: segs.length,
      isLoop: true,
      isProgress: false,
    };
  }

  const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9а-яё_./-]{3,}/gi) || []);
  let total = 0;
  let pairsCount = 0;

  for (let i = 1; i < segs.length; i++) {
    const wa = words(segs[i - 1]);
    const wb = words(segs[i]);
    // 2026-10-09 fix: if either segment has 0 recognizable words (e.g. non-Latin/non-Cyrillic,
    // raw binary/ANSI corruption), do NOT count it as 0 similarity (which would falsely pull avg down
    // and label verbatim repetition as "progress"). Skip the unreadable pair.
    if (wa.size === 0 || wb.size === 0) {
      continue;
    }
    let inter = 0;
    for (const w of wa) {
      if (wb.has(w)) inter++;
    }
    const union = new Set([...wa, ...wb]).size;
    total += union === 0 ? 0 : inter / union;
    pairsCount++;
  }

  // If no valid word pairs could be compared, fail closed to 1.0 (loop)
  const avg = pairsCount > 0 ? total / pairsCount : 1.0;
  const isLoop = avg >= threshold;
  const isProgress = !isLoop;
  const verdict = isProgress ? "progress" : "loop";

  return {
    verdict,
    avgSimilarity: avg,
    segmentsCount: segs.length,
    isLoop,
    isProgress,
  };
}

function classifyTimeoutKill(text) {
  return classifyProgressVsLoop(text).verdict;
}

function detectLoop(input, threshold = 0.5) {
  return classifyProgressVsLoop(input, { threshold }).isLoop;
}

/**
 * Detects whether a task or execution is stuck in a loop across attempts/iterations.
 *
 * @param {object} task - Task record
 * @param {object} [options]
 * @param {number} [options.maxIterations=3] - Maximum allowed retry/loop iterations
 * @returns {{stuck: boolean, reason?: string, iterationCount: number}}
 */
function detectStuckTask(task, options = {}) {
  const maxIterations = options.maxIterations || 3;
  let iterations = Number(
    task?.iteration_count ||
    task?.retry_count ||
    task?.attempts ||
    task?.iterations ||
    options?.currentIteration ||
    0
  );
  if (!iterations && typeof task?.text === "string") {
    const match = task.text.match(/\[(?:iteration|retry|attempt):\s*(\d+)\]/i) ||
                  task.text.match(/(?:iteration|retry|attempt)\s*#?\s*(\d+)/i);
    if (match) {
      iterations = parseInt(match[1], 10);
    }
  }
  if (task?.status === "loop" || task?.status === "stuck") {
    return { stuck: true, reason: `Task marked with status ${task.status}`, iterationCount: iterations };
  }
  if (iterations >= maxIterations) {
    return { stuck: true, reason: `Exceeded max iterations (${iterations}/${maxIterations})`, iterationCount: iterations };
  }
  return { stuck: false, iterationCount: iterations };
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
  // 2026-10-11, PLEXUS-S13-UNBLOCK: для [NO-TRIAGE] не грузим
  // AGENTS.md вообще. 8K токенов инструкций репозитория перебивают
  // TPM-лимит 8000 у groq, задача не влезает. Leaf-level задача с
  // [NO-TRIAGE] не нуждается в repo-инструкциях. Для остальных —
  // как было (32768, ["AGENTS.md"]).
  const noTriage = typeof text === "string" && text.includes("[NO-TRIAGE]");
  const agentsBytes = noTriage ? 1024 : 32768;
  const agentsFileLine = noTriage ? "" : '\n    instructionFileCandidates: ["AGENTS.md"]';
  const patchContent = `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${cfg.model}\n- id: agent-instructions\n  config:\n    maxBytes: ${agentsBytes}${agentsFileLine}\n`;
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
      // 2026-10-04: reasoning stream, held separately from `err` (which stays
      // small for error messages). dsh streams its reasoning under the
      // "dsh: reasoning:" heading to STDERR - verified in the installed
      // package (@deepseek-ai/dsh-headless 0.1.5-rc.3, lib/index.js:89
      // `stderr.write("dsh: reasoning:\n")`; its README: "streams each
      // non-empty provider reasoning delta to stderr under a `dsh: reasoning:`
      // heading, then prints the final answer on stdout"). Capped to the last
      // MAX_OUTPUT chars: the timeout classifier compares consecutive
      // segments, so it needs the recent tail, not the first bytes of an
      // 8-minute run.
      let reasoning = "";
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
        // "dsh: reasoning:" line, split the captured reasoning stream on
        // that marker and compare consecutive segments by word-set overlap.
        // Real repetition restates nearly the same sentence (high overlap);
        // real progress reads as different text turn to turn even about
        // the same file (low overlap).
        const classification = classifyProgressVsLoop(reasoning);
        const timeoutVerdict = classification.verdict;
        const isLoop = classification.isLoop;
        const isProgress = classification.isProgress;
        const avgSimilarity = classification.avgSimilarity;
        const code = isLoop ? ERROR_CODES.TIMEOUT_LOOP : ERROR_CODES.TIMEOUT_PROGRESS;
        const recoveryHint = isLoop ? RECOVERY_HINTS.ROTATE_PROVIDER : RECOVERY_HINTS.SPLIT_SUBTASKS;
        const timeoutErr = new StructuredError("dsh timed out after 8min", {
          code,
          category: "timeout",
          context: {
            provider,
            timeoutMinutes: 8,
            timeoutVerdict,
            isLoop,
            isProgress,
            avgSimilarity,
            reasoningLength: reasoning.length,
          },
          recoveryHint,
          timeoutVerdict,
          isLoop,
          isProgress,
          avgSimilarity,
        });
        reject(timeoutErr);
      }, 8 * 60 * 1000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      // 2026-09-12: was `child.stderr.resume()` (discard) - real bug found
      // this way needed the actual stderr content to diagnose, so it's
      // captured (bounded) instead of thrown away.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
      let fullStderr = "";
      child.stderr.on("data", (d) => {
        fullStderr += d;
        if (fullStderr.length > 100000) fullStderr = fullStderr.slice(-100000);
      });
      // 2026-10-04: the reasoning stream for the timeout classifier - see the
      // comment above the `reasoning` declaration. Tail-capped, not head-capped.
      child.stderr.on("data", (d) => {
        reasoning += d;
        if (reasoning.length > MAX_OUTPUT) reasoning = reasoning.slice(-MAX_OUTPUT);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const trimmed = out.trim();
        const dshError = parseDshStructuredError(fullStderr || err) || parseDshStructuredError(out);
        if (code === 0 && trimmed === "" && err.trim() !== "") {
          const structuredErr = new StructuredError(
            redactSecrets(`dsh exited 0 with empty stdout, stderr: ${err.slice(-1500)}`),
            {
              code: dshError?.errorCode || ERROR_CODES.EMPTY_OUTPUT,
              category: "process",
              context: {
                provider,
                exitCode: 0,
                stderrSnippet: redactSecrets(err.slice(-1500)),
                dshError,
              },
              recoveryHint: dshError?.action === "cooldown"
                ? RECOVERY_HINTS.COOLDOWN
                : (dshError?.action === "fail" ? RECOVERY_HINTS.FAIL : RECOVERY_HINTS.ROTATE_PROVIDER),
              dshError,
            }
          );
          reject(structuredErr);
        } else if (code === 0) {
          resolve(redactSecrets(trimmed));
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
          const msg = redactSecrets(`dsh exited ${code}: ${body.slice(-1500)}`);
          const structuredErr = createStructuredError(msg, {
            provider,
            exitCode: code,
            stderrSnippet: redactSecrets(err.slice(-1500)),
            stdoutSnippet: redactSecrets(out.slice(-500)),
            dshError,
          });
          reject(structuredErr);
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        const structuredErr = createStructuredError(err, { provider });
        reject(structuredErr);
      });
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
  const isResume = isResumeJob(task, text);
  const isLongCompute = isLongComputeJob(task, text);
  const command = extractCommand(text, task);

  // Resume execution for long compute or resume jobs
  if (isResume && command !== null) {
    return await executeResume(command, task, text);
  }

  // Separate compute path for long compute jobs (exempt from 5-minute limit, respects job cap duration)
  if (isLongCompute && command !== null) {
    return await executeLongCompute(command, task, text);
  }

  // Direct shell command execution for regular jobs (bypasses LLM/dsh, standard 5-minute timeout)
  if (command !== null) {
    console.log(`[${new Date().toISOString()}] RUN_COMMAND: executing ${redactSecrets(command)} (standard 5-minute timeout)`);
    const cmdResult = await runCommand(command, { isLongCompute: false });
    const output = cmdResult.success
      ? `Команда выполнена успешно (exit ${cmdResult.exitCode}).\nSTDOUT: ${cmdResult.stdout || '(пусто)'}\nSTDERR: ${cmdResult.stderr || '(пусто)'}`
      : `Команда завершилась с ошибкой (exit ${cmdResult.exitCode}).\nSTDOUT: ${cmdResult.stdout || '(пусто)'}\nSTDERR: ${cmdResult.stderr}`;
    let failureMsg = cmdResult.stderr;
    if (cmdResult.stdout) {
      failureMsg = failureMsg ? `${failureMsg}\n[STDOUT]: ${cmdResult.stdout}` : cmdResult.stdout;
    }
    return {
      success: cmdResult.success,
      message: cmdResult.success ? (cmdResult.stdout || 'Command executed successfully') : (failureMsg || 'Command failed')
    };
  }
  const tried = new Set();
  let provider = PROVIDER_ORDER[0];
  let lastErr = null;
  let attemptLog = "";
  const cooldownCounts = {};
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
      // DEBUG ONLY (2026-10-18): capture raw 400 body from google before it is dropped upstream.
      if (provider === 'google') {
        const has400 = /400/.test(String(err?.message || err || "")) || /400/.test(String(err?.status || err?.code || ""));
        if (has400) {
          console.error(`[DEBUG RAW 400 BODY google] body=${String(err?.body || err?.response?.body || err?.response?.data || err?.context?.stderrSnippet || err?.message || err || "none")}`);
        }
      }
      const structuredErr = createStructuredError(err, { provider, attempt, taskId: task?.id });
      const msg = redactSecrets(String(err.message || err));
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
        await writeChatAlert({
          type: EXECUTION_EVENTS.TIMEOUT_PROGRESS,
          task: task?.id || "",
          from: provider,
          to: null,
          details: `Task execution showed forward progress before timeout (avgSimilarity: ${err.avgSimilarity ?? "n/a"})`,
        }).catch(() => {});
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
        await writeChatAlert({
          type: EXECUTION_EVENTS.TIMEOUT_LOOP,
          task: task?.id || "",
          from: provider,
          to: next,
          error: "Loop detected: repetitive reasoning segments or stuck state",
          details: `Repetitive loop detected on provider ${provider} (similarity: ${err.avgSimilarity ?? ">=0.5"})`,
        }).catch(() => {});
        if (next === null) break;
        console.log(`[${new Date().toISOString()}] loop-detected failure on ${provider} - switching to ${next}`);
        provider = next;
        continue;
      }

      // 2026-10-21 (QUEUE-FIX-STRUCTURED-ERRORS-d): parse structured JSON error from dsh output
      // and map error.code:
      //   QUOTA                   -> rotate   (switch provider immediately)
      //   RATE_LIMIT              -> cooldown (pause per retryDelay, retry same provider)
      //   CONTEXT_WINDOW_EXCEEDED -> fail     (immediate failure, do not rotate)
      const dshError = err.dshError || structuredErr.dshError || parseDshStructuredError(msg);

      if (dshError?.errorCode === "CONTEXT_WINDOW_EXCEEDED" || dshError?.action === "fail") {
        console.log(`[${new Date().toISOString()}] structured error.code=${dshError.errorCode} on ${provider} -> action: fail (immediate failure, no rotation)`);
        const diag = await diagnose(text, attemptLog).catch(() => null);
        const base = `код ${dshError.errorCode || err.code || structuredErr.code || "?"}: ${msg.split("\n")[0]}`;
        return {
          success: false,
          message: truncate(diag ? `${base}\n\n${diag.line}` : base),
          permanent: diag ? diag.permanent : false,
          error: structuredErr.toJSON(),
        };
      }

      if (dshError?.errorCode === "RATE_LIMIT" || dshError?.action === "cooldown") {
        const delaySec = dshError.retryDelay > 0 ? (dshError.retryDelay + 5) : 15;
        const cappedDelaySec = Math.min(delaySec, 60);
        const count = cooldownCounts[provider] || 0;
        if (count < 2) {
          cooldownCounts[provider] = count + 1;
          console.log(`[${new Date().toISOString()}] structured error.code=RATE_LIMIT on ${provider} (retryDelay: ${dshError.retryDelay}s) -> action: cooldown (pause ${cappedDelaySec}s, retry attempt ${count + 1}/2 on same provider)`);
          await new Promise((r) => setTimeout(r, cappedDelaySec * 1000));
          attempt--;
          continue;
        } else {
          console.log(`[${new Date().toISOString()}] RATE_LIMIT persisted on ${provider} after ${count} cooldowns — rotating to next provider`);
          const next = nextProvider(provider, tried);
          if (next === null) break;
          provider = next;
          continue;
        }
      }

      if (dshError?.errorCode === "QUOTA" || dshError?.action === "rotate") {
        const next = nextProvider(provider, tried);
        if (next === null) break;
        console.log(`[${new Date().toISOString()}] structured error.code=QUOTA on ${provider} -> action: rotate (switching to ${next})`);
        provider = next;
        continue;
      }

      // Fallback for unparsed legacy output: text regex parsing (CAPACITY_RE)
      if (!CAPACITY_RE.test(msg)) {
        const diag = await diagnose(text, attemptLog).catch(() => null);
        const base = `код ${err.code ?? structuredErr.code ?? "?"}: ${msg.split("\n")[0]}`;
        return {
          success: false,
          message: truncate(diag ? `${base}\n\n${diag.line}` : base),
          permanent: diag ? diag.permanent : false,
          error: structuredErr.toJSON(),
        };
      }
      const next = nextProvider(provider, tried);
      if (next === null) break;
      console.log(`[${new Date().toISOString()}] capacity-shaped failure on ${provider} (${msg.split("\n")[0]}) - switching to ${next}`);
      provider = next;
    }
  }
  // Все провайдеры исчерпаны
  // CLOUD-MAINT-c-e-progress-loop-distinction-b--c, 2026-10-13: mask the
  // last provider error BEFORE it is reused below (CAPACITY_RE test +
  // failure-message construction) - the per-attempt path above already
  // builds its msg via redactSecrets before that same test; this copy was
  // the remaining spot forming logging/storage text from raw provider
  // output (run()'s sink-side redaction still applies on top).
  const msg = redactSecrets(String(lastErr?.message || lastErr || "unknown error"));
  const lastDshError = lastErr?.dshError || parseDshStructuredError(msg);
  const isCapacity = (lastDshError?.errorCode === "QUOTA" || lastDshError?.errorCode === "RATE_LIMIT" || lastDshError?.action === "rotate" || lastDshError?.action === "cooldown") || CAPACITY_RE.test(msg);
  // 2026-10-04: decompose on exhausted-provider capacity failure, not only on
  // timeout-progress. Real case, run 37214241683 / task 64: the payload
  // (12457 tokens) exceeds groq's on-demand TPM (8000) before the model even
  // reasons - every provider rejected it within seconds (groq 413, nvidia
  // rate-limit, mistral 429, google 400), no 8-minute timeout ever fired, so
  // the timeout-progress re-decomposition above was never reached and the
  // task was unexecutable: the problem is the payload size, not the provider.
  // Same machinery as the claim-time triage, on the original task text; the
  // payload fact now also states every provider already rejected it.
  // AUTH failures do not match CAPACITY_RE and keep the ordinary failure
  // path - no decomposition on auth.
  if (isCapacity && lastDshError?.errorCode !== "CONTEXT_WINDOW_EXCEEDED" && task) {
    // 2026-10-07: [NO-TRIAGE] marker (hasNoTriageMarker below) - never
    // decompose a self-declared leaf-level task even here; fall through to
    // the ordinary failure path below (provider rotation has already fully
    // run at this point, so this means: fail by payload, no decomposition).
    if (hasNoTriageMarker(text)) {
      console.log(`[${new Date().toISOString()}] no-triage marker present, skipping decomposition`);
    } else {
      const decision = await triageCheck(text, EXHAUSTED_PAYLOAD_FACT).catch(() => ({ split: false }));
      if (decision.split) {
        const subtaskIds = await triageSplit(task, decision).catch(() => null);
        if (subtaskIds && subtaskIds.length > 0) {
          console.log(`[${new Date().toISOString()}] re-decomposed into ${subtaskIds.length} subtasks because all providers rejected the payload`);
          return { decomposed: true, subtaskIds, decomposeReason: "capacity-exhausted" };
        }
      }
    }
  }
  const finalError = redactSecrets(String(lastErr?.message || lastErr || "unknown error"));
  await escalateToFounder(process.env.TASK_ID, finalError, provider).catch(() => {});
  const diag = await diagnose(text, attemptLog).catch(() => null);
  const structuredLastErr = createStructuredError(lastErr, {
    provider,
    allProvidersExhausted: true,
    taskId: task?.id,
  });
  const base = `код ${lastErr?.code ?? structuredLastErr.code ?? "?"}: ${msg.split("\n")[0]}`;
  return {
    success: false,
    message: truncate(diag ? `${base}\n\n${diag.line}` : base),
    permanent: diag ? diag.permanent : false,
    error: structuredLastErr.toJSON(),
  };
}

async function notifyTelegram(chatId, message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: redactSecrets(message) })
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] notifyTelegram failed: ${redactSecrets(err?.message || err)}`);
  }
}

/**
 * Эскалация фаундеру при исчерпании лимитов/зацикливании.
 * Вызывается когда все провайдеры исчерпаны или обнаружен loop.
 */
async function escalateToFounder(taskId, error, provider) {
  const founderChatId = "1568126"; // founder's personal Telegram chat_id
  const msg = `🚨 ЭСКАЛЯЦИЯ: задача ${taskId} провалилась на ${provider}\nОшибка: ${error}\nВсе провайдеры исчерпаны или зациклены.`;
  await notifyTelegram(founderChatId, msg);
}

/**
 * Initializes chat_alerts table in database if it does not exist.
 */
async function initChatAlertsTable(db = client) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS chat_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      task TEXT NOT NULL,
      from_provider TEXT,
      to_provider TEXT,
      error TEXT,
      details TEXT
    )
  `);
}

/**
 * Writes a structured alert record to chat_alerts table and logs it.
 * Redacts secrets before persistence and output.
 */
async function writeChatAlert(alert, db = client) {
  const ts = alert.ts || new Date().toISOString();
  const type = String(alert.type || "failure");
  const task = String(alert.task || "");
  const from = alert.from ?? null;
  const to = alert.to ?? null;
  const error = alert.error ? redactSecrets(String(alert.error)) : null;
  const details = alert.details ? redactSecrets(String(alert.details)) : null;

  try {
    await initChatAlertsTable(db);
    await db.execute({
      sql: "INSERT INTO chat_alerts (ts, type, task, from_provider, to_provider, error, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [ts, type, task, from, to, error, details],
    });
  } catch (err) {
    console.error(`[${ts}] writeChatAlert failed: ${redactSecrets(err?.message || err)}`);
  }

  const alertJson = { ts, type, task, from, to, error, details };
  console.log(`[${ts}] [chat_alert] ${JSON.stringify(alertJson)}`);
  return { success: true, alert: alertJson };
}

/**
 * Extracts failed plugin names from dsh startup/container logs.
 */
function parseFailedPlugins(log) {
  const text = String(log || "");
  const plugins = new Set();
  const patterns = [
    /plugin\(s\)\s+failed to load:\s*(\S+)/g,
    /plugin tree failed to load:\s*(\S+)/g,
    /Failed to load plugin:\s*(\S+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      plugins.add(m[1].trim());
    }
  }
  return [...plugins];
}

/**
 * Smoke check of dsh headless profile initialization beyond `dsh --version`.
 * Spawns an actual dsh container with a patch to confirm plugin attachments.
 */
async function smokeCheckProfile(options = {}) {
  const provider = options.provider || "nvidia";
  const model = options.model || (PROVIDER_CONFIG[provider]?.model || "default-model");
  const patchContent = `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${model}\n`;
  const patchFile = path.join(os.tmpdir(), `dsh-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
  await writeFile(patchFile, patchContent, "utf-8");

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("dsh", ["--profile", "headless", "--patch", patchFile, "boot check"], {
        cwd: WORKDIR,
        env: {
          ...process.env,
          DSH_PERMISSION_MODE: "danger-full-access",
          DSH_PROXY_DUMMY_KEY: "unused",
        },
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new StructuredError("smokeCheckProfile timed out", {
          code: ERROR_CODES.TIMEOUT_LOOP,
          category: "bootstrap",
          context: { provider, model, timeoutMs: 30000 },
          recoveryHint: RECOVERY_HINTS.INSPECT_LOGS,
        }));
      }, 30000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => (err += d));

      child.on("close", (code) => {
        clearTimeout(timer);
        const combined = `${out}\n${err}`;
        const failedPlugins = parseFailedPlugins(combined);
        if (failedPlugins.length > 0) {
          const e = new StructuredError(`plugin(s) failed to load: ${failedPlugins.join(", ")}`, {
            code: ERROR_CODES.BOOTSTRAP_FAILURE,
            category: "bootstrap",
            context: { provider, failedPlugins, exitCode: code },
            recoveryHint: RECOVERY_HINTS.INSPECT_LOGS,
            failedPlugins,
          });
          e.failedPlugins = failedPlugins;
          return reject(e);
        }
        if (/Cordis startup failed/i.test(combined) || /Error initializing profile/i.test(combined)) {
          // CLOUD-MAINT-c-e-progress-loop-distinction-b--c, 2026-10-13: dsh
          // raw output is secret-capable (provider/config errors echo
          // request or auth details) - mask at capture time, same as
          // runDshOnce does for its own dsh output, before this Error
          // text can reach any logging or print.
          return reject(new StructuredError(`Cordis profile startup failed: ${redactSecrets(err || out)}`, {
            code: ERROR_CODES.BOOTSTRAP_FAILURE,
            category: "bootstrap",
            context: { provider, exitCode: code },
            recoveryHint: RECOVERY_HINTS.INSPECT_LOGS,
          }));
        }
        if (code === 0 || /AUTH|Unauthorized|401/i.test(combined)) {
          return resolve({ ok: true, status: "initialized" });
        }
        if (code !== 0) {
          // CLOUD-MAINT-c-e-progress-loop-distinction-b--c, 2026-10-13: same
          // capture-time masking as above - raw dsh stderr must not travel
          // into an Error that later gets logged or printed unmasked.
          const e = new StructuredError(`dsh smoke check exited ${code}: ${redactSecrets(err.slice(-500))}`, {
            code: ERROR_CODES.BOOTSTRAP_FAILURE,
            category: "bootstrap",
            context: { provider, exitCode: code, failedPlugins },
            recoveryHint: RECOVERY_HINTS.INSPECT_LOGS,
            failedPlugins,
          });
          e.failedPlugins = failedPlugins;
          return reject(e);
        }
        resolve({ ok: true, status: "initialized" });
      });

      child.on("error", (e) => {
        clearTimeout(timer);
        reject(createStructuredError(e, { provider, category: "bootstrap" }));
      });
    });
  } finally {
    await unlink(patchFile).catch(() => {});
  }
}

/**
 * Checks homogeneity of @deepseek-ai npm package versions to prevent task 64 regressions.
 */
function verifyDshTreeHomogeneity(rootPath) {
  const scopeDir = path.join(rootPath, "@deepseek-ai");
  if (!existsSync(scopeDir)) {
    return { ok: true, coreVersion: null, mismatches: [] };
  }
  const corePkgJson = path.join(scopeDir, "dsh", "package.json");
  if (!existsSync(corePkgJson)) {
    return { ok: true, coreVersion: null, mismatches: [] };
  }
  let coreVersion = null;
  try {
    const parsed = JSON.parse(readFileSync(corePkgJson, "utf-8"));
    coreVersion = parsed.version;
  } catch {
    return { ok: false, coreVersion: null, mismatches: ["unreadable core package.json"] };
  }

  const mismatches = [];
  try {
    const entries = readdirSync(scopeDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === "dsh") continue;
      const pkgPath = path.join(scopeDir, ent.name, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkgData = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkgData.version && pkgData.version !== coreVersion) {
            mismatches.push(`@deepseek-ai/${ent.name}@${pkgData.version}`);
          }
        } catch {}
      }
    }
  } catch {}

  return {
    ok: mismatches.length === 0,
    coreVersion,
    mismatches,
  };
}

/**
 * High-level bootstrap verification helper.
 */
async function verifyBootstrap(options = {}) {
  const smoke = await smokeCheckProfile(options);
  return {
    ok: smoke.ok,
    profileBooted: true,
    pluginsOk: true,
    status: smoke.status,
  };
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

// 2026-10-04: real gap found via task 64 (runs 37178108573, 37214241683) -
// the triage decision was made on the task TEXT alone (task 64: 2179 chars,
// ~550 tokens) while the real work prompt carries dsh's own AGENTS.md
// auto-load (maxBytes 32768, ~8K tokens) plus the agent tool schema - the
// part that actually blows the provider ceiling (groq on-demand TPM 8000;
// run 37214241683: groq 413, Requested 12457). The triage model could not
// see any of that, so a coherent-but-too-big brief was judged "one unit"
// (verified live: {"split": false}, HTTP 200, 1666 tokens) and never split.
// The facts below are passed into every triage call so the decision is made
// with the real numbers in view. Founder's own choice, 2026-10-04: amend the
// prompt and pass the fact, not a forced split.
const CLAIM_TIME_PAYLOAD_FACT = "Полный промпт работы - это НЕ только текст задачи ниже: dsh автозагружает AGENTS.md (maxBytes 32768, примерно 8K токенов) и добавляет схему инструментов агента; полный промпт примерно на 8-10K токенов больше самого текста задачи. Ориентир лимита: groq on-demand TPM 8000 токенов на запрос.";
const EXHAUSTED_PAYLOAD_FACT = CLAIM_TIME_PAYLOAD_FACT + "\nВСЕ провайдеры очереди уже отвергли полный payload этой задачи целиком: groq вернул 413 (payload too large), nvidia и mistral - rate limit, google - 400. Ни один бесплатный провайдер не примет этот payload одним вызовом. Дробление на подзадачи - единственный оставшийся путь выполнить задачу.";

// 2026-10-07, [NO-TRIAGE] marker: a task whose text carries "[NO-TRIAGE]"
// declares itself leaf-level and is NEVER decomposed - not at claim time,
// not on provider exhaustion. Fixes the real non-converging cascade (tasks
// 89-107 over 11 dispatches, 9 of them triage splits): single-step "read X,
// extract Y" tasks kept being split into 2-3 subtasks that were themselves
// split again. The marker is the task author's own declaration that the
// task is already one unit. Deliberately NOT gating the timeout-progress
// re-decomposition path - that is a different failure mode (real progress
// cut off by a timeout) and has not produced a cascade.
function hasNoTriageMarker(text) {
  return typeof text === "string" && text.includes("[NO-TRIAGE]");
}

const TRIAGE_PROMPT = `Задача ниже написана как ОДНА единица работы для агента, но выглядит большой или упоминает несколько разных файлов/шагов. Оцени честно: это реально одна связная единица, или несколько независимых шагов, каждый из которых можно сделать и проверить отдельно?

Целевой размер каждой подзадачи - то, что один вызов модели может реально выполнить без превышения лимита провайдера по токенам (ориентир - несколько тысяч токенов на весь промпт, не десятки тысяч).

Если ОДНА связная единица и её ПОЛНЫЙ промпт работы укладывается в лимит провайдера (см. ФАКТ О РАЗМЕРЕ PAYLOAD ниже, когда он есть) - ответь ровно: {"split": false}. Если ФАКТ О РАЗМЕРЕ PAYLOAD прямо говорит, что полный промпт НЕ укладывается в лимит (все провайдеры уже отвергли payload целиком) - дели, даже если текст задачи связный: связность текста не делает задачу выполнимой одним вызовом модели.

Если ниже приведён блок "ФАКТ О РАЗМЕРЕ PAYLOAD" - это проверенный факт, не оценка: реальные цифры полного промпта (текст задачи + автозагружаемый dsh AGENTS.md + схема инструментов) и реального лимита провайдера. Учитывай его наравне с текстом задачи.

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
async function triageCheck(text, payloadFact) {
  const provider = PROVIDER_ORDER[0];
  const cfg = PROVIDER_CONFIG[provider];
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return { split: false };
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      // 2026-10-04: the payload fact (when given) sits between the prompt's
      // own instructions and the task text - the model decides with the real
      // numbers in view, not on the brief's size alone.
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: TRIAGE_PROMPT + (payloadFact ? `ФАКТ О РАЗМЕРЕ PAYLOAD (проверен, не оценка):\n${payloadFact}\n\n---\n` : "") + text }] }),
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
    console.log(`[${new Date().toISOString()}] triage check failed (${redactSecrets(err.message)}), proceeding as one unit (fail-safe)`);
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
// 2026-10-11, PLEXUS-S13-UNBLOCK: не дробить глубже 2 уровней.
// Ребёнок ребёнка редко становится leaf-level; цепочки растут, ни
// один лист не достигается (rope-asymmetry: 11 диспатчей → 9 сплитов
// → 1 результат). Если это ребёнок — не дробить, выполнять как есть.
async function triageSplit(parentTask, decision) {
  // Вычисляем глубину сплита: парсим [SIB i/n parent:P] из текста родителя
  // и рекурсивно считаем предков через БД.
  let depth = 0;
  const parentInfo = extractParentAndSiblingInfo(parentTask, parentTask.text);
  if (parentInfo && parentInfo.parentId) {
    let currentParentId = parentInfo.parentId;
    while (currentParentId) {
      depth++;
      if (depth >= 2) break;
      const res = await client.execute({
        sql: "SELECT text FROM tasks WHERE id = ?",
        args: [currentParentId],
      });
      if (!res.rows.length) break;
      const info = extractParentAndSiblingInfo(null, res.rows[0].text);
      if (!info || !info.parentId) break;
      currentParentId = info.parentId;
    }
  }
  if (depth >= 2) {
    console.log(`[${new Date().toISOString()}] TRIAGE: depth ${depth} reached, not splitting further`);
    return { split: false, ids: [] };
  }

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

export {
  runCommand,
  isLongComputeJob,
  isResumeJob,
  extractResumeFrom,
  extractCommand,
  parseDuration,
  extractJobCap,
  getEffectiveTimeout,
  savePartialArtifact,
  uploadTaskCheckpointsAndArtifacts,
  findLatestCheckpoint,
  executeResume,
  extractParentAndSiblingInfo,
  checkTreeCompletion,
  executeLongCompute,
  doWork,
  run,
  claimTask,
  loadTursoCredentials,
  redactSecrets,
  installSecretRedactionHook,
  notifyTelegram,
  escalateToFounder,
  checkoutTaskBranch,
  pushTaskArtifacts,
  triageSplit,
  triageCheck,
  hasNoTriageMarker,
  diagnose,
  parseDiagnosis,
  DIAGNOSE_VERDICTS,
  PERMANENT_VERDICTS,
  // Provider contracts
  PROVIDER_ORDER,
  PROVIDER_CONFIG,
  CAPACITY_RE,
  nextProvider,
  runDshOnce,
  parseDshStructuredError,
  resolveVertexBaseURL,
  client,
  // From sibling-parser.mjs (re-exported)
  parseSiblingMarker,
  buildSiblingMarker,
  makeSiblingOrderOk,
  siblingOrderOk,
  // Progress vs Loop & Stuck detection
  classifyProgressVsLoop,
  classifyTimeoutKill,
  detectLoop,
  detectStuckTask,
  TASK_STATUSES,
  EXECUTION_EVENTS,
  // Chat alerts
  initChatAlertsTable,
  writeChatAlert,
  // Structured error handling
  StructuredError,
  createStructuredError,
  ERROR_CODES,
  RECOVERY_HINTS,
  // Bootstrap & plugin verification
  parseFailedPlugins,
  smokeCheckProfile,
  verifyDshTreeHomogeneity,
  verifyBootstrap,
};

if (process.argv[1] && process.argv[1].endsWith('executor.mjs')) {
  run().catch((err) => {
    console.error(redactSecrets(err?.stack || err?.message || err));
    process.exit(1);
  });
}
