/**
 * Pure-core analytics functions for schedule analysis.
 *
 * NO fetch, NO env reads, NO side effects. All three exported functions
 * receive their data as typed arguments and return typed results. This makes
 * them 100% unit-testable with injected data and a fixed clock.
 *
 * Three cores:
 *   computeCriticalPath  — backward-pass float over the dependency DAG
 *   computeScheduleHealth — overdue / at-risk / blocked / milestone / slip
 *   computeResourceWorkload — per-member effort & overdue rollup
 */

import { summariseTasks } from "./readHelpers.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface AnalyticsTask {
  taskId: string; // lowercased canonical id
  subject: string | null;
  start: string | null; // msdyn_start  (ISO) — early start (engine-scheduled)
  finish: string | null; // msdyn_finish (ISO) — early finish (engine-scheduled)
  progress: number | null; // 0–1
  isMilestone: boolean;
  isSummary: boolean; // derived: some other task names this as parent
  parentTaskId: string | null;
  effort: number | null; // msdyn_effort (hours)
  remainingEffort: number | null; // msdyn_remainingeffort (hours) — may be null
}

export interface AnalyticsDep {
  predecessorTaskId: string; // lowercased
  successorTaskId: string; // lowercased
  type: "FS" | "SS" | "FF" | "SF" | "Unknown" | undefined; // from linkTypeLabel
  lagMinutes: number | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse ISO string → ms epoch, or null for null / invalid / empty strings. */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

/** Working-day conversion factor: 8 hours/day × 3600 s/h × 1000 ms/s */
const DEFAULT_WORKING_HOURS_PER_DAY = 8;

function workingDayMs(workingHoursPerDay: number): number {
  return workingHoursPerDay * 3600 * 1000;
}

// ---------------------------------------------------------------------------
// 1. computeCriticalPath
// ---------------------------------------------------------------------------

export interface CriticalPathOptions {
  floatToleranceDays?: number; // default 0.5
  nearCriticalDays?: number; // default 2
  workingHoursPerDay?: number; // default 8
}

export interface CriticalPathResult {
  projectStart: string | null;
  projectFinish: string | null;
  totalDurationDays: number | null;
  path: Array<{
    taskId: string;
    subject: string | null;
    start: string | null;
    finish: string | null;
    floatDays: number | null;
    isMilestone: boolean;
  }>;
  criticalCount: number;
  nearCriticalCount: number;
  warnings: string[];
}

/**
 * Computes the critical path of a project from PSS-scheduled engine dates.
 *
 * Key design choices:
 * - Forward pass is READ from engine dates (msdyn_start / msdyn_finish on leaf
 *   tasks). We trust the PSS scheduler; no forward-pass recomputation.
 * - Backward pass (late dates → total float) is computed here over the DAG.
 * - FS links are modelled exactly; SS/FF/SF are approximated with a warning.
 * - Cycles are detected via Kahn's algorithm, warned, and the back-edges are
 *   dropped; the function NEVER throws on bad data.
 * - Summary tasks are excluded per the PSS spec (they cannot be dependency
 *   endpoints in PSS, and their dates roll up from children).
 */
export function computeCriticalPath(
  tasks: AnalyticsTask[],
  deps: AnalyticsDep[],
  options: CriticalPathOptions = {},
): CriticalPathResult {
  const floatToleranceDays = options.floatToleranceDays ?? 0.5;
  const nearCriticalDays = options.nearCriticalDays ?? 2;
  const whpd = options.workingHoursPerDay ?? DEFAULT_WORKING_HOURS_PER_DAY;
  const dayMs = workingDayMs(whpd);

  const warnings: string[] = [];

  // -------------------------------------------------------------------------
  // Step A — build the leaf DAG
  // -------------------------------------------------------------------------

  // Map taskId → AnalyticsTask for quick lookup
  const taskMap = new Map<string, AnalyticsTask>();
  for (const t of tasks) {
    taskMap.set(t.taskId.toLowerCase(), t);
  }

  // Filter to datable, non-summary leaves
  let excludedMissingDates = 0;
  const leafMap = new Map<string, AnalyticsTask>();
  for (const t of tasks) {
    if (t.isSummary) continue;
    if (toMs(t.start) === null || toMs(t.finish) === null) {
      excludedMissingDates++;
      continue;
    }
    leafMap.set(t.taskId.toLowerCase(), t);
  }
  if (excludedMissingDates > 0) {
    warnings.push(
      `${excludedMissingDates} task(s) excluded from critical path: missing scheduled dates.`,
    );
  }

  // Keep deps whose BOTH endpoints survive in the leaf set
  let skippedDeps = 0;
  let hasNonFS = false;
  let unknownTypeCount = 0;

  interface InternalDep {
    pred: string;
    succ: string;
    type: "FS" | "SS" | "FF" | "SF";
    lagMs: number;
  }

  const validDeps: InternalDep[] = [];
  for (const d of deps) {
    const pred = d.predecessorTaskId.toLowerCase();
    const succ = d.successorTaskId.toLowerCase();
    if (!leafMap.has(pred) || !leafMap.has(succ)) {
      skippedDeps++;
      continue;
    }
    // Normalise link type
    let type: "FS" | "SS" | "FF" | "SF";
    const raw = d.type;
    if (raw === "FS" || raw === "SS" || raw === "FF" || raw === "SF") {
      type = raw;
    } else {
      // "Unknown(N)" or undefined → treat as FS, warn once
      unknownTypeCount++;
      type = "FS";
    }
    if (type !== "FS") hasNonFS = true;
    validDeps.push({ pred, succ, type, lagMs: (d.lagMinutes ?? 0) * 60_000 });
  }
  if (skippedDeps > 0) {
    warnings.push(
      `${skippedDeps} dependency link(s) skipped: endpoint missing, summary, or undated.`,
    );
  }
  if (unknownTypeCount > 0) {
    warnings.push(
      `${unknownTypeCount} dependency link(s) had an unrecognised type and were treated as FS.`,
    );
  }
  if (hasNonFS) {
    warnings.push(
      "Plan contains SS/FF/SF links; their float is approximated from scheduled dates, not re-scheduled.",
    );
  }

  // Build adjacency maps
  const predsOf = new Map<string, InternalDep[]>(); // succ → [{pred, type, lagMs}]
  const succsOf = new Map<string, InternalDep[]>(); // pred → [{succ, type, lagMs}]
  for (const id of leafMap.keys()) {
    predsOf.set(id, []);
    succsOf.set(id, []);
  }
  for (const d of validDeps) {
    predsOf.get(d.succ)!.push(d);
    succsOf.get(d.pred)!.push(d);
  }

  // -------------------------------------------------------------------------
  // Step B — cycle guard (Kahn's algorithm → topological sort)
  // -------------------------------------------------------------------------
  const inDegree = new Map<string, number>();
  for (const id of leafMap.keys()) inDegree.set(id, 0);
  for (const d of validDeps) {
    inDegree.set(d.succ, (inDegree.get(d.succ) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const topoOrder: string[] = [];
  const finalized = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    topoOrder.push(node);
    finalized.add(node);
    for (const dep of succsOf.get(node) ?? []) {
      const newDeg = (inDegree.get(dep.succ) ?? 1) - 1;
      inDegree.set(dep.succ, newDeg);
      if (newDeg === 0) queue.push(dep.succ);
    }
  }

  // Detect cycle: nodes not yet finalized still have in-degree > 0
  const cycleNodes = new Set<string>();
  for (const [id, deg] of inDegree) {
    if (!finalized.has(id) && deg > 0) cycleNodes.add(id);
  }

  if (cycleNodes.size > 0) {
    warnings.push(
      "Dependency cycle detected; tasks in the cycle are excluded from float computation.",
    );
    // Remove cycle nodes from the leaf map and adjacency structures; proceed
    // with the acyclic remainder (already in topoOrder).
    for (const id of cycleNodes) {
      leafMap.delete(id);
      predsOf.delete(id);
      succsOf.delete(id);
    }
    // Also remove deps that reference cycle nodes
    for (const [id, preds] of predsOf) {
      predsOf.set(
        id,
        preds.filter((d) => !cycleNodes.has(d.pred)),
      );
    }
    for (const [id, succs] of succsOf) {
      succsOf.set(
        id,
        succs.filter((d) => !cycleNodes.has(d.succ)),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step C — forward pass = engine dates (no recompute)
  // -------------------------------------------------------------------------
  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();
  let projectStartMs: number | null = null;
  let projectFinishMs: number | null = null;
  // Echo the boundary tasks' ORIGINAL date strings rather than reconstructing
  // them with new Date(ms).toISOString() — the latter appends ".000Z" and would
  // diverge both from the engine value and from path[].start/finish (which
  // already echo the raw strings).
  let projectStartStr: string | null = null;
  let projectFinishStr: string | null = null;

  for (const [id, t] of leafMap) {
    const es = toMs(t.start)!;
    const ef = toMs(t.finish)!;
    earlyStart.set(id, es);
    earlyFinish.set(id, ef);
    if (projectStartMs === null || es < projectStartMs) {
      projectStartMs = es;
      projectStartStr = t.start;
    }
    if (projectFinishMs === null || ef > projectFinishMs) {
      projectFinishMs = ef;
      projectFinishStr = t.finish;
    }
  }

  if (leafMap.size === 0) {
    return {
      projectStart: null,
      projectFinish: null,
      totalDurationDays: null,
      path: [],
      criticalCount: 0,
      nearCriticalCount: 0,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Step D — backward pass (late finish / late start)
  // -------------------------------------------------------------------------
  const lateFinish = new Map<string, number>();
  const lateStart = new Map<string, number>();

  // Initialise all nodes to project finish
  for (const id of leafMap.keys()) {
    lateFinish.set(id, projectFinishMs!);
  }

  // Process in reverse topological order
  const reverseOrder = [...topoOrder].filter((id) => leafMap.has(id)).reverse();

  for (const n of reverseOrder) {
    const ef_n = earlyFinish.get(n)!;
    const es_n = earlyStart.get(n)!;
    const dur_n = ef_n - es_n; // calendar duration in ms (engine span)
    let lf = lateFinish.get(n)!;

    for (const dep of succsOf.get(n) ?? []) {
      const s = dep.succ;
      const lagMs = dep.lagMs;

      // Compute late start of successor (may not be finalized yet, but we
      // work in reverse topo order so it has been set already)
      const lf_s = lateFinish.get(s) ?? projectFinishMs!;
      const ef_s = earlyFinish.get(s)!;
      const es_s = earlyStart.get(s)!;
      const dur_s = ef_s - es_s;
      const ls_s = lf_s - dur_s;

      switch (dep.type) {
        case "FS":
          // successor starts after predecessor finishes + lag
          // constraint on n's late finish: lf[n] ≤ ls[s] - lagMs
          lf = Math.min(lf, ls_s - lagMs);
          break;
        case "SS":
          // successor starts after predecessor starts + lag
          // constraint on n's late start: ls[n] ≤ ls[s] - lagMs
          // → lf[n] = ls[n] + dur[n] ≤ (ls[s] - lagMs) + dur[n]
          lf = Math.min(lf, ls_s - lagMs + dur_n);
          break;
        case "FF":
          // successor finishes after predecessor finishes + lag
          // constraint: lf[n] ≤ lf[s] - lagMs
          lf = Math.min(lf, lf_s - lagMs);
          break;
        case "SF":
          // successor finishes after predecessor starts + lag (rare)
          // constraint on n's late finish: lf[n] ≤ ls[s] - lagMs + dur[n]
          lf = Math.min(lf, ls_s - lagMs + dur_n);
          break;
      }
    }

    lateFinish.set(n, lf);
    lateStart.set(n, lf - dur_n);
  }

  // -------------------------------------------------------------------------
  // Step E — total float
  // -------------------------------------------------------------------------
  interface FloatNode {
    id: string;
    floatDays: number;
  }
  const floatNodes: FloatNode[] = [];

  for (const [id] of leafMap) {
    const ef = earlyFinish.get(id)!;
    const lf = lateFinish.get(id) ?? projectFinishMs!;
    const totalFloatMs = lf - ef;
    const floatDays = Math.round((totalFloatMs / dayMs) * 10) / 10;
    floatNodes.push({ id, floatDays });
  }

  // -------------------------------------------------------------------------
  // Step F — critical chain extraction
  // -------------------------------------------------------------------------
  const criticalIds = new Set(
    floatNodes.filter((n) => n.floatDays <= floatToleranceDays).map((n) => n.id),
  );
  const nearCriticalIds = new Set(
    floatNodes
      .filter((n) => n.floatDays > floatToleranceDays && n.floatDays <= nearCriticalDays)
      .map((n) => n.id),
  );

  // Build an ordered chain of critical tasks: walk predecessor → successor
  // preferring critical successors. If multiple disconnected critical chains
  // exist, return the longest one and warn.
  const criticalChains: string[][] = [];

  // Find all critical tasks that have no critical predecessor (chain entry points)
  const hasCriticalPred = new Set<string>();
  for (const id of criticalIds) {
    for (const dep of predsOf.get(id) ?? []) {
      if (criticalIds.has(dep.pred)) {
        hasCriticalPred.add(id);
        break;
      }
    }
  }

  const chainStarts = [...criticalIds].filter((id) => !hasCriticalPred.has(id));

  // Walk each chain greedily
  for (const start of chainStarts) {
    const chain: string[] = [start];
    let current = start;
    const visited = new Set<string>([start]);

    for (;;) {
      // Find all critical successors
      const critSuccs = (succsOf.get(current) ?? [])
        .map((d) => d.succ)
        .filter((s) => criticalIds.has(s) && !visited.has(s));

      if (critSuccs.length === 0) break;

      // Prefer earliest early-start; tie-break by taskId
      critSuccs.sort((a, b) => {
        const diff = (earlyStart.get(a) ?? 0) - (earlyStart.get(b) ?? 0);
        if (diff !== 0) return diff;
        return a.localeCompare(b);
      });

      const next = critSuccs[0];
      chain.push(next);
      visited.add(next);
      current = next;
    }

    criticalChains.push(chain);
  }

  // Pick the longest chain
  criticalChains.sort((a, b) => b.length - a.length);
  const primaryChain = criticalChains[0] ?? [];
  const primaryChainSet = new Set(primaryChain);

  // Count critical tasks omitted from the primary chain
  const omittedCritical = [...criticalIds].filter((id) => !primaryChainSet.has(id));
  if (omittedCritical.length > 0) {
    warnings.push(
      `Multiple critical chains exist; showing the longest. ${omittedCritical.length} other critical task(s) omitted from the ordered path (still counted in criticalCount).`,
    );
  }

  // If no dependency links led to any critical chain structure, fall back:
  // find the single task(s) finishing at projectFinish (zero float naturally)
  // and return them ordered by early start.
  const chainToReturn =
    primaryChain.length > 0
      ? primaryChain
      : [...floatNodes]
          .filter((n) => n.floatDays <= floatToleranceDays)
          .sort((a, b) => (earlyStart.get(a.id) ?? 0) - (earlyStart.get(b.id) ?? 0))
          .map((n) => n.id);

  // Build float map for quick lookup
  const floatMap = new Map(floatNodes.map((n) => [n.id, n.floatDays]));

  const path = chainToReturn.map((id) => {
    const t = leafMap.get(id)!;
    return {
      taskId: id,
      subject: t.subject,
      start: t.start,
      finish: t.finish,
      floatDays: floatMap.get(id) ?? null,
      isMilestone: t.isMilestone,
    };
  });

  const totalDurationDays =
    projectStartMs !== null && projectFinishMs !== null
      ? Math.round(((projectFinishMs - projectStartMs) / (24 * 3600 * 1000)) * 10) / 10
      : null;

  return {
    projectStart: projectStartStr,
    projectFinish: projectFinishStr,
    totalDurationDays,
    path,
    criticalCount: criticalIds.size,
    nearCriticalCount: nearCriticalIds.size,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 2. computeScheduleHealth
// ---------------------------------------------------------------------------

export interface TaskRef {
  taskId: string;
  subject: string | null;
  finish: string | null;
  progressPercent: number | null;
}

export interface BlockedRef {
  taskId: string;
  subject: string | null;
  finish: string | null;
  blockingPredecessorId: string;
  blockingPredecessorSubject: string | null;
  predecessorProgressPercent: number | null;
}

export interface SummarySlip {
  taskId: string;
  subject: string | null;
  summaryFinish: string;
  latestChildFinish: string;
  slipDays: number;
}

export interface ScheduleHealthOptions {
  atRiskWithinDays?: number; // default 7
  atRiskMinProgressPercent?: number; // default 50 (0–100)
  maxListItems?: number; // default 50
}

export interface ScheduleHealthResult {
  counts: {
    totalTasks: number;
    leafTaskCount: number;
    summaryTaskCount: number;
    milestoneCount: number;
    overdueLeafCount: number;
    atRiskCount: number;
    blockedCount: number;
    milestonesAtRiskCount: number;
    slippingSummaryCount: number;
  };
  overdue: TaskRef[];
  atRisk: TaskRef[];
  blocked: BlockedRef[];
  milestonesAtRisk: TaskRef[];
  slippingSummaries: SummarySlip[];
  warnings: string[];
}

/**
 * Computes a schedule-risk rollup from the task list and dependency graph.
 *
 * Uses summariseTasks as the single source of truth for the overdue predicate
 * (keeps definition identical across list_plan_tasks, get_plan_summary, and
 * get_schedule_health). The blocked computation covers all link types because an
 * incomplete predecessor on any edge to a started successor is a risk signal —
 * noted in warnings when non-FS links exist.
 */
export function computeScheduleHealth(
  tasks: AnalyticsTask[],
  deps: AnalyticsDep[],
  now: string, // injected nowIso() from handler
  options: ScheduleHealthOptions = {},
): ScheduleHealthResult {
  const atRiskWithinDays = options.atRiskWithinDays ?? 7;
  const atRiskMinProgressPercent = options.atRiskMinProgressPercent ?? 50;
  const maxListItems = options.maxListItems ?? 50;

  const warnings: string[] = [];
  const nowMs = toMs(now) ?? Date.now();
  const windowMs = atRiskWithinDays * 24 * 3600 * 1000;
  const dayMs = 24 * 3600 * 1000;

  // Convert AnalyticsTask to RawTask shape for summariseTasks (single source of truth)
  const rawTasks = tasks.map((t) => ({
    msdyn_projecttaskid: t.taskId,
    msdyn_subject: t.subject ?? undefined,
    msdyn_ismilestone: t.isMilestone,
    msdyn_finish: t.finish ?? undefined,
    msdyn_progress: t.progress,
    _msdyn_parenttask_value: t.parentTaskId,
  }));
  const rollup = summariseTasks(rawTasks, now);

  // Build index: taskId → AnalyticsTask
  const taskIndex = new Map<string, AnalyticsTask>();
  for (const t of tasks) taskIndex.set(t.taskId.toLowerCase(), t);

  // Build parent → children map for slipping-summary computation
  const childrenOf = new Map<string, string[]>(); // parentId → [childId, ...]
  for (const t of tasks) {
    if (t.parentTaskId) {
      const pid = t.parentTaskId.toLowerCase();
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(t.taskId.toLowerCase());
    }
  }

  // Helper: overdue predicate (matches summariseTasks exactly)
  function isOverdue(t: AnalyticsTask): boolean {
    return (
      !t.isSummary &&
      t.finish !== null &&
      toMs(t.finish) !== null &&
      toMs(t.finish)! < nowMs &&
      typeof t.progress === "number" &&
      t.progress < 1
    );
  }

  // Overdue leaf tasks
  const overdueAll = tasks.filter(isOverdue);
  const overdueRefs: TaskRef[] = overdueAll.map((t) => ({
    taskId: t.taskId,
    subject: t.subject,
    finish: t.finish,
    progressPercent: typeof t.progress === "number" ? Math.round(t.progress * 100) : null,
  }));

  // At-risk: due within window, not yet overdue, below progress floor
  const atRiskAll = tasks.filter((t) => {
    if (t.isSummary) return false;
    const fm = toMs(t.finish);
    if (fm === null) return false;
    if (fm < nowMs) return false; // already overdue, not at-risk
    if (fm > nowMs + windowMs) return false; // outside window
    if (typeof t.progress !== "number") return false;
    return Math.round(t.progress * 100) <= atRiskMinProgressPercent;
  });
  const atRiskRefs: TaskRef[] = atRiskAll.map((t) => ({
    taskId: t.taskId,
    subject: t.subject,
    finish: t.finish,
    progressPercent: typeof t.progress === "number" ? Math.round(t.progress * 100) : null,
  }));

  // Blocked: incomplete predecessor, successor scheduled to have started, not complete
  // Check for non-FS deps to add warning
  const hasNonFSDeps = deps.some((d) => d.type !== "FS" && d.type !== undefined);
  if (hasNonFSDeps) {
    warnings.push(
      "Plan contains SS/FF/SF links; blocked detection treats all link types uniformly (an incomplete predecessor on any link to a started successor is flagged).",
    );
  }

  // Per-successor: find worst (least-complete) blocking predecessor
  const blockedMap = new Map<
    string,
    {
      task: AnalyticsTask;
      blocker: AnalyticsTask;
    }
  >();

  for (const dep of deps) {
    const succId = dep.successorTaskId.toLowerCase();
    const predId = dep.predecessorTaskId.toLowerCase();
    const succ = taskIndex.get(succId);
    const pred = taskIndex.get(predId);
    if (!succ || !pred) continue;
    if (succ.isSummary) continue; // only leaf successors counted

    // Successor must be scheduled to have started and not yet complete
    const succStartMs = toMs(succ.start);
    if (succStartMs === null || succStartMs > nowMs) continue;
    if (succ.progress !== null && succ.progress >= 1) continue;

    // Predecessor must be incomplete (null progress treated as incomplete → worst-case)
    if (pred.progress !== null && pred.progress >= 1) continue;

    // Keep the blocker with lowest progress (worst case)
    const existing = blockedMap.get(succId);
    const predPct =
      typeof pred.progress === "number" ? pred.progress : -1; // null treated as worst
    const existingPredPct =
      existing && typeof existing.blocker.progress === "number"
        ? existing.blocker.progress
        : -1;
    if (!existing || predPct < existingPredPct) {
      blockedMap.set(succId, { task: succ, blocker: pred });
    }
  }

  const blockedAll: BlockedRef[] = [...blockedMap.values()].map(({ task, blocker }) => ({
    taskId: task.taskId,
    subject: task.subject,
    finish: task.finish,
    blockingPredecessorId: blocker.taskId,
    blockingPredecessorSubject: blocker.subject,
    predecessorProgressPercent:
      typeof blocker.progress === "number" ? Math.round(blocker.progress * 100) : null,
  }));

  // Milestones at risk: milestone due within the window (or already past) and not done
  const milestonesAtRiskAll = tasks.filter((t) => {
    if (!t.isMilestone) return false;
    const fm = toMs(t.finish);
    if (fm === null) return false;
    if (fm > nowMs + windowMs) return false;
    return t.progress === null || t.progress < 1;
  });
  const milestonesAtRiskRefs: TaskRef[] = milestonesAtRiskAll.map((t) => ({
    taskId: t.taskId,
    subject: t.subject,
    finish: t.finish,
    progressPercent: typeof t.progress === "number" ? Math.round(t.progress * 100) : null,
  }));

  // Slipping summaries: a child finishes after its direct parent's finish
  const slippingAll: SummarySlip[] = [];
  for (const t of tasks) {
    if (!t.isSummary) continue;
    const fm = toMs(t.finish);
    if (fm === null) continue;
    const children = (childrenOf.get(t.taskId.toLowerCase()) ?? [])
      .map((cid) => taskIndex.get(cid))
      .filter(Boolean) as AnalyticsTask[];
    if (children.length === 0) continue;

    let latestChildMs: number | null = null;
    let latestChildFinishStr: string | null = null;
    for (const child of children) {
      const cm = toMs(child.finish);
      if (cm !== null && (latestChildMs === null || cm > latestChildMs)) {
        latestChildMs = cm;
        latestChildFinishStr = child.finish;
      }
    }
    if (latestChildMs !== null && latestChildMs > fm) {
      const slipDays = Math.round(((latestChildMs - fm) / dayMs) * 10) / 10;
      slippingAll.push({
        taskId: t.taskId,
        subject: t.subject,
        summaryFinish: t.finish!,
        latestChildFinish: latestChildFinishStr!,
        slipDays,
      });
    }
  }

  // Apply list caps
  function cap<T>(arr: T[], kind: string): T[] {
    if (arr.length <= maxListItems) return arr;
    warnings.push(
      `${kind} list truncated to ${maxListItems} of ${arr.length}; counts reflect the full total.`,
    );
    return arr.slice(0, maxListItems);
  }

  return {
    counts: {
      totalTasks: rollup.totalTasks,
      leafTaskCount: rollup.leafTaskCount,
      summaryTaskCount: rollup.summaryTaskCount,
      milestoneCount: rollup.milestoneCount,
      overdueLeafCount: rollup.overdueLeafTaskCount,
      atRiskCount: atRiskAll.length,
      blockedCount: blockedAll.length,
      milestonesAtRiskCount: milestonesAtRiskAll.length,
      slippingSummaryCount: slippingAll.length,
    },
    overdue: cap(overdueRefs, "overdue"),
    atRisk: cap(atRiskRefs, "atRisk"),
    blocked: cap(blockedAll, "blocked"),
    milestonesAtRisk: cap(milestonesAtRiskRefs, "milestonesAtRisk"),
    slippingSummaries: cap(slippingAll, "slippingSummaries"),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. computeResourceWorkload
// ---------------------------------------------------------------------------

export interface Assignment {
  taskId: string; // lowercased
  teamMemberId: string | null;
  name: string | null;
}

export interface ResourceWorkloadResult {
  members: Array<{
    teamMemberId: string | null;
    name: string | null;
    assignedTaskCount: number;
    totalEffortHours: number | null;
    remainingEffortHours: number | null;
    overdueTaskCount: number;
  }>;
  warnings: string[];
}

const UNASSIGNED_KEY = "(Unassigned)";

/**
 * Computes per-team-member workload from a leaf task list + assignment rows.
 *
 * Identity is traced by teamMemberId (resource id), never by display name.
 * A task assigned to two members counts once per member (but appears in both
 * their `assignedTaskCount` and effort totals). Only leaf tasks are counted —
 * summary effort rolls up from children and would double-count.
 * Tasks with no assignment row fall into the synthetic `(Unassigned)` bucket.
 */
export function computeResourceWorkload(
  tasks: AnalyticsTask[],
  assignments: Assignment[],
  now: string,
  options: { hasRemainingEffort?: boolean } = {},
): ResourceWorkloadResult {
  const hasRemainingEffort = options.hasRemainingEffort ?? false;
  const warnings: string[] = [];
  const nowMs = toMs(now) ?? Date.now();

  // Index leaf tasks (drop summaries)
  const leafIndex = new Map<string, AnalyticsTask>();
  for (const t of tasks) {
    if (!t.isSummary) leafIndex.set(t.taskId.toLowerCase(), t);
  }

  // Overdue predicate (same as summariseTasks)
  function isOverdue(t: AnalyticsTask): boolean {
    const fm = toMs(t.finish);
    return (
      fm !== null && fm < nowMs && typeof t.progress === "number" && t.progress < 1
    );
  }

  // Build per-member buckets keyed by teamMemberId
  // Key: teamMemberId string (for real members) or UNASSIGNED_KEY
  interface Bucket {
    teamMemberId: string | null;
    name: string | null;
    taskSet: Set<string>; // distinct leaf task ids
    totalEffortMs: number; // accumulate then convert
    remainingEffortMs: number;
    overdueCount: number;
  }

  const buckets = new Map<string, Bucket>();

  function getBucket(memberId: string | null, name: string | null): Bucket {
    const key = memberId ?? UNASSIGNED_KEY;
    if (!buckets.has(key)) {
      buckets.set(key, {
        teamMemberId: memberId,
        name,
        taskSet: new Set(),
        totalEffortMs: 0,
        remainingEffortMs: 0,
        overdueCount: 0,
      });
    }
    return buckets.get(key)!;
  }

  // Track which leaf task ids appear in any assignment
  const assignedLeafIds = new Set<string>();
  let orphanCount = 0;

  for (const a of assignments) {
    const tid = a.taskId.toLowerCase();
    const t = leafIndex.get(tid);
    if (!t) {
      // Task not in the scanned page set (truncated or non-existent)
      orphanCount++;
      continue;
    }
    assignedLeafIds.add(tid);
    const bucket = getBucket(a.teamMemberId, a.name);
    if (!bucket.taskSet.has(tid)) {
      // Add task to this member's bucket
      bucket.taskSet.add(tid);
      bucket.totalEffortMs += (t.effort ?? 0) * 3600 * 1000;
      if (hasRemainingEffort) {
        bucket.remainingEffortMs += (t.remainingEffort ?? 0) * 3600 * 1000;
      }
      if (isOverdue(t)) bucket.overdueCount++;
    }
  }

  if (orphanCount > 0) {
    warnings.push(
      `${orphanCount} assignment(s) referenced tasks outside the scanned page set.`,
    );
  }

  // All unassigned leaf tasks → Unassigned bucket
  for (const [tid, t] of leafIndex) {
    if (!assignedLeafIds.has(tid)) {
      const bucket = getBucket(null, null);
      if (!bucket.taskSet.has(tid)) {
        bucket.taskSet.add(tid);
        bucket.totalEffortMs += (t.effort ?? 0) * 3600 * 1000;
        if (hasRemainingEffort) {
          bucket.remainingEffortMs += (t.remainingEffort ?? 0) * 3600 * 1000;
        }
        if (isOverdue(t)) bucket.overdueCount++;
      }
    }
  }

  if (!hasRemainingEffort) {
    warnings.push(
      "Extended scheduling fields (remaining effort) are not available on this environment; remainingEffortHours is null.",
    );
  }

  // Convert to output shape and sort by assignedTaskCount desc, then name
  const members = [...buckets.values()]
    .map((b) => ({
      teamMemberId: b.teamMemberId,
      name: b.name,
      assignedTaskCount: b.taskSet.size,
      totalEffortHours:
        b.totalEffortMs > 0 ? Math.round((b.totalEffortMs / (3600 * 1000)) * 10) / 10 : 0,
      remainingEffortHours: hasRemainingEffort
        ? Math.round((b.remainingEffortMs / (3600 * 1000)) * 10) / 10
        : null,
      overdueTaskCount: b.overdueCount,
    }))
    .sort((a, b) => {
      const diff = b.assignedTaskCount - a.assignedTaskCount;
      if (diff !== 0) return diff;
      return (a.name ?? UNASSIGNED_KEY).localeCompare(b.name ?? UNASSIGNED_KEY);
    });

  return { members, warnings };
}
