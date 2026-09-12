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
 * The task text becomes one dsh turn against plexus/ - real capacity-shaped
 * failures rotate to the next real provider (Groq -> NVIDIA -> Mistral),
 * same real mechanism verified tonight in worker/rotation.js.
 */
async function doWork(text) {
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
      if (!CAPACITY_RE.test(msg)) {
        const diag = await diagnose(text, attemptLog).catch(() => null);
        const base = `код ${err.code ?? "?"}: ${msg.split("\n")[0]}`;
        return { success: false, message: truncate(diag ? `${base}\n\n${diag}` : base) };
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
  return { success: false, message: truncate(diag ? `${base}\n\n${diag}` : base) };
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
async function triageSplit(parentTask, decision) {
  const ids = [];
  for (const st of decision.subtasks) {
    const res = await client.execute({
      sql: "INSERT INTO tasks (text, status, creator_id, lane) VALUES (?, ?, ?, ?)",
      args: [`[${st.title}] ${st.text}`, "ожидает", parentTask.creator_id, parentTask.lane || "architect"],
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
    return line;
  } catch {
    return null;
  }
}

run().catch(console.error);
