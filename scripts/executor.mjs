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
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const client = createClient({ url: process.env.TURSO_DATABASE_URL || "file::memory:", authToken: process.env.TURSO_AUTH_TOKEN });

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

  const directiveLineRe = /^\s*(?:job[_-]?cap|computation[_-]?duration|compute[_-]?duration|long[_-]?compute|is_long_compute|resume|is_resume|resume[_-]?from|parent[_-]?id|parent|job[_-]?type|type|lane|timeout)\s*[:=].*$/i;

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
    cmd = cmd.split('\n').filter(l => !directiveLineRe.test(l)).join('\n').trim();
    return cmd;
  }

  // Handle case where directives precede the prefix (e.g. "job_cap: 30m\nRUN_COMMAND: ./sim")
  const lines = trimmed.split('\n');
  const nonDirectiveLines = lines.filter(l => !directiveLineRe.test(l));
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
    return cleanedBracketMatch[2].trim();
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

  // 1. Write raw stderr log
  const stderrContent = String(data.stderr || '(no stderr captured)');
  await writeFile(stderrPath, stderrContent, 'utf-8');

  // 2. Write partial stdout log if present
  if (stdoutPath && data.stdout) {
    await writeFile(stdoutPath, String(data.stdout), 'utf-8');
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
    command: data.command || null,
    stderr: stderrContent.slice(0, 10000),
    stderr_file: stderrFileName,
    stdout_preview: (data.stdout || '').slice(0, 10000),
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
    console.log(`[${new Date().toISOString()}] ARTIFACT_UPLOAD: FAILED - ${err.message}`);
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
    let isPartial = latest.file.includes('partial');

    if (latest.file.endsWith('.json')) {
      try {
        const raw = await readFile(latest.path, 'utf-8');
        data = JSON.parse(raw);
        if (data.is_partial !== undefined) isPartial = Boolean(data.is_partial);
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
    console.log(`[${new Date().toISOString()}] CHECKPOINT: error finding checkpoint in ${dir}: ${err.message}`);
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
 * Extracts parent and sibling information from task object or text.
 * Handles [SIB i/n parent:P] format, parent_id directives, and task metadata.
 *
 * @param {object} [task]
 * @param {string} [text]
 * @returns {{parentId: number, index: number, total: number|null}|null}
 */
function extractParentAndSiblingInfo(task, text) {
  const content = (text || task?.text || '').trim();
  const sib = parseSiblingMarker(content);
  if (sib) return sib;

  let parentId = task?.parent_id || task?.parentId || null;
  let total = task?.total_siblings || task?.sibling_count || null;
  let index = task?.sibling_index || task?.subtask_index || null;

  if (task?.metadata) {
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
      if (!parentId && (meta.parent_id || meta.parentId)) parentId = Number(meta.parent_id || meta.parentId);
      if (!total && (meta.total_siblings || meta.total)) total = Number(meta.total_siblings || meta.total);
      if (!index && (meta.sibling_index || meta.index)) index = Number(meta.sibling_index || meta.index);
    } catch {}
  }

  if (!parentId) {
    const parentMatch = content.match(/(?:^|\n|\s|\[)(?:parent[_-]?id|parent)[:\s=]+(\d+)/i);
    if (parentMatch) {
      parentId = Number(parentMatch[1]);
    }
  }

  if (parentId) {
    return { parentId: Number(parentId), index: Number(index) || 1, total: total ? Number(total) : null };
  }
  return null;
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
        sql: "SELECT id, status, text, result FROM tasks WHERE text LIKE ? OR text LIKE ?",
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
      console.log(`[${new Date().toISOString()}] TREE_COMPLETION: parent check error: ${err.message}`);
    }
    return { treeComplete: false, reason: "not_in_tree" };
  }

  const parentId = info.parentId;
  const expectedTotal = info.total;

  try {
    const sibRes = await db.execute({
      sql: "SELECT id, status, text, result FROM tasks WHERE text LIKE ? OR text LIKE ?",
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
    console.log(`[${new Date().toISOString()}] TREE_COMPLETION: error: ${err.message}`);
    return { treeComplete: false, parentId, error: err.message };
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
      compArtifact = {
        task_id: taskId,
        status: 'complete',
        is_partial: false,
        is_complete: true,
        exit_code: 0,
        stdout: cmdResult.stdout,
        stderr: cmdResult.stderr,
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

  // Mark as running
  await client.execute({ sql: 'UPDATE tasks SET status = ?, actions_run_id = ? WHERE id = ?', args: ['выполняется', process.env.GITHUB_RUN_ID, taskId] });

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
      console.log(`[${new Date().toISOString()}] TREE_COMPLETION: check error: ${treeErr.message}`);
    }
  }

  // Notify via Telegram to creator
  await notifyTelegram(task.creator_id, `Задача ${taskId} ${status}: ${result.message}`);

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
    console.log(`[${new Date().toISOString()}] push: FAILED - ${err.message}`);
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
//
// 2026-09-15 (CONFIG-ENRICH-b): added Google (Gemini API) and Vertex AI
// as fallback pair - Google quota errors (RESOURCE_EXHAUSTED, quota
// exceeded) trigger auto-switch to Vertex. Both use native Google SDK
// compatible endpoints, not litellm prefixes.
const PROVIDER_ORDER = ["groq", "nvidia", "mistral", "google", "vertex"];
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
const CAPACITY_RE = /MidStreamFallbackError|ServiceUnavailableError|No deployments available|RateLimitError|RATE_LIMIT|rate_limit_exceeded|Service temporarily overloaded|APIConnectionError|ECONNREFUSED|Connection error|high demand|UNAVAILABLE|hook dispatch failed|operation timed out|timed out after|RESOURCE_EXHAUSTED|quota exceeded|429|rate limit/i;

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
    const union = new Set([...wa, [...wb]]).size;
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
        const timeoutErr = new Error("dsh timed out after 8min");
        // TIMECEIL-CLOUD, 2026-09-14: real classification, not just a
        // boolean - "progress" routes to re-decomposition below instead
        // of a same-task model-swap retry.
        // 2026-10-04: real bug found via run 37178108573 (task 64, nvidia
        // attempt ran the full 8 minutes) - this classified `out` (stdout),
        // but the "dsh: reasoning:" markers never appear on stdout: dsh
        // writes them to stderr and the final answer to stdout (verified in
        // the installed package). stdout therefore held one blob with no
        // markers, classifyTimeoutKill saw <2 segments and returned "loop"
        // by its own `segs.length < 2` default - the re-decomposition branch
        // below was unreachable dead code, and every timeout rotated
        // providers instead of splitting a genuinely progressing task. The
        // classifier is fed the reasoning stream now.
        timeoutErr.timeoutVerdict = classifyTimeoutKill(reasoning);
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
      // 2026-10-04: the reasoning stream for the timeout classifier - see the
      // comment above the `reasoning` declaration. Tail-capped, not head-capped.
      child.stderr.on("data", (d) => {
        reasoning += d;
        if (reasoning.length > MAX_OUTPUT) reasoning = reasoning.slice(-MAX_OUTPUT);
      });
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
    console.log(`[${new Date().toISOString()}] RUN_COMMAND: executing ${command} (standard 5-minute timeout)`);
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
  // Все провайдеры исчерпаны
  const msg = String(lastErr?.message || lastErr || "unknown error");
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
  if (CAPACITY_RE.test(msg) && task) {
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
  const finalError = String(lastErr?.message || lastErr || "unknown error");
  await escalateToFounder(process.env.TASK_ID, finalError, provider).catch(() => {});
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

/**
 * Эскалация фаундеру при исчерпании лимитов/зацикливании.
 * Вызывается когда все провайдеры исчерпаны или обнаружен loop.
 */
async function escalateToFounder(taskId, error, provider) {
  const founderChatId = "1568126"; // founder's personal Telegram chat_id
  const msg = `🚨 ЭСКАЛЯЦИЯ: задача ${taskId} провалилась на ${provider}\nОшибка: ${error}\nВсе провайдеры исчерпаны или зациклены.`;
  await notifyTelegram(founderChatId, msg);
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
  run
};

if (process.argv[1] && process.argv[1].endsWith('executor.mjs')) {
  run().catch(console.error);
}
