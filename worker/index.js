/**
 * Telegram -> queue. No Node dependency: every remote call is a plain
 * fetch() - Telegram's Bot API, Turso's HTTP API
 * (docs.turso.tech/sdk/http/reference, /v2/pipeline), GitHub's REST API.
 *
 * /accept <id> is implemented in scripts/accept-and-merge.mjs and shared with
 * the Node CLI by design: one acceptance path, not two that can drift (the same
 * reason the gate itself is one mechanism across repos). It writes 'принята'
 * first, then kicks merge-pending.yml through GitHub's workflow_dispatch,
 * because a GitHub cron on a free account is hours of silence (S15).
 *
 * Telegram does NOT read the webhook's HTTP response body as a chat message -
 * that body is only an acknowledgement. Replying to the user requires calling
 * sendMessage explicitly. Neither this file's first version nor the one
 * before it did that, which is why the bot answered the browser's getMe but
 * stayed silent in the chat.
 *
 * Always ack Telegram with 200 once an update has been read, success or
 * failure - a non-200 makes Telegram retry the same update later, which piles
 * up as duplicate work instead of a clean failure. Errors are reported to the
 * user via sendMessage instead: silence must not be ambiguous, same rule the
 * local queue's own notifications follow.
 */

import { acceptAndMergeTask } from '../scripts/accept-and-merge.mjs';

export default {
  async fetch(request, env) {
    const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, GITHUB_DISPATCH_TOKEN } = env;

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('ok', { status: 200 });
    }
    if (!body.message) return new Response('ok', { status: 200 });

    const { chat, text, from } = body.message;
    const chatId = chat?.id;
    const userId = from?.id;

    // Log LENGTHS only, never a raw env value - including TELEGRAM_ALLOWED_USER_ID,
    // which is meant to be a small non-secret number but must not be trusted to
    // stay that way. It was set to a bot-token-shaped string by mistake on
    // 2026-08-22 and logging it in full put a live token in plaintext into
    // wrangler tail output, which then landed in chat when pasted for
    // debugging. incoming userId is safe: it is Telegram's own account id for
    // whoever is messaging right now, not a secret.
    console.log(
      `env check: TELEGRAM_BOT_TOKEN len=${(TELEGRAM_BOT_TOKEN || '').length} ` +
      `TURSO_DATABASE_URL len=${(TURSO_DATABASE_URL || '').length} ` +
      `TURSO_AUTH_TOKEN len=${(TURSO_AUTH_TOKEN || '').length} ` +
      `ALLOWED_USER_ID len=${(TELEGRAM_ALLOWED_USER_ID || '').length} ` +
      `GITHUB_DISPATCH_TOKEN len=${(GITHUB_DISPATCH_TOKEN || '').length} ` +
      `incoming userId=${userId} chatId=${chatId}`,
    );

    if (String(userId) !== String(TELEGRAM_ALLOWED_USER_ID)) {
      console.log('DROPPED: userId does not match TELEGRAM_ALLOWED_USER_ID');
      return new Response('ok', { status: 200 });
    }
    if (typeof text !== 'string' || !chatId) return new Response('ok', { status: 200 });

    const db = turso(TURSO_DATABASE_URL, TURSO_AUTH_TOKEN);

    try {
      console.log(`handling text=${JSON.stringify(text)}`);
      if (text.startsWith('/task ')) {
        const taskText = text.slice(6).trim();
        const taskId = await createTask(db, taskText, userId);
        await triggerDispatcher(GITHUB_DISPATCH_TOKEN, taskId);
        await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `Задача создана с ID ${taskId}`);
      } else if (text.startsWith('/accept ')) {
        // Acceptance: the founder's decision, then the merge immediately
        // (S15 - cron on a free account is not a timer). Everything after the
        // status write is the same code path as the CLI.
        const id = Number(text.slice(8).trim());
        if (!Number.isInteger(id) || id <= 0) {
          await sendMessage(TELEGRAM_BOT_TOKEN, chatId, 'Использование: /accept <id задачи>');
          return new Response('ok', { status: 200 });
        }
        const result = await acceptAndMergeTask({
          taskId: id,
          db: { httpUrl: db.httpUrl, authToken: TURSO_AUTH_TOKEN },
          token: GITHUB_DISPATCH_TOKEN,
          repo: (env.GITHUB_REPOSITORY || env.ACCEPT_MERGE_REPO || 'stmooooore-lang/queue-engine'),
          fetchImpl: fetch,
        });
        const prefix = result.code === 'ALREADY-DONE'
          ? `Задача ${id} уже ${'готова'} - принимать нечего.`
          : result.ok
            ? `Задача ${id}: принята. ${result.dispatched ? 'Мерж-процесс запущен сразу (workflow_dispatch).' : 'Мерж отдаётся cron (*/5) - немедленный триггер не сработал, причина в логе.'}`
            : `Принять задачу ${id} не получилось: ${result.reason}`;
        await sendMessage(TELEGRAM_BOT_TOKEN, chatId, prefix);
      } else if (text === '/status') {
        const tasks = await getLastFiveTasks(db);
        await sendMessage(TELEGRAM_BOT_TOKEN, chatId, formatTasks(tasks));
      } else if (text === '/start') {
        await sendMessage(TELEGRAM_BOT_TOKEN, chatId, 'Готов. /task <текст> — поставить задачу. /status — последние пять. /accept <id> — принять задачу и сразу запустить мерж. Любой обычный текст также создаёт задачу.');
      } else if (text.startsWith('/')) {
        // Unknown command - ignore silently but log
        console.log(`Unknown command: ${text}`);
      } else {
        // Plain text message - create a task for conversational continuity.
        // No "task created" text here: a typing indicator instead, so this
        // reads as a chat and not as filing a ticket. /task keeps the ID
        // reply on purpose - that's the explicit, track-it-via-/status path.
        await sendTyping(TELEGRAM_BOT_TOKEN, chatId);
        const taskId = await createTask(db, text, userId);
        await triggerDispatcher(GITHUB_DISPATCH_TOKEN, taskId);
        console.log(`plain-text task created, id=${taskId}`);
      }
    } catch (err) {
      console.error(`HANDLER ERROR: ${err.message}`, err.stack);
      await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `Ошибка: ${err.message}`).catch((e2) => {
        console.error(`ALSO FAILED to notify the user: ${e2.message}`);
      });
    }

    return new Response('ok', { status: 200 });
  },
};

// --- GitHub Actions dispatch ---

/**
 * Kick the dispatcher the moment a task exists, instead of waiting for
 * something else to happen.
 *
 * REVERT OF 6d55666, decided 2026-11-09 by the founder. That commit dropped
 * this exact call ("bot no longer dispatches GitHub Actions on new tasks, VM
 * poller is the only executor") and dispatcher.yml was moved to a
 * workflow_run trigger on Task Executor. Two things broke in sequence:
 *
 *   1. The VM poller that 6d55666 relied on has no workflow in the repo at
 *      all (`gh workflow list` shows no poller/vm/gcp job) - so the "only
 *      executor" of that decision was not running.
 *   2. workflow_run alone cannot START a queue: with an empty queue there is
 *      no Task Executor run to complete, so the dispatcher never fires, so a
 *      task INSERTed straight into Turso waits forever. Plexus reported
 *      exactly this stall.
 *
 * Cron was restored 2026-11-09 as a fallback (commit f687909) and measured
 * badly: it fired 4 times and then left a 7-hour hole - GitHub throttles
 * scheduled workflows on the free tier, which the "5-hour worst case" note
 * in dispatcher.yml had understated. So the immediate dispatch is back as the
 * primary path; cron and workflow_run stay as fallbacks only.
 *
 * Best-effort by design, and that is load-bearing:
 *   - if the token is absent (not yet set in Cloudflare), this no-ops with a
 *     log line rather than calling GitHub with `Bearer undefined` (401 noise);
 *   - any failure - network, 401, 403, 422, 404 - is caught and logged, and
 *     task creation is never blocked or reported as failed because of it. The
 *     task is already safely in Turso by the time this runs; dispatch is an
 *     accelerator, not part of the insert's correctness.
 * The dispatcher itself dedupes: it refuses to dispatch another executor run
 * while one is in flight, so several tasks arriving at once cause no pileup.
 *
 * @param {string} githubToken - PAT with queue-engine Actions read/write.
 * @param {number|string} taskId - for the log line only; dispatcher.yml takes
 *   no inputs - dispatcher.mjs scans Turso and picks the task itself.
 */
async function triggerDispatcher(githubToken, taskId) {
  try {
    if (!githubToken) {
      console.log('dispatch: GITHUB_DISPATCH_TOKEN not set in env, skipping (task stays queued for cron/workflow_run)');
      return;
    }
    const res = await fetch(
      'https://api.github.com/repos/stmooooore-lang/queue-engine/actions/workflows/dispatcher.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Cloudflare-Worker',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );
    if (res.ok) {
      console.log(`dispatch: dispatcher.yml triggered after task ${taskId} (${res.status})`);
      return;
    }
    console.log(`dispatch: FAILED for task ${taskId} - ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.log(`dispatch: FAILED for task ${taskId} - ${err.message}`);
  }
}

// --- Telegram, plain Bot API ---

async function sendMessage(botToken, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await res.text();
  console.log(`sendMessage -> ${res.status}: ${body.slice(0, 200)}`);
  if (!res.ok) throw new Error(`telegram sendMessage ${res.status}: ${body}`);
}

// A queue-ID acknowledgement on every plain message reads as a task tracker,
// not a chat. Telegram's native "typing" indicator gives the same "received
// it" feedback without surfacing the queue's own bookkeeping - it fades on
// its own in a few seconds, no follow-up call needed. Best-effort: a failure
// here must never block the real work of queuing the task.
async function sendTyping(botToken, chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch (err) {
    console.log(`sendChatAction failed (non-fatal): ${err.message}`);
  }
}

// --- Turso, over its documented HTTP API ---

function turso(databaseUrl, authToken) {
  return { httpUrl: databaseUrl.replace(/^libsql:\/\//, 'https://'), authToken };
}

function arg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number' && Number.isInteger(v)) return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}

async function execute(db, sql, args = []) {
  const res = await fetch(`${db.httpUrl}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${db.authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(arg) } }, { type: 'close' }] }),
  });
  if (!res.ok) throw new Error(`turso ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const first = data.results[0];
  if (first.type === 'error') throw new Error(`turso: ${first.error?.message || JSON.stringify(first)}`);
  return first.response.result;
}

function rowsAsObjects(result) {
  const names = result.cols.map((c) => c.name);
  return result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]?.value ?? null])));
}

async function createTask(db, text, creatorId) {
  const result = await execute(db, 'INSERT INTO tasks (text, status, creator_id, lane) VALUES (?, ?, ?, ?)', [text, 'ожидает', creatorId, 'architect']);
  return result.last_insert_rowid;
}

async function getLastFiveTasks(db) {
  return rowsAsObjects(await execute(db, 'SELECT id, text, status FROM tasks ORDER BY created_at DESC LIMIT 5'));
}

async function getCurrentTask(db, userId) {
  const rows = rowsAsObjects(await execute(
    db,
    'SELECT id FROM tasks WHERE creator_id = ? AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1',
    [userId, 'ожидает', 'выполняется'],
  ));
  return rows[0];
}

async function addDialogMessage(db, taskId, message) {
  await execute(db, 'INSERT INTO dialog_messages (task_id, message_text) VALUES (?, ?)', [taskId, message]);
}

function formatTasks(tasks) {
  if (!tasks.length) return 'Задач пока нет';
  return tasks.map((t) => `Задача ${t.id}: ${t.text} (${t.status})`).join('\n');
}
