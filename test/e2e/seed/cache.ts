/**
 * cache.ts — pure types + decision function (no fs, no network)
 *
 * The cache file is `.e2e-seed-cache.json` at the project root (gitignored).
 * This module owns:
 *  - The TypeScript types for the cache JSON shape.
 *  - `validateSeedCache` — a PURE function that decides reuse / resume / rebuild
 *    given the cache, the fixture, and an externally-supplied live probe result.
 *    (The live probe is fetched by the caller, not here, so this stays testable.)
 *
 * File I/O helpers (readCache / writeCache) are intentionally NOT here — they
 * belong in builder.ts (the live-integration step) so this module stays offline.
 */

import type { Fixture } from "./hashFixture.js";
import { hashFixture } from "./hashFixture.js";

// ── Cache JSON shape ──────────────────────────────────────────────────────────

/** Bump this when the schema changes to invalidate old caches. */
export const CACHE_VERSION = 1;

export type CheckpointPhase =
  | "init"
  | "plan"
  | "buckets"
  | `tasksL${number}`
  | "deps"
  | "progress"
  | "complete";

export interface FailedDep {
  pred: number;
  succ: number;
  error: string;
}

export interface CacheCheckpoint {
  phase: CheckpointPhase;
  /** Highest hierarchy level (1-based) whose tasks are fully persisted. */
  lastLevelDone: number;
  /** How many tasks have been confirmed persisted. */
  tasksPersisted: number;
  depsPhaseDone: boolean;
  progressPhaseDone: boolean;
  /** Dependencies PSS refused structurally; recorded, not retried. */
  failedDeps: FailedDep[];
}

export interface CacheScratch {
  bucketId: string | null;
  subtreeRootTaskId: string | null;
  /** GUIDs of tasks created by write scenarios; swept on run end. */
  createdTaskIds: string[];
}

export interface SeedCache {
  version: number;
  seedPlanName: string;
  /** Dataverse project GUID; null until create_plan succeeds. */
  projectId: string | null;
  /** Base URL of the org — guards against cross-org reuse. */
  orgUrl: string;
  /** sha256 of the canonicalised fixture projection (see hashFixture.ts). */
  fixtureHash: string;
  /** Expected total task count; fast invalidation before live probe. */
  fixtureTaskCount: number;
  /**
   * EU/CRM4 vs global option values for dependency link types.
   * Must match the tenant this cache was built against.
   */
  linkTypeStyle: "eu" | "global";
  builtAtUtc: string;
  /** Bucket name → Dataverse GUID. */
  buckets: Record<string, string>;
  /** Fixture taskNumber (as string key) → Dataverse task GUID. */
  taskGuidByNumber: Record<string, string>;
  /** Dataverse IDs of created msdyn_projecttaskdependency records. */
  dependencyIds: string[];
  /** taskNumbers of summary tasks (have children) — for safe-write targeting. */
  summaryTaskNumbers: number[];
  checkpoint: CacheCheckpoint;
  scratch: CacheScratch;
}

// ── Validation decision ───────────────────────────────────────────────────────

export type CacheDecision = "reuse" | "resume" | "rebuild";

export interface CacheValidationResult {
  decision: CacheDecision;
  reason: string;
}

/**
 * Live probe result passed in from the caller (pure input, not fetched here).
 *
 * `planExists` — whether a GET on the plan's projectId returned 200.
 * `liveTaskCount` — task count returned by verifyTaskCount, or null if the
 *   probe could not be performed (e.g. plan doesn't exist).
 */
export interface LiveProbe {
  planExists: boolean;
  liveTaskCount: number | null;
}

/**
 * PURE decision function.
 *
 * Decision table:
 *
 * | Condition                                      | Decision |
 * |------------------------------------------------|----------|
 * | No cache                                       | rebuild  |
 * | version mismatch                               | rebuild  |
 * | orgUrl mismatch (currentOrgUrl given)          | rebuild  |
 * | fixtureHash mismatch                           | rebuild  |
 * | forceRebuild flag set                          | rebuild  |
 * | projectId null (create_plan never succeeded)   | rebuild  |
 * | planExists false                               | rebuild  |
 * | checkpoint.phase !== "complete"                | resume   |
 * | liveTaskCount < fixtureTaskCount               | resume   |
 * | liveTaskCount null (couldn't probe)            | resume   |
 * | All above pass                                 | reuse    |
 *
 * @param cache          Parsed `.e2e-seed-cache.json`, or null if absent.
 * @param fixture        The parsed fixture (used to compute the expected hash).
 * @param probe          Result of the live probe (planExists + liveTaskCount).
 * @param currentOrgUrl  When given, the cache orgUrl must match.
 * @param forceRebuild   When true, always returns rebuild (REBUILD_SEED=1).
 */
export function validateSeedCache(
  cache: SeedCache | null,
  fixture: Fixture,
  probe: LiveProbe,
  currentOrgUrl?: string,
  forceRebuild?: boolean,
): CacheValidationResult {
  if (forceRebuild) {
    return { decision: "rebuild", reason: "REBUILD_SEED=1 flag is set" };
  }

  if (!cache) {
    return { decision: "rebuild", reason: "no cache file found" };
  }

  if (cache.version !== CACHE_VERSION) {
    return {
      decision: "rebuild",
      reason: `cache version ${cache.version} does not match expected ${CACHE_VERSION}`,
    };
  }

  if (currentOrgUrl !== undefined && cache.orgUrl !== currentOrgUrl) {
    return {
      decision: "rebuild",
      reason: `cache orgUrl "${cache.orgUrl}" does not match current "${currentOrgUrl}"`,
    };
  }

  const expectedHash = hashFixture(fixture);
  if (cache.fixtureHash !== expectedHash) {
    return {
      decision: "rebuild",
      reason: `fixture hash mismatch — fixture changed since last build`,
    };
  }

  if (!cache.projectId) {
    return {
      decision: "rebuild",
      reason: "cache has no projectId (create_plan never completed)",
    };
  }

  if (!probe.planExists) {
    return {
      decision: "rebuild",
      reason: "seed plan no longer exists in Dataverse",
    };
  }

  if (cache.checkpoint.phase !== "complete") {
    return {
      decision: "resume",
      reason: `checkpoint at phase "${cache.checkpoint.phase}" — build was interrupted`,
    };
  }

  if (probe.liveTaskCount === null) {
    return {
      decision: "resume",
      reason: "live task count could not be determined — re-verifying",
    };
  }

  if (probe.liveTaskCount < fixture.taskCount) {
    return {
      decision: "resume",
      reason: `live task count ${probe.liveTaskCount} < expected ${fixture.taskCount} — seed drifted`,
    };
  }

  return {
    decision: "reuse",
    reason: `cache hit — projectId=${cache.projectId}, ${probe.liveTaskCount} tasks`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the set of taskNumbers that are parents (have at least one child).
 * Pure function used both at build time and to populate cache.summaryTaskNumbers.
 */
export function computeSummaryTaskNumbers(fixture: Fixture): number[] {
  const parentSet = new Set<number>();
  for (const t of fixture.tasks) {
    if (t.parentTaskNumber != null) {
      parentSet.add(t.parentTaskNumber);
    }
  }
  return [...parentSet].sort((a, b) => a - b);
}

/**
 * Returns a blank checkpoint appropriate for starting a fresh build.
 */
export function blankCheckpoint(): CacheCheckpoint {
  return {
    phase: "init",
    lastLevelDone: 0,
    tasksPersisted: 0,
    depsPhaseDone: false,
    progressPhaseDone: false,
    failedDeps: [],
  };
}
