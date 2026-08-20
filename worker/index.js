const { Client } = require('@libsql/client');
const { Octokit } = require('@octokit/core');

exports.default = {
  async fetch(request, env) {
    const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, GITHUB_TOKEN } = env;

    const turso = new Client({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

    const { method } = request;
    if (method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const body = await request.json();
    if (!body.message) return new Response('Bad request', { status: 400 });

    const { message } = body;
    const { chat, text, from } = message;
    const userId = from.id;

    if (userId !== parseInt(TELEGRAM_ALLOWED_USER_ID)) {
      return new Response('Unauthorized', { status: 403 });
    }

    if (text.startsWith('/task ')) {
      const taskText = text.slice(6).trim();
      const taskId = await createTask(turso, taskText, userId);
      await triggerWorkflow(taskId, GITHUB_TOKEN);
      return new Response(`Задача создана с ID ${taskId}`, { status: 200 });
    } else if (text === '/status') {
      const tasks = await getLastFiveTasks(turso);
      return new Response(formatTasks(tasks), { status: 200 });
    } else {
      const currentTask = await getCurrentTask(turso, userId);
      if (currentTask) {
        await addDialogMessage(turso, currentTask.id, text);
        return new Response('Сообщение добавлено в диалог задачи', { status: 200 });
      } else {
        return new Response('Нет активной задачи', { status: 400 });
      }
    }
  },
};

async function createTask(client, text, creatorId) {
  const result = await client.execute({
    sql: 'INSERT INTO tasks (text, status, creator_id) VALUES (?, ?, ?)',
    args: [text, 'ожидает', creatorId],
  });
  return result.lastInsertRowid;
}

async function getLastFiveTasks(client) {
  const result = await client.execute({
    sql: 'SELECT id, text, status FROM tasks ORDER BY created_at DESC LIMIT 5',
  });
  return result.rows;
}

async function getCurrentTask(client, userId) {
  const result = await client.execute({
    sql: 'SELECT id FROM tasks WHERE creator_id = ? AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1',
    args: [userId, 'ожидает', 'выполняется'],
  });
  return result.rows[0];
}

async function addDialogMessage(client, taskId, message) {
  await client.execute({
    sql: 'INSERT INTO dialog_messages (task_id, message_text) VALUES (?, ?)',
    args: [taskId, message],
  });
}

async function triggerWorkflow(taskId, githubToken) {
  const octokit = new Octokit({ auth: githubToken });
  await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
    owner: 'stmooooore-lang',
    repo: 'queue-engine',
    workflow_id: 'executor.yml',
    ref: 'main',
    inputs: { taskId: taskId.toString() },
  });
}

function formatTasks(tasks) {
  return tasks.map(task => `Задача ${task.id}: ${task.text} (${task.status})`).join('\n');
}