/**
 * hashFixture.ts — pure, offline
 *
 * Produces a deterministic SHA-256 content hash of the subset of the fixture
 * that the seed builder actually materialises. Cosmetic fields (notes, labels,
 * category, checklist, sprint, assignedTo, etc.) are excluded so they don't
 * trigger a rebuild. Only the fields that control what gets created/wired in
 * Dataverse are hashed.
 *
 * The hash is stable over JSON key ordering because we canonicalise before
 * stringifying.
 */

import { createHash } from "node:crypto";

// ── Fixture types (mirrors it-planner-board.json shape) ──────────────────────

export interface FixtureDependency {
  onTaskNumber: number;
  type: string; // "FS" | "SS" | "FF" | "SF"
}

export interface FixtureTask {
  taskNumber: number;
  outline: string | null;
  name: string;
  priority?: number | null;
  progressPercent?: number | null;
  start?: string | null;
  finish?: string | null;
  effortHours?: number | null;
  bucket?: string | null;
  milestone?: boolean | null;
  parentTaskNumber?: number | null;
  dependsOn?: FixtureDependency[];
  // Extra fields present in the JSON but not materialised — ignored for hashing
  [key: string]: unknown;
}

export interface Fixture {
  source?: string;
  meta?: Record<string, unknown>;
  buckets: string[];
  taskCount: number;
  tasks: FixtureTask[];
}

// ── Canonical projection ──────────────────────────────────────────────────────

/**
 * Returns a canonical representation of the fields the seed build materialises.
 * Sorted by taskNumber so insertion order doesn't affect the hash.
 */
function canonicalise(fixture: Fixture): object {
  const tasks = [...fixture.tasks]
    .sort((a, b) => a.taskNumber - b.taskNumber)
    .map((t) => ({
      taskNumber: t.taskNumber,
      outline: t.outline ?? null,
      name: t.name,
      bucket: t.bucket ?? null,
      start: t.start ?? null,
      finish: t.finish ?? null,
      effortHours: t.effortHours ?? null,
      priority: t.priority ?? null,
      // Progress is set post-create for leaves; include so a change triggers rebuild.
      progressPercent: t.progressPercent ?? null,
      parentTaskNumber: t.parentTaskNumber ?? null,
      dependsOn: (t.dependsOn ?? [])
        .slice()
        .sort((a, b) => a.onTaskNumber - b.onTaskNumber || a.type.localeCompare(b.type))
        .map((d) => ({ onTaskNumber: d.onTaskNumber, type: d.type })),
    }));

  // Buckets are created in fixture order; a reorder forces a rebuild.
  const buckets = [...fixture.buckets];

  return { buckets, tasks };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a `sha256:<hex>` string that is stable over key ordering but changes
 * whenever a materialised field of any task changes.
 */
export function hashFixture(fixture: Fixture): string {
  const canonical = canonicalise(fixture);
  const json = JSON.stringify(canonical);
  const hex = createHash("sha256").update(json, "utf8").digest("hex");
  return `sha256:${hex}`;
}
