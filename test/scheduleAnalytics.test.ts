/**
 * Pure-core unit tests for scheduleAnalytics.ts.
 *
 * No network, no env. All three cores are tested with hand-built data and
 * a fixed "now" string. Real numbers are asserted (no snapshots).
 *
 * Test clock: 2026-06-15T00:00:00Z  (matches readHelpers.test.ts convention)
 */
import { describe, it, expect } from "vitest";
import {
  computeCriticalPath,
  computeScheduleHealth,
  computeResourceWorkload,
  type AnalyticsTask,
  type AnalyticsDep,
  type Assignment,
} from "../src/tools/scheduleAnalytics.js";

const NOW = "2026-06-15T00:00:00Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal leaf AnalyticsTask. Dates are ISO strings at midnight UTC. */
function leaf(
  id: string,
  start: string,
  finish: string,
  opts: Partial<AnalyticsTask> = {},
): AnalyticsTask {
  return {
    taskId: id,
    subject: id,
    start,
    finish,
    progress: opts.progress ?? 0,
    isMilestone: opts.isMilestone ?? false,
    isSummary: opts.isSummary ?? false,
    parentTaskId: opts.parentTaskId ?? null,
    effort: opts.effort ?? null,
    remainingEffort: opts.remainingEffort ?? null,
    ...opts,
  };
}

function summary(id: string, start: string, finish: string, parentId?: string): AnalyticsTask {
  return leaf(id, start, finish, { isSummary: true, parentTaskId: parentId ?? null });
}

function fsDep(pred: string, succ: string, lagMinutes?: number): AnalyticsDep {
  return { predecessorTaskId: pred, successorTaskId: succ, type: "FS", lagMinutes: lagMinutes ?? null };
}

// ---------------------------------------------------------------------------
// computeCriticalPath tests
// ---------------------------------------------------------------------------

describe("computeCriticalPath", () => {
  describe("linear chain (A→B→C, all FS, no lag)", () => {
    // Contiguous days: A 1-2, B 2-3, C 3-4 (Jan 2026, 1-day tasks, 8h/day)
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002";
    const C = "cccccccc-0000-0000-0000-000000000003";

    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      leaf(B, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"),
      leaf(C, "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"),
    ];
    const deps = [fsDep(A, B), fsDep(B, C)];

    it("returns path [A, B, C] and all floatDays ≈ 0", () => {
      const r = computeCriticalPath(tasks, deps, { floatToleranceDays: 0.5 });
      const ids = r.path.map((p) => p.taskId);
      expect(ids).toEqual([A, B, C]);
      for (const p of r.path) {
        expect(p.floatDays).toBeLessThanOrEqual(0.5);
      }
    });

    it("criticalCount = 3, nearCriticalCount = 0", () => {
      const r = computeCriticalPath(tasks, deps);
      expect(r.criticalCount).toBe(3);
      expect(r.nearCriticalCount).toBe(0);
    });

    it("projectFinish equals C.finish", () => {
      const r = computeCriticalPath(tasks, deps);
      expect(r.projectFinish).toBe("2026-01-04T00:00:00Z");
    });

    it("projectStart equals A.start", () => {
      const r = computeCriticalPath(tasks, deps);
      expect(r.projectStart).toBe("2026-01-01T00:00:00Z");
    });

    it("totalDurationDays = 3 (calendar days)", () => {
      const r = computeCriticalPath(tasks, deps);
      expect(r.totalDurationDays).toBe(3);
    });
  });

  describe("diamond (A→B, A→C, B→D, C→D) — B on long branch, C on short", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002"; // long branch: 2 days
    const C = "cccccccc-0000-0000-0000-000000000003"; // short branch: 1 day
    const D = "dddddddd-0000-0000-0000-000000000004";

    // A: day 1; B: day 2-3 (2d); C: day 2 (1d); D: day 4 (1d)
    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      leaf(B, "2026-01-02T00:00:00Z", "2026-01-04T00:00:00Z"), // 2-day task
      leaf(C, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"), // 1-day task (slack)
      leaf(D, "2026-01-04T00:00:00Z", "2026-01-05T00:00:00Z"),
    ];
    const deps = [fsDep(A, B), fsDep(A, C), fsDep(B, D), fsDep(C, D)];

    it("critical path is A→B→D (the long branch)", () => {
      const r = computeCriticalPath(tasks, deps, { floatToleranceDays: 0.5 });
      const ids = r.path.map((p) => p.taskId);
      expect(ids).toContain(A);
      expect(ids).toContain(B);
      expect(ids).toContain(D);
      expect(ids).not.toContain(C);
    });

    it("C has positive float and is not in the critical set", () => {
      const r = computeCriticalPath(tasks, deps, { floatToleranceDays: 0.5 });
      const Cfloat = r.path.find((p) => p.taskId === C);
      // C should not be on the critical path
      expect(Cfloat).toBeUndefined();
      // criticalCount counts A, B, D (zero-float tasks)
      expect(r.criticalCount).toBe(3);
    });
  });

  describe("parallel independent branches (A→B and C→D, no cross-link)", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002";
    const C = "cccccccc-0000-0000-0000-000000000003"; // ends later
    const D = "dddddddd-0000-0000-0000-000000000004"; // ends later

    // Branch 1: A→B, ends day 3
    // Branch 2: C→D, ends day 5 (longer)
    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      leaf(B, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"),
      leaf(C, "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"),
      leaf(D, "2026-01-03T00:00:00Z", "2026-01-05T00:00:00Z"),
    ];
    const deps = [fsDep(A, B), fsDep(C, D)];

    it("returns the longer chain C→D as the path", () => {
      const r = computeCriticalPath(tasks, deps, { floatToleranceDays: 0.5 });
      const ids = r.path.map((p) => p.taskId);
      // The path must contain C and D (the chain ending at projectFinish)
      expect(ids).toContain(C);
      expect(ids).toContain(D);
    });

    it("does NOT warn about multiple critical chains (only C→D is critical; A→B carries float)", () => {
      // Correct CPM: branch A→B finishes day 3 while the project ends day 5, so
      // A and B carry float and are NOT critical. Only the C→D chain is critical,
      // i.e. there is a single critical chain here — no multi-chain warning.
      const r = computeCriticalPath(tasks, deps, { floatToleranceDays: 0.5 });
      const hasMultiChainWarn = r.warnings.some((w) =>
        /multiple critical chains/i.test(w),
      );
      expect(hasMultiChainWarn).toBe(false);
    });

    it("criticalCount counts only the zero-float tasks (C and D)", () => {
      const r = computeCriticalPath(tasks, deps, { floatToleranceDays: 0.5 });
      // C and D finish as late as allowed (zero float); A and B carry float.
      expect(r.criticalCount).toBe(2);
    });
  });

  describe("multiple critical chains (two independent terminals at projectFinish)", () => {
    const A = "aaaaaaaa-0000-0000-0000-00000000000a"; // standalone terminal, 0 float
    const C = "cccccccc-0000-0000-0000-00000000000c";
    const D = "dddddddd-0000-0000-0000-00000000000d";
    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z"),
      leaf(C, "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"),
      leaf(D, "2026-01-03T00:00:00Z", "2026-01-05T00:00:00Z"),
    ];
    const deps = [fsDep(C, D)];

    it("warns about multiple critical chains and returns the longer C→D path", () => {
      const r = computeCriticalPath(tasks, deps, { floatToleranceDays: 0.5 });
      expect(r.warnings.some((w) => /multiple critical chains/i.test(w))).toBe(true);
      const ids = r.path.map((p) => p.taskId);
      expect(ids).toContain(C);
      expect(ids).toContain(D);
    });
  });

  describe("lag edge (A→B FS lag=480 min = 1 working day)", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002";

    // A: day 1 (1d), B: day 3-4 (1d after 1-day lag)
    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      leaf(B, "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"),
    ];
    const deps = [{ predecessorTaskId: A, successorTaskId: B, type: "FS" as const, lagMinutes: 480 }];

    it("does not throw and returns finite float values", () => {
      expect(() => computeCriticalPath(tasks, deps)).not.toThrow();
      const r = computeCriticalPath(tasks, deps);
      for (const p of r.path) {
        expect(p.floatDays).not.toBeNaN();
        expect(Number.isFinite(p.floatDays)).toBe(true);
      }
    });

    it("projectFinish = B.finish", () => {
      const r = computeCriticalPath(tasks, deps);
      expect(r.projectFinish).toBe("2026-01-04T00:00:00Z");
    });
  });

  describe("no dependencies", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002"; // finishes last
    const C = "cccccccc-0000-0000-0000-000000000003";

    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"),
      leaf(B, "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z"),
      leaf(C, "2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z"),
    ];

    it("does not throw with empty deps", () => {
      expect(() => computeCriticalPath(tasks, [])).not.toThrow();
    });

    it("B (latest finisher) is on the path", () => {
      const r = computeCriticalPath(tasks, [], { floatToleranceDays: 0.5 });
      const ids = r.path.map((p) => p.taskId);
      expect(ids).toContain(B);
    });

    it("A and C have positive float", () => {
      const r = computeCriticalPath(tasks, [], { floatToleranceDays: 0.5 });
      const floatMap = new Map(r.path.map((p) => [p.taskId, p.floatDays]));
      // A and C are not on the longest chain so they should not be in the path;
      // their float is positive (they finish before projectFinish = B.finish)
      // We just assert criticalCount (only B has zero float)
      expect(r.criticalCount).toBe(1);
    });
  });

  describe("cycle (A→B→A)", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002";

    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      leaf(B, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"),
    ];
    const deps = [fsDep(A, B), fsDep(B, A)]; // creates a cycle

    it("does NOT throw", () => {
      expect(() => computeCriticalPath(tasks, deps)).not.toThrow();
    });

    it("includes a cycle warning", () => {
      const r = computeCriticalPath(tasks, deps);
      const hasCycleWarn = r.warnings.some((w) => /cycle/i.test(w));
      expect(hasCycleWarn).toBe(true);
    });
  });

  describe("tasks with null dates", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002"; // has dates
    const C = "cccccccc-0000-0000-0000-000000000003"; // null dates

    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      leaf(B, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"),
      { ...leaf(A, "", ""), taskId: C, start: null, finish: null, subject: "No dates" },
    ];

    it("excludes the null-date task with a warning, rest compute normally", () => {
      const r = computeCriticalPath([tasks[0], tasks[1], tasks[2]], [fsDep(A, B)]);
      const hasExcludeWarn = r.warnings.some((w) => /excluded.*missing scheduled dates/i.test(w));
      expect(hasExcludeWarn).toBe(true);
      // The two dated tasks still produce a valid result
      expect(r.criticalCount).toBeGreaterThan(0);
    });
  });

  describe("SS/FF/SF links present", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002";

    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z"),
      leaf(B, "2026-01-02T00:00:00Z", "2026-01-06T00:00:00Z"),
    ];
    const deps: AnalyticsDep[] = [
      { predecessorTaskId: A, successorTaskId: B, type: "SS", lagMinutes: null },
    ];

    it("fires the SS/FF/SF approximation warning", () => {
      const r = computeCriticalPath(tasks, deps);
      const hasWarn = r.warnings.some((w) => /SS\/FF\/SF/i.test(w));
      expect(hasWarn).toBe(true);
    });

    it("produces finite (not NaN) float for SS edge", () => {
      const r = computeCriticalPath(tasks, deps);
      for (const p of r.path) {
        if (p.floatDays !== null) {
          expect(Number.isFinite(p.floatDays)).toBe(true);
        }
      }
    });
  });

  describe("unknown link type", () => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002";

    const tasks = [
      leaf(A, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      leaf(B, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"),
    ];
    const deps: AnalyticsDep[] = [
      { predecessorTaskId: A, successorTaskId: B, type: "Unknown", lagMinutes: null },
    ];

    it("treats unknown as FS and fires an unrecognised-type warning", () => {
      const r = computeCriticalPath(tasks, deps);
      const hasWarn = r.warnings.some((w) => /unrecognised type/i.test(w));
      expect(hasWarn).toBe(true);
      // Result should still be meaningful (not NaN, not empty)
      expect(r.criticalCount).toBeGreaterThan(0);
    });
  });

  describe("summary-task exclusion", () => {
    const P = "pppppppp-0000-0000-0000-000000000001";
    const C1 = "cccccccc-0000-0000-0000-000000000002";
    const C2 = "cccccccc-0000-0000-0000-000000000003";

    const tasks = [
      summary(P, "2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z"),
      leaf(C1, "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", { parentTaskId: P }),
      leaf(C2, "2026-01-03T00:00:00Z", "2026-01-05T00:00:00Z", { parentTaskId: P }),
    ];
    // A dep from P (summary) to C2 — should be skipped
    const deps: AnalyticsDep[] = [fsDep(P, C2)];

    it("excludes the summary task and the dep that references it", () => {
      const r = computeCriticalPath(tasks, deps);
      const pathIds = r.path.map((p) => p.taskId);
      expect(pathIds).not.toContain(P);
      // Dep skipped warning should appear
      const hasSkipWarn = r.warnings.some((w) => /dependency link.*skipped/i.test(w));
      expect(hasSkipWarn).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// computeScheduleHealth tests
// ---------------------------------------------------------------------------

describe("computeScheduleHealth", () => {
  const parentId = "pppppppp-0000-0000-0000-000000000001";
  const childId = "cccccccc-0000-0000-0000-000000000002";
  const leafId = "llllllll-0000-0000-0000-000000000003";
  const mileId = "mmmmmmmm-0000-0000-0000-000000000004";

  describe("overdue predicate", () => {
    it("counts overdue leaf tasks (past finish, <100%)", () => {
      const tasks = [
        leaf(leafId, "2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z", { progress: 0.2 }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW);
      expect(r.counts.overdueLeafCount).toBe(1);
      expect(r.overdue).toHaveLength(1);
      expect(r.overdue[0].taskId).toBe(leafId);
    });

    it("does NOT count a summary parent as overdue (same dates)", () => {
      // A summary with an overdue finish — must NOT be counted
      const tasks = [
        summary(parentId, "2026-01-01T00:00:00Z", "2026-06-10T00:00:00Z"),
        leaf(childId, "2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z", {
          parentTaskId: parentId,
          progress: 0,
        }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW);
      expect(r.counts.overdueLeafCount).toBe(0);
      expect(r.overdue.map((o) => o.taskId)).not.toContain(parentId);
    });

    it("does NOT count a 100% complete task as overdue", () => {
      const tasks = [
        leaf(leafId, "2026-01-01T00:00:00Z", "2026-06-10T00:00:00Z", { progress: 1 }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW);
      expect(r.counts.overdueLeafCount).toBe(0);
    });
  });

  describe("at-risk window", () => {
    it("flags a leaf due within 7 days at 30% as at-risk", () => {
      // NOW = 2026-06-15, due = 2026-06-18 (3 days ahead), 30% done
      const tasks = [
        leaf(leafId, "2026-06-10T00:00:00Z", "2026-06-18T00:00:00Z", { progress: 0.3 }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW, { atRiskWithinDays: 7, atRiskMinProgressPercent: 50 });
      expect(r.counts.atRiskCount).toBe(1);
      expect(r.atRisk[0].taskId).toBe(leafId);
    });

    it("does NOT flag a task at 80% as at-risk (above the progress floor)", () => {
      const tasks = [
        leaf(leafId, "2026-06-10T00:00:00Z", "2026-06-18T00:00:00Z", { progress: 0.8 }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW, { atRiskWithinDays: 7, atRiskMinProgressPercent: 50 });
      expect(r.counts.atRiskCount).toBe(0);
    });

    it("does NOT flag a task due 45 days out (outside the window)", () => {
      const tasks = [
        leaf(leafId, "2026-06-10T00:00:00Z", "2026-07-30T00:00:00Z", { progress: 0.1 }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW, { atRiskWithinDays: 7, atRiskMinProgressPercent: 50 });
      expect(r.counts.atRiskCount).toBe(0);
    });
  });

  describe("blocked detection", () => {
    const P = "pppppppp-0000-0000-0000-000000000010";
    const S = "ssssssss-0000-0000-0000-000000000011";

    it("flags successor as blocked when: succ.start <= now, pred incomplete, succ incomplete", () => {
      const tasks = [
        leaf(P, "2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z", { progress: 0.4 }),
        // Successor was scheduled to start 2026-06-12 (before NOW=2026-06-15)
        leaf(S, "2026-06-12T00:00:00Z", "2026-06-20T00:00:00Z", { progress: 0 }),
      ];
      const deps: AnalyticsDep[] = [fsDep(P, S)];
      const r = computeScheduleHealth(tasks, deps, NOW);
      expect(r.counts.blockedCount).toBe(1);
      expect(r.blocked[0].taskId).toBe(S);
      expect(r.blocked[0].blockingPredecessorId).toBe(P);
    });

    it("does NOT flag as blocked when predecessor is 100% complete", () => {
      const tasks = [
        leaf(P, "2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z", { progress: 1 }),
        leaf(S, "2026-06-12T00:00:00Z", "2026-06-20T00:00:00Z", { progress: 0 }),
      ];
      const deps: AnalyticsDep[] = [fsDep(P, S)];
      const r = computeScheduleHealth(tasks, deps, NOW);
      expect(r.counts.blockedCount).toBe(0);
    });

    it("returns empty blocked array when no deps are provided", () => {
      const tasks = [
        leaf(P, "2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z", { progress: 0.4 }),
        leaf(S, "2026-06-12T00:00:00Z", "2026-06-20T00:00:00Z", { progress: 0 }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW);
      expect(r.counts.blockedCount).toBe(0);
      expect(r.blocked).toHaveLength(0);
    });
  });

  describe("milestones at risk", () => {
    it("flags a milestone due within the window at 0% as at risk", () => {
      // Milestone due 2026-06-16 (1 day from NOW), 0% done
      const tasks = [
        leaf(mileId, "2026-06-16T00:00:00Z", "2026-06-16T00:00:00Z", {
          isMilestone: true,
          progress: 0,
        }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW, { atRiskWithinDays: 7 });
      expect(r.counts.milestonesAtRiskCount).toBe(1);
      expect(r.milestonesAtRisk[0].taskId).toBe(mileId);
    });

    it("does NOT flag a completed milestone as at risk", () => {
      const tasks = [
        leaf(mileId, "2026-06-10T00:00:00Z", "2026-06-10T00:00:00Z", {
          isMilestone: true,
          progress: 1,
        }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW);
      expect(r.counts.milestonesAtRiskCount).toBe(0);
    });
  });

  describe("slipping summaries", () => {
    const parent = "pppppppp-0000-0000-0000-000000000020";
    const child1 = "cccccccc-0000-0000-0000-000000000021";
    const child2 = "cccccccc-0000-0000-0000-000000000022";

    it("detects a child finishing after its summary parent", () => {
      const tasks = [
        summary(parent, "2026-06-01T00:00:00Z", "2026-06-20T00:00:00Z"),
        leaf(child1, "2026-06-01T00:00:00Z", "2026-06-18T00:00:00Z", { parentTaskId: parent }),
        // child2 finishes after parent's finish -> slip
        leaf(child2, "2026-06-01T00:00:00Z", "2026-06-25T00:00:00Z", { parentTaskId: parent }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW);
      expect(r.counts.slippingSummaryCount).toBe(1);
      expect(r.slippingSummaries[0].taskId).toBe(parent);
      expect(r.slippingSummaries[0].slipDays).toBe(5);
    });

    it("does NOT flag a summary when all children finish on time", () => {
      const tasks = [
        summary(parent, "2026-06-01T00:00:00Z", "2026-06-20T00:00:00Z"),
        leaf(child1, "2026-06-01T00:00:00Z", "2026-06-18T00:00:00Z", { parentTaskId: parent }),
      ];
      const r = computeScheduleHealth(tasks, [], NOW);
      expect(r.counts.slippingSummaryCount).toBe(0);
    });
  });

  describe("list cap", () => {
    it("truncates overdue list to maxListItems=50 but counts still reflect full total", () => {
      // Create 60 overdue leaf tasks
      const tasks: AnalyticsTask[] = [];
      for (let i = 0; i < 60; i++) {
        const id = `${String(i).padStart(8, "0")}-0000-0000-0000-000000000001`;
        tasks.push(
          leaf(id, "2026-01-01T00:00:00Z", "2026-06-10T00:00:00Z", { progress: 0.1 }),
        );
      }
      const r = computeScheduleHealth(tasks, [], NOW, { maxListItems: 50 });
      expect(r.overdue).toHaveLength(50);
      expect(r.counts.overdueLeafCount).toBe(60);
      const hasTruncWarn = r.warnings.some((w) => /truncated to 50 of 60/i.test(w));
      expect(hasTruncWarn).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// computeResourceWorkload tests
// ---------------------------------------------------------------------------

describe("computeResourceWorkload", () => {
  const M1_ID = "m1m1m1m1-0000-0000-0000-000000000001";
  const M2_ID = "m2m2m2m2-0000-0000-0000-000000000002";
  const T1 = "tttttttt-0000-0000-0000-000000000001";
  const T2 = "tttttttt-0000-0000-0000-000000000002";
  const T3 = "tttttttt-0000-0000-0000-000000000003";

  describe("two members, shared task", () => {
    it("both members get T1 counted once each", () => {
      const tasks = [
        leaf(T1, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 8, remainingEffort: 4 }),
        leaf(T2, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 16, remainingEffort: 8 }),
      ];
      const assignments: Assignment[] = [
        { taskId: T1, teamMemberId: M1_ID, name: "Alice" },
        { taskId: T1, teamMemberId: M2_ID, name: "Bob" },
        { taskId: T2, teamMemberId: M1_ID, name: "Alice" },
      ];
      const r = computeResourceWorkload(tasks, assignments, NOW, { hasRemainingEffort: true });
      const alice = r.members.find((m) => m.name === "Alice");
      const bob = r.members.find((m) => m.name === "Bob");

      expect(alice).toBeDefined();
      expect(bob).toBeDefined();
      expect(alice!.assignedTaskCount).toBe(2); // T1 + T2
      expect(bob!.assignedTaskCount).toBe(1);   // T1 only
    });
  });

  describe("unassigned task", () => {
    it("task with no assignment row falls into (Unassigned) bucket", () => {
      const tasks = [
        leaf(T1, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 8 }),
        leaf(T2, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 16 }),
      ];
      const assignments: Assignment[] = [
        { taskId: T1, teamMemberId: M1_ID, name: "Alice" },
        // T2 has no assignment
      ];
      const r = computeResourceWorkload(tasks, assignments, NOW, { hasRemainingEffort: false });
      const unassigned = r.members.find((m) => m.teamMemberId === null);
      expect(unassigned).toBeDefined();
      expect(unassigned!.assignedTaskCount).toBe(1);
      expect(unassigned!.totalEffortHours).toBe(16);
    });
  });

  describe("overdue per member", () => {
    it("M1 has one overdue leaf → overdueTaskCount=1", () => {
      const tasks = [
        // Overdue: finish in past, <100%
        leaf(T1, "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z", { progress: 0.2, effort: 8 }),
        // Not overdue: future
        leaf(T2, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { progress: 0, effort: 8 }),
      ];
      const assignments: Assignment[] = [
        { taskId: T1, teamMemberId: M1_ID, name: "Alice" },
        { taskId: T2, teamMemberId: M1_ID, name: "Alice" },
      ];
      const r = computeResourceWorkload(tasks, assignments, NOW, { hasRemainingEffort: false });
      const alice = r.members.find((m) => m.teamMemberId === M1_ID);
      expect(alice!.overdueTaskCount).toBe(1);
    });
  });

  describe("no remaining effort (capability absent)", () => {
    it("every member's remainingEffortHours is null when hasRemainingEffort=false", () => {
      const tasks = [leaf(T1, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 8, remainingEffort: 4 })];
      const assignments: Assignment[] = [{ taskId: T1, teamMemberId: M1_ID, name: "Alice" }];
      const r = computeResourceWorkload(tasks, assignments, NOW, { hasRemainingEffort: false });
      for (const m of r.members) {
        expect(m.remainingEffortHours).toBeNull();
      }
      const hasWarn = r.warnings.some((w) => /remaining effort.*not available/i.test(w));
      expect(hasWarn).toBe(true);
    });
  });

  describe("summary task assigned", () => {
    it("assignment to a summary task is NOT counted (effort/overdue excluded)", () => {
      const parent = "pppppppp-0000-0000-0000-000000000001";
      const child = "cccccccc-0000-0000-0000-000000000002";
      const tasks = [
        summary(parent, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"),
        leaf(child, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { parentTaskId: parent, effort: 8 }),
      ];
      const assignments: Assignment[] = [
        // Assign to the summary — should be ignored
        { taskId: parent, teamMemberId: M1_ID, name: "Alice" },
      ];
      const r = computeResourceWorkload(tasks, assignments, NOW, { hasRemainingEffort: false });
      const alice = r.members.find((m) => m.teamMemberId === M1_ID);
      // Summary is not a leaf, so Alice gets zero assignedTaskCount
      expect(alice).toBeUndefined();
      // The child falls into unassigned
      const unassigned = r.members.find((m) => m.teamMemberId === null);
      expect(unassigned).toBeDefined();
      expect(unassigned!.assignedTaskCount).toBe(1);
    });
  });

  describe("orphan assignment (task id not in task list)", () => {
    it("skips the orphan and adds a warning", () => {
      const tasks = [leaf(T1, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 8 })];
      const ORPHAN_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
      const assignments: Assignment[] = [
        { taskId: T1, teamMemberId: M1_ID, name: "Alice" },
        { taskId: ORPHAN_ID, teamMemberId: M2_ID, name: "Bob" }, // orphan
      ];
      const r = computeResourceWorkload(tasks, assignments, NOW, { hasRemainingEffort: false });
      const hasWarn = r.warnings.some((w) => /assignment.*outside the scanned/i.test(w));
      expect(hasWarn).toBe(true);
      // Bob (orphan) should not appear as a member
      const bob = r.members.find((m) => m.name === "Bob");
      expect(bob).toBeUndefined();
    });
  });

  describe("sort order", () => {
    it("sorts by assignedTaskCount desc, then name asc", () => {
      const tasks = [
        leaf(T1, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 8 }),
        leaf(T2, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 8 }),
        leaf(T3, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", { effort: 8 }),
      ];
      const assignments: Assignment[] = [
        { taskId: T1, teamMemberId: M1_ID, name: "Zelda" }, // 1 task
        { taskId: T2, teamMemberId: M2_ID, name: "Alice" }, // 2 tasks
        { taskId: T3, teamMemberId: M2_ID, name: "Alice" },
      ];
      const r = computeResourceWorkload(tasks, assignments, NOW, { hasRemainingEffort: false });
      expect(r.members[0].name).toBe("Alice"); // 2 tasks first
      expect(r.members[1].name).toBe("Zelda"); // 1 task second
    });
  });
});
