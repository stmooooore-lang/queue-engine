// scripts/init-tasks-md.mjs
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const REPO_DIR = process.env.PROJECT_REPO_DIR || "/home/runner/plexus-doc";
const TASKS_TEMPLATE = `# TASKS.md

## Personal — [open] <короткое название>
Opened: ${new Date().toISOString().slice(0, 10)}
Closed: —
Result: (заполняет только основатель)

## Research — [discussing] <короткое название>
Opened: ${new Date().toISOString().slice(0, 10)}
Thread: <где велось обсуждение>
Finding: (заполняется, когда обсуждение завершено)
Promoted: no

## Dev — [queued] <TASK-ID> <короткое название>
Opened: ${new Date().toISOString().slice(0, 10)}
Branch: task/<id>-<slug>
Acceptance: <команда/число/да-нет — без этого задача не заводится>
QA report: —
Result: —
`;

async function fileExistsInRepo(repoDir, relPath) {
  try {
    await fs.access(`${repoDir}/${relPath}`);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTasksFile() {
  // Всегда актуальная копия репозитория перед проверкой — та же дисциплина,
  // что и у обычной задачи (см. Block 3 стандарта): sync перед стартом.
  await execFile("git", ["-C", REPO_DIR, "checkout", "main"]);
  await execFile("git", ["-C", REPO_DIR, "pull"]);

  if (await fileExistsInRepo(REPO_DIR, "TASKS.md")) {
    console.log("TASKS.md уже существует, инициализация не требуется.");
    return { created: false };
  }

  await fs.writeFile(`${REPO_DIR}/TASKS.md`, TASKS_TEMPLATE, "utf8");

  await execFile("git", ["-C", REPO_DIR, "add", "TASKS.md"]);
  await execFile("git", [
    "-C", REPO_DIR, "commit", "-m",
    "TASKS.md: автоинициализация по Генеральному Стандарту (без участия основателя)"
  ]);
  await execFile("git", ["-C", REPO_DIR, "push", "origin", "main"]);

  console.log("TASKS.md создан и запушен в main.");
  return { created: true };
}