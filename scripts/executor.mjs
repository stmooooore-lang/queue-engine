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

async function doWork(text) {
  // Execution not implemented yet
  return { success: false, message: 'исполнение не реализовано' };
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