import { createClient } from "@libsql/client";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const POLL_INTERVAL_MS = 10000;
const MAX_CONCURRENT = 1;
const CLINE_TIMEOUT_MS = 25 * 60 * 1000;
const MAX_OUTPUT = 3500;

function truncate(s) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (обрезано)` : s;
}
const ANSI = /\x1b\[[0-9;]*m/g;

function extractFinalAnswer(jsonLines) {
  let last = null;
  for (const line of jsonLines.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t);
      if (d.type === "run_result") last = d;
    } catch {}
  }
  return last;
}

async function doWork(text, litellmMasterKey) {
  const dockerArgs = [
    "run", "--rm",
    "-v", "/home/runner/.cline:/home/runner/.cline",
    "-v", "/home/runner/plexus-doc:/home/runner/plexus-doc",
    "-w", "/home/runner/plexus-doc",
    "plexus-render:latest",
    "cline",
    "--config", "/home/runner/.cline",
    "--data-dir", "/home/runner/.cline/data",
    "--cwd", "/home/runner/plexus-doc",
    "-P", "openai-compatible",
    "-m", "plexus-act",
    "--compaction", "off",
    "--retries", "3",
    "--json",
    text
  ];

  try {
    const { stdout } = await execFile("docker", dockerArgs, {
      timeout: CLINE_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, LITELLM_MASTER_KEY: litellmMasterKey }
    });

    const result = extractFinalAnswer(stdout);
    if (!result) {
      return { success: false, message: truncate(`агент не вернул run_result\n${stdout.replace(ANSI, "").slice(-1500)}`) };
    }
    const ok = result.finishReason === "completed";
    const body = (result.text || "(агент ничего не ответил)").trim();
    return { success: ok, message: truncate(ok ? body : `${result.finishReason}: ${body}`) };
  } catch (err) {
    const result = extractFinalAnswer(err.stdout || "");
    if (result) return { success: false, message: truncate(`${result.finishReason}: ${(result.text || "").trim()}`) };
    const first = String(err.message || err).split("\n")[0];
    const code = err.code ?? err.signal ?? "?";
    return { success: false, message: truncate(`код ${code}: ${first}`) };
  }
}

async function main() {
  const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY;
  
  // First, just run a single test to see if the config path works
  const result = await doWork("прочитай canon/START-HERE.md и скажи, какая дата стоит в разделе ## Last updated", LITELLM_MASTER_KEY);
  console.log("Result:", result);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
