import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function main() {
  // Test connection
  await db.execute({ sql: "SELECT 1", args: [] });
  console.log("Turso connection OK");

  // Query current counts by status
  const countsBefore = await db.execute({
    sql: "SELECT status, COUNT(*) as count FROM tasks GROUP BY status",
    args: []
  });
  console.log("COUNTS BEFORE:", JSON.stringify(countsBefore.rows, null, 2));

  // CLEANUP: Update tasks with status 'ожидает' or 'выполняется' to 'провал'
  const cleanupResult = await db.execute({
    sql: `UPDATE tasks SET status = ?, result = ? WHERE status IN (?, ?)`,
    args: ['провал', 'снято перед финальным тестом форматирования', 'ожидает', 'выполняется']
  });
  console.log("Cleanup result:", JSON.stringify(cleanupResult, null, 2));

  // CREATE: Insert exactly ONE new task
  const newTaskText = `Сформируй ОДИН ответ пользователю. В ответе обязательно:
1) одна строка обычного текста
2) одна строка с жирным markdown: **жирный текст**
3) markdown-таблица на 2–3 строки

Ничего не ищи в репозитории. Ничего не отправляй и не вызывай сам.
Просто верни готовый текст ответа.`;

  const insertResult = await db.execute({
    sql: "INSERT INTO tasks (text, status, creator_id) VALUES (?, ?, ?)",
    args: [newTaskText, "ожидает", 1568126]
  });
  console.log("Insert result:", JSON.stringify(insertResult, null, 2));
  const newTaskId = insertResult.lastInsertRowid || insertResult.last_insert_rowid || insertResult.rowsAffected;
  console.log("New task created with ID:", newTaskId);

  // Query counts after
  const countsAfter = await db.execute({
    sql: "SELECT status, COUNT(*) as count FROM tasks GROUP BY status",
    args: []
  });
  console.log("COUNTS AFTER:", JSON.stringify(countsAfter.rows, null, 2));

  // Return summary
  console.log("\n=== SUMMARY ===");
  console.log("New task ID:", newTaskId);
  console.log("Counts before:", JSON.stringify(countsBefore.rows));
  console.log("Counts after:", JSON.stringify(countsAfter.rows));
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});