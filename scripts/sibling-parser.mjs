/**
 * Unified sibling-task parser for the cloud queue (CLOUD-MAINT-c-d,
 * 2026-10-09).
 *
 * Single owner of the `[SIB i/n parent:P]` marker format that triageSplit()
 * embeds at the very start of a triage-split subtask's own text, and of
 * every parse/extract/guard routine built on that format. Used by BOTH
 * consumers of the format:
 *
 *   - scripts/dispatcher.mjs - parseSiblingMarker + the sibling-order
 *     guard, so an out-of-order sibling is never even dispatched;
 *   - scripts/executor.mjs - the same guard again before claim (defense in
 *     depth against a direct workflow_dispatch), plus the richer
 *     extractParentAndSiblingInfo() for tree-completion bookkeeping, and
 *     buildSiblingMarker() inside triageSplit() itself.
 *
 * Why this module exists. GHQ2-c (2026-09-14) ported parseSiblingMarker/
 * siblingOrderOk from executor.mjs into dispatcher.mjs as a second,
 * hand-synced copy ("not worth sharing a module for two small functions").
 * CLOUD-MAINT-c-c (2026-10-07) then had to fix the same fail-open-on-missing-
 * predecessor bug TWICE - once per copy - which is the concrete cost of the
 * duplication this module removes: one parser, one fix, one place.
 *
 * Scope note (parent task CLOUD-MAINT-c): this step unifies the parser only.
 * Tree COMPLETION (checkTreeCompletion) stays in executor.mjs; it consumes
 * this parser but is write-back logic, not parsing.
 *
 * This module is pure JS: no imports, no DB client of its own. The DB-backed
 * guard is a factory (makeSiblingOrderOk) so each process binds it to its
 * own @libsql/client - dispatcher.mjs builds its client straight from env
 * vars, executor.mjs loads credentials via loadTursoCredentials(), and the
 * contract test (tests/cloud_queue_contract.mjs) drives both against
 * separate file::memory: instances.
 */

// Canonical marker format, e.g. `[SIB 2/3 parent:7510]`. Anchored to the
// very start of the task text: triageSplit() embeds it as a prefix, the
// order guards LIKE-query on that prefix, and parseSiblingMarker() must
// NOT match the same shape appearing mid-text.
export const SIBLING_MARKER_RE = /^\[SIB (\d+)\/(\d+) parent:(\d+)\]/;

/**
 * GHQ2-c, 2026-09-14: parses the `[SIB i/n parent:P]` marker triageSplit()
 * embeds in a subtask's own text. Returns null for a task that isn't a
 * triage-split subtask at all (no marker) - siblingOrderOk() then always
 * allows it, unchanged behavior for every non-subtask task.
 *
 * @param {string} [text]
 * @returns {{index: number, total: number, parentId: number}|null}
 */
export function parseSiblingMarker(text) {
  const m = String(text || "").match(SIBLING_MARKER_RE);
  if (!m) return null;
  return { index: Number(m[1]), total: Number(m[2]), parentId: Number(m[3]) };
}

/**
 * The write side of the same format parseSiblingMarker() reads, kept in the
 * same module so the marker has exactly one textual definition. Used by
 * triageSplit() (executor.mjs) and by the guard's own predecessor lookup.
 *
 * @param {number} index - 1-based position of this subtask
 * @param {number} total - subtasks produced by the same split
 * @param {number} parentId - id of the parent task that was split
 * @returns {string} e.g. `[SIB 2/3 parent:7510]`
 */
export function buildSiblingMarker(index, total, parentId) {
  return `[SIB ${index}/${total} parent:${parentId}]`;
}

/**
 * Extracts parent and sibling information from task object or text.
 * Handles [SIB i/n parent:P] format, parent_id directives, and task metadata.
 *
 * Moved verbatim from executor.mjs by CLOUD-MAINT-c-d; behavior is unchanged
 * and locked by tests/cloud_queue_contract.mjs and
 * scripts/test-checkpoint-and-resume.mjs (Test 5).
 *
 * @param {object} [task]
 * @param {string} [text]
 * @returns {{parentId: number, index: number, total: number|null}|null}
 */
export function extractParentAndSiblingInfo(task, text) {
  const content = (text || task?.text || '').trim();
  const sib = parseSiblingMarker(content);
  if (sib) return sib;

  let parentId = task?.parent_id || task?.parentId || null;
  let total = task?.total_siblings || task?.sibling_count || null;
  let index = task?.sibling_index || task?.subtask_index || null;

  if (task?.metadata) {
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
      if (!parentId && (meta.parent_id || meta.parentId)) parentId = Number(meta.parent_id || meta.parentId);
      if (!total && (meta.total_siblings || meta.total)) total = Number(meta.total_siblings || meta.total);
      if (!index && (meta.sibling_index || meta.index)) index = Number(meta.sibling_index || meta.index);
    } catch {}
  }

  if (!parentId) {
    const parentMatch = content.match(/(?:^|\n|\s|\[)(?:parent[_-]?id|parent)[:\s=]+(\d+)/i);
    if (parentMatch) {
      parentId = Number(parentMatch[1]);
    }
  }

  if (parentId) {
    return { parentId: Number(parentId), index: Number(index) || 1, total: total ? Number(total) : null };
  }
  return null;
}

/**
 * Builds the sibling-order guard bound to one process's own DB client.
 *
 * GHQ2-c, 2026-09-14 / CLOUD-MAINT-c-c semantics, unchanged by CLOUD-MAINT-c-d:
 * a subtask at index i>1 may only run once the sibling at index i-1 (same
 * parentId) has real status 'готова'. A missing predecessor is NOT considered
 * completed, and neither is a DB error - the guard fails closed in both
 * cases (the fail-open bug CLOUD-MAINT-c-c fixed, previously in two copies).
 * A task with no marker (or index <= 1) always passes.
 *
 * @param {object} client - @libsql/client instance (dispatcher's or executor's)
 * @returns {(task: {text?: string}) => Promise<boolean>}
 */
export function makeSiblingOrderOk(client) {
  return async function siblingOrderOk(task) {
    const sib = parseSiblingMarker(task.text);
    if (!sib || sib.index <= 1) return true;
    try {
      const res = await client.execute({
        sql: "SELECT status FROM tasks WHERE text LIKE ? LIMIT 1",
        args: [`${buildSiblingMarker(sib.index - 1, sib.total, sib.parentId)}%`],
      });
      const prev = res.rows[0];
      if (!prev) return false;
      return prev.status === "готова";
    } catch {
      return false;
    }
  };
}
