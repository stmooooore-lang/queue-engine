import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function main() {
  // Test connection
  await db.execute({ sql: "SELECT 1", args: [] });
  console.log("Turso connection OK");
  
  // Check tasks table schema
  const schema = await db.execute({ sql: "PRAGMA table_info(tasks)", args: [] });
  console.log("Tasks table schema:", schema.rows);
  
  // Insert test task
  const prompt = "прочитай canon/START-HERE.md и скажи, какая дата стоит в разделе ## Last updated";
  const result = await db.execute({
    sql: "INSERT INTO tasks (text, status, creator_id) VALUES (?, ?, ?)",
    args: [prompt, "ожидает", 123456789]
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
