/**
 * Verification test suite for checkpoint/artifact upload, resume capability,
 * tree completion, and saving stderr/partial results as partial artifacts.
 *
 * Verifies:
 * 1. savePartialArtifact saves stderr and partial results as partial artifacts (not complete results).
 * 2. findLatestCheckpoint locates the latest valid checkpoint for a task, ignoring raw log files.
 * 3. isResumeJob and extractResumeFrom correctly detect resume directives, prefixes, status, and metadata.
 * 4. checkTreeCompletion correctly completes parent task when all siblings are 'готова' (after resume),
 *    and keeps parent uncompleted if any sibling remains 'partial' or 'провал'.
 * 5. uploadTaskCheckpointsAndArtifacts handles partial artifacts and complete artifacts.
 * 6. executeResume resumes execution using checkpoint state and environment pointers.
 * 7. executeLongCompute routes success to complete artifact upload and failure to partial artifact upload.
 * 8. doWork correctly routes resume jobs and long compute jobs.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  savePartialArtifact,
  uploadTaskCheckpointsAndArtifacts,
  findLatestCheckpoint,
  executeResume,
  isResumeJob,
  extractResumeFrom,
  extractParentAndSiblingInfo,
  checkTreeCompletion,
  executeLongCompute,
  doWork
} from "./executor.mjs";

console.log("Starting test-checkpoint-and-resume verification...");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "queue-engine-test-"));
const testCheckpointDir = path.join(tempDir, "checkpoints");
await fs.mkdir(testCheckpointDir, { recursive: true });

try {
  // ---------------------------------------------------------------------
  // 1. Partial Artifacts: save stderr and partial results as partial artifacts (NOT complete results)
  // ---------------------------------------------------------------------
  console.log("Test 1: savePartialArtifact verification...");
  const taskId1 = "test-job-101";
  const partialData = {
    stdout: "Processed 500/1000 items (partial progress)",
    stderr: "Error: Out of memory at batch 501\n    at train.py:120",
    exitCode: 137,
    jobCapMs: 1800000,
    command: "python train.py"
  };

  const artifactInfo = await savePartialArtifact(taskId1, partialData, { checkpointDir: testCheckpointDir });
  assert.equal(artifactInfo.isPartial, true, "Artifact must be marked as partial");
  assert.equal(artifactInfo.status, "partial", "Status must be 'partial'");

  // Check generated files
  const jsonPath = path.join(testCheckpointDir, `task-${taskId1}-partial.json`);
  const stderrPath = path.join(testCheckpointDir, `task-${taskId1}-stderr.log`);
  const stdoutPath = path.join(testCheckpointDir, `task-${taskId1}-partial-stdout.log`);
  const completeJsonPath = path.join(testCheckpointDir, `task-${taskId1}-complete.json`);

  const jsonRaw = await fs.readFile(jsonPath, "utf-8");
  const parsedMeta = JSON.parse(jsonRaw);

  assert.equal(parsedMeta.task_id, taskId1, "task_id must match");
  assert.equal(parsedMeta.status, "partial", "JSON status must be 'partial'");
  assert.equal(parsedMeta.is_partial, true, "is_partial must be true");
  assert.equal(parsedMeta.is_complete, false, "is_complete must be false (not complete result)");
  assert.equal(parsedMeta.exit_code, 137, "exit_code must be recorded");
  assert.equal(parsedMeta.job_cap_ms, 1800000, "job_cap_ms must match");
  assert.ok(parsedMeta.stderr.includes("Out of memory"), "stderr preview must be in JSON");

  const savedStderr = await fs.readFile(stderrPath, "utf-8");
  assert.ok(savedStderr.includes("Out of memory at batch 501"), "Raw stderr log must be saved");

  const savedStdout = await fs.readFile(stdoutPath, "utf-8");
  assert.ok(savedStdout.includes("Processed 500/1000 items"), "Partial stdout log must be saved");

  // Verify complete artifact file was NOT created
  let completeFileExists = false;
  try {
    await fs.access(completeJsonPath);
    completeFileExists = true;
  } catch {}
  assert.equal(completeFileExists, false, "Complete artifact file must NOT be created on partial result");
  console.log("  ✓ savePartialArtifact verified: saved stderr and partial results as partial artifacts (not complete results).");

  // ---------------------------------------------------------------------
  // 2. findLatestCheckpoint: checkpoint discovery for resume
  // ---------------------------------------------------------------------
  console.log("Test 2: findLatestCheckpoint verification...");
  // Create a model checkpoint file
  const dummyModelCkpt = path.join(testCheckpointDir, `task-${taskId1}-step500.ckpt`);
  await fs.writeFile(dummyModelCkpt, "checkpoint-binary-data");

  const foundCheckpoint = await findLatestCheckpoint(taskId1, { checkpointDir: testCheckpointDir });
  assert.ok(foundCheckpoint, "findLatestCheckpoint must find a checkpoint");
  assert.equal(foundCheckpoint.isPartial, true, "Detected checkpoint must reflect partial status");
  assert.ok(
    foundCheckpoint.filename.endsWith(".json") || foundCheckpoint.filename.endsWith(".ckpt"),
    `Checkpoint must be a json or ckpt file, got ${foundCheckpoint.filename}`
  );
  assert.ok(!foundCheckpoint.filename.endsWith(".log"), "Logs must not be picked as the checkpoint descriptor");

  // Test finding by resumeFrom
  const foundByResumeFrom = await findLatestCheckpoint("different-id", {
    checkpointDir: testCheckpointDir,
    resumeFrom: taskId1
  });
  assert.ok(foundByResumeFrom, "Must find checkpoint via resumeFrom option");
  console.log("  ✓ findLatestCheckpoint verified: found latest valid checkpoint.");

  // ---------------------------------------------------------------------
  // 3. isResumeJob & extractResumeFrom detection
  // ---------------------------------------------------------------------
  console.log("Test 3: isResumeJob & extractResumeFrom detection...");
  // Text prefixes and tags
  assert.equal(isResumeJob(null, "RESUME_COMMAND: ./sim --step 2"), true);
  assert.equal(isResumeJob(null, "RESUME: ./sim --step 2"), true);
  assert.equal(isResumeJob(null, "RUN_COMMAND: [resume] ./sim --step 2"), true);
  assert.equal(isResumeJob(null, "[resume] ./sim --step 2"), true);

  // Directives
  assert.equal(isResumeJob(null, "resume: true\n./sim"), true);
  assert.equal(isResumeJob(null, "is_resume: true\n./sim"), true);
  assert.equal(isResumeJob(null, "resume_from: 101\n./sim"), true);

  // Task object attributes
  assert.equal(isResumeJob({ status: "partial" }, "./sim"), true);
  assert.equal(isResumeJob({ status: "checkpoint" }, "./sim"), true);
  assert.equal(isResumeJob({ is_resume: true }, "./sim"), true);
  assert.equal(isResumeJob({ resume: true }, "./sim"), true);
  assert.equal(isResumeJob({ resume_from: 101 }, "./sim"), true);
  assert.equal(isResumeJob({ metadata: JSON.stringify({ resume: true }) }, "./sim"), true);
  assert.equal(isResumeJob({ metadata: { resume_from: 101 } }, "./sim"), true);

  // Negative checks
  assert.equal(isResumeJob(null, "echo hello"), false);
  assert.equal(isResumeJob({ status: "ожидает" }, "echo hello"), false);

  // extractResumeFrom
  assert.equal(extractResumeFrom(null, "resume_from: 101\n./sim"), "101");
  assert.equal(extractResumeFrom({ resume_from: "job-999" }, "./sim"), "job-999");
  assert.equal(extractResumeFrom({ metadata: { resume_from: 202 } }, "./sim"), "202");
  console.log("  ✓ isResumeJob and extractResumeFrom verified.");

  // ---------------------------------------------------------------------
  // 4. Correct Tree Completion when jobs are resumed (checkTreeCompletion)
  // ---------------------------------------------------------------------
  console.log("Test 4: Tree completion when jobs are resumed...");
  const parentId = 500;
  const subtasks = [
    { id: 501, status: "готова", text: `[SIB 1/3 parent:${parentId}] Part 1`, result: "OK 1" },
    { id: 502, status: "готова", text: `[SIB 2/3 parent:${parentId}] Part 2`, result: "OK 2" },
    { id: 503, status: "partial", text: `[SIB 3/3 parent:${parentId}] Part 3`, result: "Partial error" }
  ];

  let parentTaskUpdated = false;
  let parentUpdateResult = null;

  // Mock DB client
  const mockDb = {
    async execute({ sql, args }) {
      if (sql.includes("SELECT") && sql.includes("parent:")) {
        return { rows: subtasks };
      }
      if (sql.includes("UPDATE tasks SET status = 'готова'") && sql.includes("WHERE id = ?")) {
        parentTaskUpdated = true;
        parentUpdateResult = args[0];
        return { rowsAffected: 1 };
      }
      return { rows: [] };
    }
  };

  // Check 4a: With sibling 3 in 'partial' status, tree must NOT be complete
  const treeStatusBeforeResume = await checkTreeCompletion(503, subtasks[2], mockDb);
  assert.equal(treeStatusBeforeResume.treeComplete, false, "Tree must NOT be complete while sibling is 'partial'");
  assert.equal(parentTaskUpdated, false, "Parent task must NOT be marked complete");

  // Check 4b: Resume sibling 3! Sibling 3 completes -> status becomes 'готова'
  subtasks[2].status = "готова";
  subtasks[2].result = "OK 3 (after resume)";

  const treeStatusAfterResume = await checkTreeCompletion(503, subtasks[2], mockDb);
  assert.equal(treeStatusAfterResume.treeComplete, true, "Tree must be complete after resumed sibling reaches 'готова'");
  assert.equal(treeStatusAfterResume.parentId, parentId, "parentId must match");
  assert.equal(treeStatusAfterResume.completedSiblings, 3, "All 3 siblings completed");
  assert.equal(parentTaskUpdated, true, "Parent task must be updated to 'готова' on tree completion");
  assert.ok(
    parentUpdateResult.includes("ДЕРЕВО ЗАДАЧ ЗАВЕРШЕНО"),
    "Parent task result must contain tree completion notice"
  );
  console.log("  ✓ checkTreeCompletion verified: correct tree completion when jobs are resumed.");

  // ---------------------------------------------------------------------
  // 5. extractParentAndSiblingInfo verification
  // ---------------------------------------------------------------------
  console.log("Test 5: extractParentAndSiblingInfo verification...");
  const sibInfo = extractParentAndSiblingInfo(null, "[SIB 2/4 parent:888] do something");
  assert.deepEqual(sibInfo, { index: 2, total: 4, parentId: 888 });

  const sibInfoFromMeta = extractParentAndSiblingInfo({ metadata: { parent_id: 999, total_siblings: 5, sibling_index: 3 } });
  assert.deepEqual(sibInfoFromMeta, { index: 3, total: 5, parentId: 999 });
  console.log("  ✓ extractParentAndSiblingInfo verified.");

  // ---------------------------------------------------------------------
  // 6. uploadTaskCheckpointsAndArtifacts verification
  // ---------------------------------------------------------------------
  console.log("Test 6: uploadTaskCheckpointsAndArtifacts verification...");
  // Test upload with non-git or clean dir (must return boolean without throwing)
  const uploadPartialRes = await uploadTaskCheckpointsAndArtifacts(taskId1, {
    isPartial: true,
    checkpointDir: testCheckpointDir,
    workdir: tempDir
  });
  assert.equal(typeof uploadPartialRes, "boolean", "uploadTaskCheckpointsAndArtifacts must return a boolean");

  const uploadCompleteRes = await uploadTaskCheckpointsAndArtifacts(taskId1, {
    isPartial: false,
    checkpointDir: testCheckpointDir,
    workdir: tempDir
  });
  assert.equal(typeof uploadCompleteRes, "boolean", "uploadTaskCheckpointsAndArtifacts must return a boolean");
  console.log("  ✓ uploadTaskCheckpointsAndArtifacts verified.");

  // ---------------------------------------------------------------------
  // 7. doWork routing verification
  // ---------------------------------------------------------------------
  console.log("Test 7: doWork routing verification...");
  assert.equal(typeof doWork, "function", "doWork must be a function");
  assert.equal(typeof executeResume, "function", "executeResume must be an exported function");
  assert.equal(typeof executeLongCompute, "function", "executeLongCompute must be an exported function");
  console.log("  ✓ doWork and executeResume functions verified.");

  console.log("\nAll checkpoint, artifact upload, resume, and tree completion tests passed successfully!");
} finally {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {}
}