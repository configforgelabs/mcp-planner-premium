import { describe, it, expect } from "vitest";
import {
  planTaskBatches,
  planDependencyBatches,
  planProgressItems,
  buildPlanBlueprint,
  planResumeBuild,
  DEFAULT_BATCH_SIZE,
  type TaskBatch,
} from "./e2e/seed/planBuild.js";
import {
  CACHE_VERSION,
  blankCheckpoint,
  type SeedCache,
} from "./e2e/seed/cache.js";
import { hashFixture, type Fixture } from "./e2e/seed/hashFixture.js";

// ── Synthetic fixture ─────────────────────────────────────────────────────────
//
// 8 tasks, 2 hierarchy levels, 1 leaf-to-leaf dependency, 1 summary-linked dep
// (which should be dropped).
//
// Hierarchy:
//   1 (L1 root)
//     2 (L2 child of 1)
//     3 (L2 child of 1)
//   4 (L1 root)
//     5 (L2 child of 4)
//     6 (L2 child of 4)
//   7 (L1 root)
//   8 (L1 root, leaf)
//
// Dependencies:
//   5 → 6 FS  (leaf → leaf: createable)
//   1 → 4 FS  (summary → summary: DROPPED — both are parents)
//   3 → 7 SS  (leaf → leaf: createable, but 7 is also a root with no children)

const FIXTURE: Fixture = {
  buckets: ["General", "Sprint 1"],
  taskCount: 8,
  tasks: [
    // L1 roots
    { taskNumber: 1, outline: "1", name: "Project A", parentTaskNumber: null, bucket: "General", dependsOn: [] },
    { taskNumber: 4, outline: "2", name: "Project B", parentTaskNumber: null, bucket: "General", dependsOn: [] },
    { taskNumber: 7, outline: "3", name: "Standalone", parentTaskNumber: null, bucket: "Sprint 1", dependsOn: [{ onTaskNumber: 3, type: "SS" }] },
    { taskNumber: 8, outline: "4", name: "Leaf Root", parentTaskNumber: null, bucket: "Sprint 1", dependsOn: [] },
    // L2 children
    {
      taskNumber: 2, outline: "1.1", name: "Sub A1", parentTaskNumber: 1,
      bucket: "General",
      start: "2026-07-01", finish: "2026-07-05", progressPercent: 50,
      dependsOn: [],
    },
    { taskNumber: 3, outline: "1.2", name: "Sub A2", parentTaskNumber: 1, bucket: "General", progressPercent: 0, dependsOn: [] },
    {
      taskNumber: 5, outline: "2.1", name: "Sub B1", parentTaskNumber: 4,
      bucket: "Sprint 1",
      dependsOn: [{ onTaskNumber: 1, type: "FS" }], // summary-linked: 1 is a parent → DROPPED
    },
    {
      taskNumber: 6, outline: "2.2", name: "Sub B2", parentTaskNumber: 4,
      bucket: "Sprint 1",
      dependsOn: [{ onTaskNumber: 5, type: "FS" }], // leaf → leaf: createable
    },
  ],
};

// Summary tasks (have children): 1, 4
// Leaves: 2, 3, 5, 6, 7, 8

// ── Helpers ───────────────────────────────────────────────────────────────────

function allTaskNumbers(batches: TaskBatch[]): number[] {
  return batches.flatMap((b) => b.items.map((i) => i.taskNumber));
}

function batchForLevel(batches: TaskBatch[], level: number): TaskBatch[] {
  return batches.filter((b) => b.level === level);
}

// ── Tests: planTaskBatches ────────────────────────────────────────────────────

describe("planTaskBatches", () => {
  it("groups tasks by level — level 1 batches come before level 2 batches", () => {
    const batches = planTaskBatches(FIXTURE);
    const levels = batches.map((b) => b.level);
    // All L1 batches appear before any L2 batch
    const lastL1 = levels.lastIndexOf(1);
    const firstL2 = levels.indexOf(2);
    expect(lastL1).toBeGreaterThanOrEqual(0);
    expect(firstL2).toBeGreaterThan(lastL1);
  });

  it("level 1 tasks have no parentGuid (roots)", () => {
    const batches = planTaskBatches(FIXTURE);
    const l1Batches = batchForLevel(batches, 1);
    for (const batch of l1Batches) {
      for (const item of batch.items) {
        expect(item.parentGuid).toBeNull();
      }
    }
  });

  it("level 2 tasks carry parentGuid from the provided GUID map", () => {
    const guidMap = new Map<number, string>([
      [1, "guid-1"],
      [4, "guid-4"],
    ]);
    const batches = planTaskBatches(FIXTURE, guidMap);
    const l2Batches = batchForLevel(batches, 2);
    expect(l2Batches.length).toBeGreaterThan(0);

    for (const batch of l2Batches) {
      for (const item of batch.items) {
        // Every L2 item should have a parentGuid from the map
        expect(item.parentGuid).not.toBeNull();
        // Item 2 and 3 → parent 1 → "guid-1"; items 5 and 6 → parent 4 → "guid-4"
        if ([2, 3].includes(item.taskNumber)) {
          expect(item.parentGuid).toBe("guid-1");
        } else if ([5, 6].includes(item.taskNumber)) {
          expect(item.parentGuid).toBe("guid-4");
        }
      }
    }
  });

  it("level 2 tasks have null parentGuid when no GUID map is provided", () => {
    // Without a GUID map, parentGuid can't be resolved yet — returns null.
    const batches = planTaskBatches(FIXTURE);
    const l2Batches = batchForLevel(batches, 2);
    for (const batch of l2Batches) {
      for (const item of batch.items) {
        expect(item.parentGuid).toBeNull();
      }
    }
  });

  it("covers all tasks exactly once", () => {
    const batches = planTaskBatches(FIXTURE);
    const nums = allTaskNumbers(batches);
    expect(nums.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("no batch exceeds DEFAULT_BATCH_SIZE (190)", () => {
    const batches = planTaskBatches(FIXTURE);
    for (const batch of batches) {
      expect(batch.items.length).toBeLessThanOrEqual(DEFAULT_BATCH_SIZE);
    }
  });

  it("respects a custom batch size by splitting a level that exceeds it", () => {
    // With batchSize=2, the 4 L1 tasks (1,4,7,8) must be split into 2 batches.
    const batches = planTaskBatches(FIXTURE, new Map(), 2);
    const l1Batches = batchForLevel(batches, 1);
    expect(l1Batches.length).toBe(2); // 4 tasks / 2 per batch
    for (const b of l1Batches) {
      expect(b.items.length).toBeLessThanOrEqual(2);
    }
  });

  it("assigns monotonically increasing batchIndex within a level", () => {
    const batches = planTaskBatches(FIXTURE, new Map(), 2);
    const l1 = batchForLevel(batches, 1);
    expect(l1.map((b) => b.batchIndex)).toEqual([0, 1]);
    const l2 = batchForLevel(batches, 2);
    expect(l2.map((b) => b.batchIndex)).toEqual([0, 1]);
  });

  it("truncates task names that exceed 250 characters", () => {
    const longName = "x".repeat(300);
    const fixture: Fixture = {
      buckets: [],
      taskCount: 1,
      tasks: [{ taskNumber: 1, outline: "1", name: longName, parentTaskNumber: null, dependsOn: [] }],
    };
    const batches = planTaskBatches(fixture);
    expect(batches[0].items[0].name.length).toBe(250);
  });
});

// ── Tests: planDependencyBatches ──────────────────────────────────────────────

describe("planDependencyBatches", () => {
  it("excludes dependencies that touch a summary task (PSS rejects them)", () => {
    const { deps, skippedSummaryDeps } = planDependencyBatches(FIXTURE);

    // Dep 1→4 (summary→summary): skipped
    // Dep 5→6 (leaf→leaf): kept
    // Dep 3→7 (leaf→leaf): kept (both are leaves; 7 has no children)
    const pairs = deps.map((d) => `${d.pred}→${d.succ}`);
    expect(pairs).not.toContain("1→4");
    expect(pairs).toContain("5→6");
    expect(pairs).toContain("3→7");
    expect(skippedSummaryDeps).toBe(1); // only the 1→4 dep is summary-linked
  });

  it("returns leaf-to-leaf deps with correct type", () => {
    const { deps } = planDependencyBatches(FIXTURE);
    const dep56 = deps.find((d) => d.pred === 5 && d.succ === 6);
    expect(dep56).toBeDefined();
    expect(dep56!.type).toBe("FS");

    const dep37 = deps.find((d) => d.pred === 3 && d.succ === 7);
    expect(dep37).toBeDefined();
    expect(dep37!.type).toBe("SS");
  });

  it("returns empty deps for a flat fixture with no dependencies", () => {
    const flat: Fixture = {
      buckets: [],
      taskCount: 2,
      tasks: [
        { taskNumber: 1, outline: "1", name: "A", parentTaskNumber: null, dependsOn: [] },
        { taskNumber: 2, outline: "2", name: "B", parentTaskNumber: null, dependsOn: [] },
      ],
    };
    const { deps, skippedSummaryDeps } = planDependencyBatches(flat);
    expect(deps).toHaveLength(0);
    expect(skippedSummaryDeps).toBe(0);
  });
});

// ── Tests: planProgressItems ──────────────────────────────────────────────────

describe("planProgressItems", () => {
  it("only includes leaf tasks with non-zero progressPercent", () => {
    const items = planProgressItems(FIXTURE);
    const nums = items.map((i) => i.taskNumber);
    // task 2 is a leaf with progressPercent=50 → included
    expect(nums).toContain(2);
    // task 3 is a leaf with progressPercent=0 → excluded
    expect(nums).not.toContain(3);
    // task 1, 4 are summary tasks → excluded (regardless of progress)
    expect(nums).not.toContain(1);
    expect(nums).not.toContain(4);
  });

  it("returns progress value matching the fixture", () => {
    const items = planProgressItems(FIXTURE);
    const task2 = items.find((i) => i.taskNumber === 2);
    expect(task2?.progressPercent).toBe(50);
  });
});

// ── Tests: buildPlanBlueprint ─────────────────────────────────────────────────

describe("buildPlanBlueprint", () => {
  it("returns taskBatches, deps, and progressItems", () => {
    const bp = buildPlanBlueprint(FIXTURE);
    expect(bp.taskBatches.length).toBeGreaterThan(0);
    expect(bp.deps.length).toBeGreaterThan(0);
    expect(bp.progressItems.length).toBeGreaterThan(0);
  });

  it("taskBatches cover all tasks once", () => {
    const bp = buildPlanBlueprint(FIXTURE);
    const nums = bp.taskBatches.flatMap((b) => b.items.map((i) => i.taskNumber));
    expect(nums.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

// ── Tests: planResumeBuild ────────────────────────────────────────────────────

describe("planResumeBuild", () => {
  /** Build a minimal cache for the FIXTURE, partially complete. */
  function makeCache(overrides?: Partial<SeedCache>): SeedCache {
    return {
      version: CACHE_VERSION,
      seedPlanName: "ZZ-MCP-SEED-itboard",
      projectId: "proj-guid",
      orgUrl: "https://contoso.crm4.dynamics.com",
      fixtureHash: hashFixture(FIXTURE),
      fixtureTaskCount: FIXTURE.taskCount,
      linkTypeStyle: "eu",
      builtAtUtc: "2026-06-21T10:00:00Z",
      buckets: {},
      taskGuidByNumber: {},
      dependencyIds: [],
      summaryTaskNumbers: [1, 4],
      checkpoint: blankCheckpoint(),
      scratch: { bucketId: null, subtreeRootTaskId: null, createdTaskIds: [] },
      ...overrides,
    };
  }

  it("returns all batches when no tasks are in the cache (cold resume)", () => {
    const cache = makeCache();
    const resume = planResumeBuild(FIXTURE, cache);
    const nums = resume.remainingTaskBatches.flatMap((b) => b.items.map((i) => i.taskNumber));
    expect(nums.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(resume.skippedTaskNumbers.size).toBe(0);
  });

  it("skips batches that are fully covered by the cache", () => {
    // L1 tasks already in cache: 1, 4, 7, 8
    const cache = makeCache({
      taskGuidByNumber: {
        "1": "g1",
        "4": "g4",
        "7": "g7",
        "8": "g8",
      },
      checkpoint: {
        phase: "tasksL1",
        lastLevelDone: 1,
        tasksPersisted: 4,
        depsPhaseDone: false,
        progressPhaseDone: false,
        failedDeps: [],
      },
    });
    const resume = planResumeBuild(FIXTURE, cache);

    // The L1 batch should be absent (all L1 tasks are in the cache).
    const remainingNums = resume.remainingTaskBatches
      .flatMap((b) => b.items.map((i) => i.taskNumber));
    expect(remainingNums).not.toContain(1);
    expect(remainingNums).not.toContain(4);
    expect(remainingNums).not.toContain(7);
    expect(remainingNums).not.toContain(8);

    // L2 tasks should still need creating.
    expect(remainingNums).toContain(2);
    expect(remainingNums).toContain(3);
    expect(remainingNums).toContain(5);
    expect(remainingNums).toContain(6);

    // The GUID map is passed so L2 items can get their parentGuid.
    const l2Items = resume.remainingTaskBatches
      .flatMap((b) => b.items)
      .filter((i) => [2, 3].includes(i.taskNumber));
    for (const item of l2Items) {
      expect(item.parentGuid).toBe("g1");
    }

    expect(resume.skippedTaskNumbers.has(1)).toBe(true);
    expect(resume.skippedTaskNumbers.has(2)).toBe(false);
  });

  it("returns empty remainingTaskBatches when all tasks are in the cache", () => {
    const cache = makeCache({
      taskGuidByNumber: {
        "1": "g1", "2": "g2", "3": "g3",
        "4": "g4", "5": "g5", "6": "g6",
        "7": "g7", "8": "g8",
      },
      checkpoint: {
        phase: "deps",
        lastLevelDone: 2,
        tasksPersisted: 8,
        depsPhaseDone: false,
        progressPhaseDone: false,
        failedDeps: [],
      },
    });
    const resume = planResumeBuild(FIXTURE, cache);
    expect(resume.remainingTaskBatches).toHaveLength(0);
  });

  it("excludes permanently-failed dep pairs from remainingDeps", () => {
    const cache = makeCache({
      checkpoint: {
        phase: "deps",
        lastLevelDone: 2,
        tasksPersisted: 8,
        depsPhaseDone: false,
        progressPhaseDone: false,
        failedDeps: [{ pred: 5, succ: 6, error: "E_BATCHFAILED" }],
      },
    });
    const resume = planResumeBuild(FIXTURE, cache);
    const pairs = resume.remainingDeps.map((d) => `${d.pred}:${d.succ}`);
    expect(pairs).not.toContain("5:6");
    // The 3→7 dep should still be present (not failed).
    expect(pairs).toContain("3:7");
  });

  it("reports needProgress=true when progressPhaseDone is false", () => {
    const cache = makeCache({
      checkpoint: {
        phase: "progress",
        lastLevelDone: 2,
        tasksPersisted: 8,
        depsPhaseDone: true,
        progressPhaseDone: false,
        failedDeps: [],
      },
    });
    const resume = planResumeBuild(FIXTURE, cache);
    expect(resume.needProgress).toBe(true);
  });

  it("reports needProgress=false when progressPhaseDone is true", () => {
    const cache = makeCache({
      checkpoint: {
        phase: "complete",
        lastLevelDone: 2,
        tasksPersisted: 8,
        depsPhaseDone: true,
        progressPhaseDone: true,
        failedDeps: [],
      },
    });
    const resume = planResumeBuild(FIXTURE, cache);
    expect(resume.needProgress).toBe(false);
  });

  it("returns empty work when cache is complete and full", () => {
    const cache = makeCache({
      taskGuidByNumber: {
        "1": "g1", "2": "g2", "3": "g3",
        "4": "g4", "5": "g5", "6": "g6",
        "7": "g7", "8": "g8",
      },
      checkpoint: {
        phase: "complete",
        lastLevelDone: 2,
        tasksPersisted: 8,
        depsPhaseDone: true,
        progressPhaseDone: true,
        failedDeps: [],
      },
    });
    const resume = planResumeBuild(FIXTURE, cache);
    expect(resume.remainingTaskBatches).toHaveLength(0);
    expect(resume.needProgress).toBe(false);
    // Deps: all failed pairs empty, so remaining = all createable deps
    // (the builder is responsible for deduplication against dependencyIds)
  });
});
