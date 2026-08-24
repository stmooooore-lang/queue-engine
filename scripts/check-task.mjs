import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function main() {
  const tasks = await db.execute({ sql: "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 10", args: [] });
  console.log("All tasks:", tasks.rows);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
