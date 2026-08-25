import { createClient } from "@libsql/client";

const db = createClient({
  url: "libsql://plexus-queue-satandroid.aws-eu-west-1.turso.io",
  authToken: "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc0NDg2NjYsImlkIjoiMDFhMDIxMDItY2YwMS03Y2Q5LThhYWMtMjAxM2RkMmU4Y2Y5Iiwia2lkIjoiZlhqWk4xbTBMVjRCRXZKZllKaUpwYWgtVHhUV2toVmxuZUJJRzV4OHhjQSIsInJpZCI6ImM4YmUxYmFmLWFlMDMtNDliZC1iY2Y2LWMwNDE0NjA0MjJjZSJ9.CtJuW39DeF5-ZyIP8kWs3QEC3hXocbd_-AH1TfFFqxMt9Bxslh363igbpSZy1uLDN3MOh7j8_2S4sWwvx6x2Bw"
});

async function main() {
  const result = await db.execute({ 
    sql: "INSERT INTO tasks (text, status, creator_id) VALUES (?, ?, ?)", 
    args: ["напиши два коротких пункта списком, один из них выдели жирным", "ожидает", 1568126] 
  });
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});