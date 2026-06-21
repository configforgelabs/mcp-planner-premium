import { describe, it, expect } from "vitest";
import {
  validateSeedCache,
  computeSummaryTaskNumbers,
  blankCheckpoint,
  CACHE_VERSION,
  type SeedCache,
  type LiveProbe,
} from "./e2e/seed/cache.js";
import { hashFixture, type Fixture } from "./e2e/seed/hashFixture.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ORG_URL = "https://contoso.crm4.dynamics.com";
const PROJECT_ID = "11111111-2222-3333-4444-555555555555";

/** Minimal two-task fixture with one root and one child. */
const FIXTURE: Fixture = {
  buckets: ["General"],
  taskCount: 2,
  tasks: [
    {
      taskNumber: 1,
      outline: "1",
      name: "Root task",
      parentTaskNumber: null,
      dependsOn: [],
    },
    {
      taskNumber: 2,
      outline: "1.1",
      name: "Child task",
      parentTaskNumber: 1,
      dependsOn: [],
    },
  ],
};

const FIXTURE_HASH = hashFixture(FIXTURE);

/** Factory for a complete, valid cache. */
function makeCompleteCache(overrides?: Partial<SeedCache>): SeedCache {
  return {
    version: CACHE_VERSION,
    seedPlanName: "ZZ-MCP-SEED-itboard",
    projectId: PROJECT_ID,
    orgUrl: ORG_URL,
    fixtureHash: FIXTURE_HASH,
    fixtureTaskCount: FIXTURE.taskCount,
    linkTypeStyle: "eu",
    builtAtUtc: "2026-06-21T12:00:00Z",
    buckets: { General: "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    taskGuidByNumber: {
      "1": "guid-task-1",
      "2": "guid-task-2",
    },
    dependencyIds: [],
    summaryTaskNumbers: [1],
    checkpoint: {
      phase: "complete",
      lastLevelDone: 2,
      tasksPersisted: 2,
      depsPhaseDone: true,
      progressPhaseDone: true,
      failedDeps: [],
    },
    scratch: {
      bucketId: null,
      subtreeRootTaskId: null,
      createdTaskIds: [],
    },
    ...overrides,
  };
}

/** A probe indicating the plan is alive and fully populated. */
const GOOD_PROBE: LiveProbe = { planExists: true, liveTaskCount: 2 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("validateSeedCache", () => {
  describe("rebuild decisions", () => {
    it("returns rebuild when cache is null (no cache file)", () => {
      const r = validateSeedCache(null, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/no cache/i);
    });

    it("returns rebuild when REBUILD_SEED=1 (forceRebuild flag)", () => {
      const cache = makeCompleteCache();
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE, ORG_URL, true);
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/REBUILD_SEED/);
    });

    it("forceRebuild takes priority over all other conditions", () => {
      // Even a null cache with forceRebuild should just say "rebuild" with the
      // forceRebuild reason, not "no cache".
      const r = validateSeedCache(null, FIXTURE, GOOD_PROBE, ORG_URL, true);
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/REBUILD_SEED/);
    });

    it("returns rebuild on version mismatch", () => {
      const cache = makeCompleteCache({ version: 99 });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/version/);
    });

    it("returns rebuild on orgUrl mismatch", () => {
      const cache = makeCompleteCache({ orgUrl: "https://other.crm.dynamics.com" });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE, ORG_URL);
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/orgUrl/i);
    });

    it("does not check orgUrl when currentOrgUrl is not provided", () => {
      // When currentOrgUrl is omitted, orgUrl check is skipped — cache stays valid.
      const cache = makeCompleteCache({ orgUrl: "https://other.crm.dynamics.com" });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      // Should proceed past orgUrl check; fixture hash matches → reuse.
      expect(r.decision).toBe("reuse");
    });

    it("returns rebuild on fixture hash mismatch (fixture changed)", () => {
      const cache = makeCompleteCache({ fixtureHash: "sha256:deadbeef" });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/fixture hash/i);
    });

    it("returns rebuild when projectId is null", () => {
      const cache = makeCompleteCache({ projectId: null });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/projectId/i);
    });

    it("returns rebuild when plan no longer exists (planExists false)", () => {
      const cache = makeCompleteCache();
      const r = validateSeedCache(cache, FIXTURE, { planExists: false, liveTaskCount: null });
      expect(r.decision).toBe("rebuild");
      expect(r.reason).toMatch(/no longer exists/i);
    });
  });

  describe("resume decisions", () => {
    it("returns resume when checkpoint.phase is not 'complete'", () => {
      const cache = makeCompleteCache({
        checkpoint: {
          phase: "tasksL2",
          lastLevelDone: 1,
          tasksPersisted: 1,
          depsPhaseDone: false,
          progressPhaseDone: false,
          failedDeps: [],
        },
      });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("resume");
      expect(r.reason).toMatch(/tasksL2/);
    });

    it("returns resume when checkpoint.phase is 'init'", () => {
      const cache = makeCompleteCache({
        checkpoint: {
          ...blankCheckpoint(),
          phase: "init",
        },
      });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("resume");
    });

    it("returns resume when live task count is less than expected (seed drifted)", () => {
      const cache = makeCompleteCache();
      const r = validateSeedCache(cache, FIXTURE, { planExists: true, liveTaskCount: 1 });
      expect(r.decision).toBe("resume");
      expect(r.reason).toMatch(/1 < expected 2/);
    });

    it("returns resume when liveTaskCount is null (probe indeterminate)", () => {
      const cache = makeCompleteCache();
      const r = validateSeedCache(cache, FIXTURE, { planExists: true, liveTaskCount: null });
      expect(r.decision).toBe("resume");
      expect(r.reason).toMatch(/could not be determined/i);
    });

    it("returns resume when deps phase done but progress not done", () => {
      const cache = makeCompleteCache({
        checkpoint: {
          phase: "progress",
          lastLevelDone: 2,
          tasksPersisted: 2,
          depsPhaseDone: true,
          progressPhaseDone: false,
          failedDeps: [],
        },
      });
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("resume");
    });
  });

  describe("reuse decisions", () => {
    it("returns reuse for a fully complete, hash-matching cache", () => {
      const cache = makeCompleteCache();
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE, ORG_URL);
      expect(r.decision).toBe("reuse");
      expect(r.reason).toMatch(PROJECT_ID);
      expect(r.reason).toMatch(/2 tasks/);
    });

    it("returns reuse when orgUrl is not checked (undefined)", () => {
      const cache = makeCompleteCache();
      const r = validateSeedCache(cache, FIXTURE, GOOD_PROBE);
      expect(r.decision).toBe("reuse");
    });

    it("returns reuse when liveTaskCount exactly equals fixtureTaskCount", () => {
      const cache = makeCompleteCache();
      // exactly 2 tasks = the fixture taskCount
      const r = validateSeedCache(cache, FIXTURE, { planExists: true, liveTaskCount: 2 });
      expect(r.decision).toBe("reuse");
    });
  });
});

describe("computeSummaryTaskNumbers", () => {
  it("returns taskNumbers that have at least one child", () => {
    const summaries = computeSummaryTaskNumbers(FIXTURE);
    expect(summaries).toEqual([1]); // task 1 is parent of task 2
  });

  it("returns an empty array when no task has a parent", () => {
    const flat: Fixture = {
      ...FIXTURE,
      tasks: FIXTURE.tasks.map((t) => ({ ...t, parentTaskNumber: null })),
    };
    expect(computeSummaryTaskNumbers(flat)).toEqual([]);
  });

  it("returns sorted taskNumbers", () => {
    const fixture: Fixture = {
      buckets: [],
      taskCount: 4,
      tasks: [
        { taskNumber: 4, outline: "3.1", name: "D", parentTaskNumber: 3, dependsOn: [] },
        { taskNumber: 1, outline: "1", name: "A", parentTaskNumber: null, dependsOn: [] },
        { taskNumber: 2, outline: "2", name: "B", parentTaskNumber: null, dependsOn: [] },
        { taskNumber: 3, outline: "3", name: "C", parentTaskNumber: 2, dependsOn: [] },
      ],
    };
    // task 2 and task 3 are both parents
    expect(computeSummaryTaskNumbers(fixture)).toEqual([2, 3]);
  });
});

describe("blankCheckpoint", () => {
  it("starts at phase 'init' with zero counts", () => {
    const cp = blankCheckpoint();
    expect(cp.phase).toBe("init");
    expect(cp.lastLevelDone).toBe(0);
    expect(cp.tasksPersisted).toBe(0);
    expect(cp.depsPhaseDone).toBe(false);
    expect(cp.progressPhaseDone).toBe(false);
    expect(cp.failedDeps).toEqual([]);
  });
});
