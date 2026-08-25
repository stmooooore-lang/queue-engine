import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function main() {
  // Test connection
  await db.execute({ sql: "SELECT 1", args: [] });
  console.log("Turso connection OK");
  
  // Insert test task with creator_id 1568126 (from task 30)
  const prompt = "напиши три коротких абзаца про то, зачем нужна очередь задач";
  const result = await db.execute({
    sql: "INSERT INTO tasks (text, status, creator_id) VALUES (?, ?, ?)",
    args: [prompt, "ожидает", 1568126]
  });
  console.log("Inserted task:", result);
  
  // Verify insert
  const tasks = await db.execute({ sql: "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 5", args: ["ожидает"] });
  console.log("Pending tasks:", tasks.rows);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
