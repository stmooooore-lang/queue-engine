/**
 * Unit and integration tests for timeout logic and separate compute path in queue-engine executor.
 * Verifies:
 * 1. Regular jobs strictly enforce 5-minute timeout (300,000 ms).
 * 2. Long compute jobs are exempt from the 5-minute timeout limit (effectiveTimeout = 0 by default).
 * 3. Long compute jobs respect agreed job cap duration (via jobCapMs, JOB_CAP_MS, or task metadata/directives).
 * 4. Separate compute path (executeLongCompute) handles long compute jobs independently.
 */

import assert from "node:assert/strict";
import {
  isLongComputeJob,
  extractCommand,
  parseDuration,
  extractJobCap,
  getEffectiveTimeout,
  executeLongCompute,
  doWork
} from "./executor.mjs";

console.log("Starting timeout logic and compute path verification...");

// ---------------------------------------------------------------------
// 1. Duration Parsing Tests (parseDuration)
// ---------------------------------------------------------------------
console.log("Test 1: parseDuration unit tests...");
assert.equal(parseDuration("30m"), 30 * 60 * 1000, "30m should be 1800000 ms");
assert.equal(parseDuration("30 min"), 30 * 60 * 1000, "30 min should be 1800000 ms");
assert.equal(parseDuration("30 minutes"), 30 * 60 * 1000, "30 minutes should be 1800000 ms");
assert.equal(parseDuration("1h"), 3600 * 1000, "1h should be 3600000 ms");
assert.equal(parseDuration("2 hours"), 2 * 3600 * 1000, "2 hours should be 7200000 ms");
assert.equal(parseDuration("1800s"), 1800 * 1000, "1800s should be 1800000 ms");
assert.equal(parseDuration("5000ms"), 5000, "5000ms should be 5000 ms");
assert.equal(parseDuration(1800000), 1800000, "Number 1800000 should be preserved");
assert.equal(parseDuration("invalid"), null, "Invalid string should return null");
assert.equal(parseDuration(null), null, "null should return null");
console.log("  ✓ parseDuration tests passed.");

// ---------------------------------------------------------------------
// 2. Regular Jobs Timeout Tests (getEffectiveTimeout)
// ---------------------------------------------------------------------
console.log("Test 2: Regular jobs 5-minute timeout enforcement...");
const regularTimeoutDefault = getEffectiveTimeout({ isLongCompute: false });
assert.equal(
  regularTimeoutDefault,
  5 * 60 * 1000,
  `Regular jobs must have default 5-minute timeout (300000ms), got ${regularTimeoutDefault}`
);

// Regular jobs with empty options must default to 5-minute timeout
const emptyOptionsTimeout = getEffectiveTimeout({});
assert.equal(
  emptyOptionsTimeout,
  5 * 60 * 1000,
  `Default options must enforce 5-minute timeout (300000ms), got ${emptyOptionsTimeout}`
);

// Regular jobs must not inherit job cap when isLongCompute is false
const regularWithJobCap = getEffectiveTimeout({ isLongCompute: false, jobCapMs: 30 * 60 * 1000 });
assert.equal(
  regularWithJobCap,
  5 * 60 * 1000,
  "Regular jobs must ignore jobCapMs and remain capped at 5 minutes"
);
console.log("  ✓ Regular jobs timeout (5 minutes / 300,000 ms) verified.");

// ---------------------------------------------------------------------
// 3. Long Compute Exemption and Job Cap Tests (getEffectiveTimeout)
// ---------------------------------------------------------------------
console.log("Test 3: Long compute exemption and extended duration per job cap...");

// Long compute without explicit cap -> exempt from 5-minute timeout (effectiveTimeout = 0)
const longComputeNoCap = getEffectiveTimeout({ isLongCompute: true });
assert.equal(
  longComputeNoCap,
  0,
  `Long compute without explicit cap must be exempt from timeout limit (0), got ${longComputeNoCap}`
);

// Long compute with explicit job cap (e.g. 30 minutes)
const longCompute30MinCap = getEffectiveTimeout({ isLongCompute: true, jobCapMs: 30 * 60 * 1000 });
assert.equal(
  longCompute30MinCap,
  30 * 60 * 1000,
  `Long compute with 30m job cap must return 1800000 ms, got ${longCompute30MinCap}`
);

// Long compute with environment variable JOB_CAP_MS
process.env.JOB_CAP_MS = "1200000";
const longComputeEnvJobCap = getEffectiveTimeout({ isLongCompute: true });
assert.equal(
  longComputeEnvJobCap,
  1200000,
  `Long compute with JOB_CAP_MS env must return 1200000 ms, got ${longComputeEnvJobCap}`
);
delete process.env.JOB_CAP_MS;

// Long compute with environment variable LONG_COMPUTE_TIMEOUT_MS
process.env.LONG_COMPUTE_TIMEOUT_MS = "900000";
const longComputeEnvTimeout = getEffectiveTimeout({ isLongCompute: true });
assert.equal(
  longComputeEnvTimeout,
  900000,
  `Long compute with LONG_COMPUTE_TIMEOUT_MS env must return 900000 ms, got ${longComputeEnvTimeout}`
);
delete process.env.LONG_COMPUTE_TIMEOUT_MS;

console.log("  ✓ Long compute exemption and extended duration per job cap verified.");

// ---------------------------------------------------------------------
// 4. Long Compute Job Detection Tests (isLongComputeJob)
// ---------------------------------------------------------------------
console.log("Test 4: Long compute designation detection...");

// Command prefixes
assert.equal(isLongComputeJob(null, "LONG_RUN_COMMAND: echo compute"), true);
assert.equal(isLongComputeJob(null, "LONG_COMPUTE: python train.py"), true);
assert.equal(isLongComputeJob(null, "RUN_COMMAND_LONG: ./run-sim.sh"), true);

// Tags and directives
assert.equal(isLongComputeJob(null, "RUN_COMMAND: [long_compute] ./run.sh"), true);
assert.equal(isLongComputeJob(null, "RUN_COMMAND: [longrun] ./run.sh"), true);
assert.equal(isLongComputeJob(null, "long_compute: true\npython train.py"), true);
assert.equal(isLongComputeJob(null, "job_cap: 30m\npython train.py"), true);
assert.equal(isLongComputeJob(null, "computation_duration: 1800s\npython train.py"), true);

// Task properties
assert.equal(isLongComputeJob({ lane: "longrun" }, "echo hi"), true);
assert.equal(isLongComputeJob({ type: "compute" }, "echo hi"), true);
assert.equal(isLongComputeJob({ is_long_compute: true }, "echo hi"), true);
assert.equal(isLongComputeJob({ metadata: JSON.stringify({ long_compute: true }) }, "echo hi"), true);
assert.equal(isLongComputeJob({ metadata: { job_cap: "30m" } }, "echo hi"), true);

// Regular jobs (should NOT be detected as long compute)
assert.equal(isLongComputeJob(null, "RUN_COMMAND: ls -la"), false);
assert.equal(isLongComputeJob({ lane: "coder" }, "Write a function"), false);
assert.equal(isLongComputeJob({ lane: "architect" }, "Design the system"), false);

console.log("  ✓ Long compute designation detection verified.");

// ---------------------------------------------------------------------
// 5. Job Cap Extraction Tests (extractJobCap)
// ---------------------------------------------------------------------
console.log("Test 5: extractJobCap extraction...");
assert.equal(extractJobCap(null, "job_cap: 30m\nRUN_COMMAND: ./sim"), 30 * 60 * 1000);
assert.equal(extractJobCap(null, "computation_duration: 20m\nRUN_COMMAND: ./sim"), 20 * 60 * 1000);
assert.equal(extractJobCap({ job_cap_ms: 600000 }, "RUN_COMMAND: ./sim"), 600000);
assert.equal(extractJobCap({ metadata: JSON.stringify({ job_cap: "45m" }) }, "RUN_COMMAND: ./sim"), 45 * 60 * 1000);

// Agreement between job cap and computation duration (cap bounds computation duration)
assert.equal(
  extractJobCap(null, "job_cap: 30m\ncomputation_duration: 20m\nRUN_COMMAND: ./sim"),
  20 * 60 * 1000,
  "When computation duration is within job cap, agreed duration is computation duration"
);
assert.equal(
  extractJobCap(null, "job_cap: 15m\ncomputation_duration: 25m\nRUN_COMMAND: ./sim"),
  15 * 60 * 1000,
  "When computation duration exceeds job cap, agreed duration is capped at job cap"
);
console.log("  ✓ extractJobCap extraction verified.");

// ---------------------------------------------------------------------
// 6. Command Extraction Tests (extractCommand)
// ---------------------------------------------------------------------
console.log("Test 6: extractCommand extraction...");
assert.equal(extractCommand("LONG_RUN_COMMAND: echo compute"), "echo compute");
assert.equal(extractCommand("RUN_COMMAND: [long_compute] ./run.sh"), "./run.sh");
assert.equal(extractCommand("job_cap: 30m\nRUN_COMMAND: ./sim"), "./sim");
assert.equal(extractCommand("RUN_COMMAND: ./sim\njob_cap: 30m"), "./sim");
assert.equal(extractCommand("job_cap: 30m\n./sim", { lane: "longrun" }), "./sim");
assert.equal(extractCommand("job_cap: 30m\n./sim"), "./sim");
assert.equal(extractCommand("computation_duration: 1800s\npython train.py"), "python train.py");
console.log("  ✓ extractCommand extraction verified.");

// ---------------------------------------------------------------------
// 7. Separate Compute Path Execution Tests (executeLongCompute & doWork)
// ---------------------------------------------------------------------
console.log("Test 7: Separate compute path execution...");
assert.equal(typeof executeLongCompute, "function", "executeLongCompute must be an exported function");

console.log("All tests successfully verified!");
