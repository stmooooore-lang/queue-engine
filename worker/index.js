/**
 * Telegram -> queue. No Node dependency of any kind: wrangler's bundler
 * failed to build this file when it pulled in @octokit/core and
 * @libsql/client, whose Node builds reach for child_process, fs, path and
 * node:buffer - none of which exist in the Workers runtime, and the message
 * ("Your worker has no default export... Did you mean to create an ES Module
 * format Worker?") came from a further mismatch: the file used CommonJS
 * `require`/`exports.default` in what wrangler treats as an ES module entry.
 *
 * Every remote call here is a plain fetch(): Turso's own HTTP API
 * (https://docs.turso.tech/sdk/http/reference) and GitHub's REST API. No
 * library, no build-time surprise.
 */

export default {
  async fetch(request, env) {
    const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TELEGRAM_ALLOWED_USER_ID, GITHUB_TOKEN } = env;

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!body.message) return new Response('ok', { status: 200 }); // non-message updates: ack, ignore

    const { text, from } = body.message;
    const userId = from?.id;

    if (String(userId) !== String(TELEGRAM_ALLOWED_USER_ID)) {
      return new Response('Unauthorized', { status: 403 });
    }
    if (typeof text !== 'string') return new Response('ok', { status: 200 });

    const db = turso(TURSO_DATABASE_URL, TURSO_AUTH_TOKEN);

    if (text.startsWith('/task ')) {
      const taskText = text.slice(6).trim();
      const taskId = await createTask(db, taskText, userId);
      await triggerWorkflow(taskId, GITHUB_TOKEN);
      return new Response(`Задача создана с ID ${taskId}`, { status: 200 });
    }
    if (text === '/status') {
      const tasks = await getLastFiveTasks(db);
      return new Response(formatTasks(tasks), { status: 200 });
    }
    const currentTask = await getCurrentTask(db, userId);
    if (currentTask) {
      await addDialogMessage(db, currentTask.id, text);
      return new Response('Сообщение добавлено в диалог задачи', { status: 200 });
    }
    return new Response('Нет активной задачи', { status: 200 });
  },
};

// --- Turso, over its documented HTTP API - no @libsql/client ---

function turso(databaseUrl, authToken) {
  const httpUrl = databaseUrl.replace(/^libsql:\/\//, 'https://');
  return { httpUrl, authToken };
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
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args: args.map(arg) } },
        { type: 'close' },
      ],
    }),
  });
  if (!res.ok) throw new Error(`turso ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const first = data.results[0];
  if (first.type === 'error') throw new Error(`turso: ${first.error?.message || JSON.stringify(first)}`);
  return first.response.result; // { cols, rows, last_insert_rowid }
}

function rowsAsObjects(result) {
  const names = result.cols.map((c) => c.name);
  return result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]?.value ?? null])));
}

async function createTask(db, text, creatorId) {
  const result = await execute(
    db,
    'INSERT INTO tasks (text, status, creator_id) VALUES (?, ?, ?)',
    [text, 'ожидает', creatorId],
  );
  return result.last_insert_rowid;
}

async function getLastFiveTasks(db) {
  const result = await execute(db, 'SELECT id, text, status FROM tasks ORDER BY created_at DESC LIMIT 5');
  return rowsAsObjects(result);
}

async function getCurrentTask(db, userId) {
  const result = await execute(
    db,
    'SELECT id FROM tasks WHERE creator_id = ? AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1',
    [userId, 'ожидает', 'выполняется'],
  );
  return rowsAsObjects(result)[0];
}

async function addDialogMessage(db, taskId, message) {
  await execute(db, 'INSERT INTO dialog_messages (task_id, message_text) VALUES (?, ?)', [taskId, message]);
}

// --- GitHub, plain REST - no @octokit/core ---

async function triggerWorkflow(taskId, githubToken) {
  const res = await fetch(
    'https://api.github.com/repos/stmooooore-lang/queue-engine/actions/workflows/executor.yml/dispatches',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'plexus-queue-worker',
      },
      body: JSON.stringify({ ref: 'main', inputs: { taskId: String(taskId) } }),
    },
  );
  if (!res.ok) throw new Error(`github dispatch ${res.status}: ${await res.text()}`);
}

function formatTasks(tasks) {
  if (!tasks.length) return 'Задач пока нет';
  return tasks.map((t) => `Задача ${t.id}: ${t.text} (${t.status})`).join('\n');
}
