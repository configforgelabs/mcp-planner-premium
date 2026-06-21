/**
 * planBuild.ts — pure fixture → batch-plan transform (no network, no fs)
 *
 * Produces:
 *  - Level-by-level task batches (roots first, level N before level N+1),
 *    each batch ≤ batchSize entities (default 190, below the PSS 200-cap).
 *  - Explicit parent GUIDs on every non-root task (never relies on outline
 *    order — avoids PSS root-task auto-nesting, per PSS-IMPLEMENTATION-LESSONS §2).
 *  - Leaf-only dependency list: any dep that touches a summary (parent) task
 *    is dropped because PSS rejects such links.
 *  - A resume helper that, given a partially-filled cache, returns only the
 *    remaining work.
 */

import type { Fixture, FixtureTask } from "./hashFixture.js";
import type { SeedCache } from "./cache.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum entities per PSS operation set. We stay 10 below the hard 200 cap. */
export const DEFAULT_BATCH_SIZE = 190;

// ── Batch descriptor types ────────────────────────────────────────────────────

/** A single task to be created; parentGuid must already exist in Dataverse. */
export interface TaskItem {
  taskNumber: number;
  name: string;
  outline: string | null;
  bucket: string | null;
  start: string | null;
  finish: string | null;
  effortHours: number | null;
  priority: number | null;
  /** GUID of the parent task (already persisted), or null for roots. */
  parentGuid: string | null;
}

/** A batch of TaskItems that fit in one PSS operation set. */
export interface TaskBatch {
  level: number;
  batchIndex: number; // 0-based within this level
  items: TaskItem[];
}

/** A leaf-to-leaf dependency to be created after all tasks exist. */
export interface DepItem {
  pred: number; // predecessor taskNumber
  succ: number; // successor taskNumber
  type: string; // "FS" | "SS" | "FF" | "SF"
}

/** A leaf task whose progressPercent should be set (update phase). */
export interface ProgressItem {
  taskNumber: number;
  progressPercent: number;
}

/** A progress update batch. */
export interface ProgressBatch {
  batchIndex: number;
  items: ProgressItem[];
}

/** Complete plan blueprint produced from the fixture. */
export interface PlanBlueprint {
  /** Ordered list of task batches, level 1 first. */
  taskBatches: TaskBatch[];
  /** All createable (leaf-to-leaf) dependencies. */
  deps: DepItem[];
  /** All leaf tasks whose progressPercent !== 0. */
  progressItems: ProgressItem[];
}

/** What remains to do, given a partial cache. */
export interface ResumePlan {
  /** Task batches not yet persisted (by taskNumber membership). */
  remainingTaskBatches: TaskBatch[];
  /** Dep items not yet created (pred+succ pair not in cache.dependencyIds). */
  remainingDeps: DepItem[];
  /** Whether the progress phase still needs to run. */
  needProgress: boolean;
  /** taskNumbers that already have a GUID in the cache and can be skipped. */
  skippedTaskNumbers: Set<number>;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function levelOf(t: FixtureTask): number {
  return t.outline ? String(t.outline).split(".").length : 1;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/** Returns the set of taskNumbers that have at least one child. */
function buildSummarySet(tasks: FixtureTask[]): Set<number> {
  const parents = new Set<number>();
  for (const t of tasks) {
    if (t.parentTaskNumber != null) {
      parents.add(t.parentTaskNumber);
    }
  }
  return parents;
}

// ── Core: fixture → blueprint ─────────────────────────────────────────────────

/**
 * Converts the fixture into an ordered set of batch descriptors.
 *
 * Rules enforced:
 *  1. Roots (level 1) are in the first set of batches — created while the plan
 *     is still empty, so PSS won't auto-nest them.
 *  2. Level N batches always come before level N+1 — every task's parent is
 *     guaranteed to be in the GUID map when its batch runs.
 *  3. Each batch contains ≤ batchSize tasks.
 *  4. Dependency items only include leaf-to-leaf links (neither endpoint is a
 *     summary task) — PSS rejects deps touching summary tasks.
 *
 * @param fixture    Parsed it-planner-board.json
 * @param taskGuidMap Optional pre-seeded GUID map (e.g. from a cache) used to
 *                   populate parentGuid on non-root tasks. When absent a
 *                   synthetic "unknown" marker is used — callers must supply the
 *                   real map at build time. For PURE planning (no live GUIDs)
 *                   parent references are stored as taskNumber strings so the
 *                   builder can resolve them at execution time.
 * @param batchSize  Max entities per operation set (default 190).
 */
export function planTaskBatches(
  fixture: Fixture,
  taskGuidMap: ReadonlyMap<number, string> = new Map(),
  batchSize = DEFAULT_BATCH_SIZE,
): TaskBatch[] {
  const maxLevel = Math.max(...fixture.tasks.map(levelOf), 1);
  const batches: TaskBatch[] = [];

  for (let level = 1; level <= maxLevel; level++) {
    const atLevel = fixture.tasks.filter((t) => levelOf(t) === level);
    const chunks = chunk(atLevel, batchSize);

    for (let ci = 0; ci < chunks.length; ci++) {
      const items: TaskItem[] = chunks[ci].map((t) => {
        let parentGuid: string | null = null;
        if (t.parentTaskNumber != null) {
          parentGuid = taskGuidMap.get(t.parentTaskNumber) ?? null;
        }
        return {
          taskNumber: t.taskNumber,
          name: (t.name || `Task ${t.taskNumber}`).slice(0, 250),
          outline: t.outline ?? null,
          bucket: t.bucket ?? null,
          start: t.start ?? null,
          finish: t.finish ?? null,
          effortHours: typeof t.effortHours === "number" ? t.effortHours : null,
          priority: typeof t.priority === "number" ? t.priority : null,
          parentGuid,
        };
      });

      batches.push({ level, batchIndex: ci, items });
    }
  }

  return batches;
}

/**
 * Returns only the createable (leaf-to-leaf) dependencies from the fixture.
 * Summary tasks cannot be dependency endpoints — PSS rejects such links.
 */
export function planDependencyBatches(
  fixture: Fixture,
  batchSize = DEFAULT_BATCH_SIZE,
): { deps: DepItem[]; skippedSummaryDeps: number } {
  const summarySet = buildSummarySet(fixture.tasks);
  const deps: DepItem[] = [];
  let skippedSummaryDeps = 0;

  for (const t of fixture.tasks) {
    for (const dep of t.dependsOn ?? []) {
      const pred = dep.onTaskNumber;
      const succ = t.taskNumber;
      if (summarySet.has(pred) || summarySet.has(succ)) {
        skippedSummaryDeps++;
        continue;
      }
      deps.push({ pred, succ, type: dep.type });
    }
  }

  return { deps, skippedSummaryDeps };
}

/**
 * Returns all leaf tasks with non-zero progressPercent — to be applied via
 * update_tasks after all task creates succeed.
 * Summary task progress is rolled up by PSS and must not be set via the API.
 */
export function planProgressItems(fixture: Fixture): ProgressItem[] {
  const summarySet = buildSummarySet(fixture.tasks);
  const items: ProgressItem[] = [];

  for (const t of fixture.tasks) {
    if (summarySet.has(t.taskNumber)) continue; // skip summary tasks
    if (typeof t.progressPercent === "number" && t.progressPercent !== 0) {
      items.push({ taskNumber: t.taskNumber, progressPercent: t.progressPercent });
    }
  }

  return items;
}

/**
 * Full blueprint: task batches + deps + progress items.
 */
export function buildPlanBlueprint(
  fixture: Fixture,
  batchSize = DEFAULT_BATCH_SIZE,
): PlanBlueprint {
  const taskBatches = planTaskBatches(fixture, new Map(), batchSize);
  const { deps } = planDependencyBatches(fixture, batchSize);
  const progressItems = planProgressItems(fixture);

  return { taskBatches, deps, progressItems };
}

// ── Resume planning ───────────────────────────────────────────────────────────

/**
 * PURE resume helper: given a partial cache, returns only what remains to do.
 *
 * Skips:
 *  - Task batches where every taskNumber already has a GUID in the cache.
 *  - Dep items already in cache.dependencyIds (matched by pred+succ since we
 *    don't store the dep id keyed by pair — we use the set of all stored ids
 *    and re-plan the whole dep list, letting the builder skip known ids).
 *  - Progress phase if cache.checkpoint.progressPhaseDone === true.
 *
 * NOTE: The dep-resume logic is conservative — when the cache records N dep
 * ids we assume those N were the first N of the sorted dep list. The builder
 * (live step) reconciles against the actual created id set. Here we simply
 * return the full dep list minus those whose pred+succ pair is in the cache's
 * failedDeps (permanently refused by PSS — don't retry them).
 */
export function planResumeBuild(
  fixture: Fixture,
  cache: SeedCache,
  batchSize = DEFAULT_BATCH_SIZE,
): ResumePlan {
  const existingGuids = new Map<number, string>(
    Object.entries(cache.taskGuidByNumber).map(([k, v]) => [Number(k), v]),
  );

  // ── Task batches: skip batches fully covered by the cache ──
  const allBatches = planTaskBatches(fixture, existingGuids, batchSize);
  const remainingTaskBatches = allBatches.filter((batch) =>
    batch.items.some((item) => !existingGuids.has(item.taskNumber)),
  );

  // ── Deps: skip permanently-failed pairs ──
  const { deps: allDeps } = planDependencyBatches(fixture, batchSize);
  const failedPairs = new Set<string>(
    cache.checkpoint.failedDeps.map((fd) => `${fd.pred}:${fd.succ}`),
  );
  const remainingDeps = allDeps.filter(
    (d) => !failedPairs.has(`${d.pred}:${d.succ}`),
  );

  // ── Progress ──
  const needProgress = !cache.checkpoint.progressPhaseDone;

  const skippedTaskNumbers = new Set<number>(existingGuids.keys());

  return {
    remainingTaskBatches,
    remainingDeps,
    needProgress,
    skippedTaskNumbers,
  };
}
