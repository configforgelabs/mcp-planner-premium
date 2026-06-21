import { describe, it, expect } from "vitest";
import { hashFixture, type Fixture, type FixtureTask } from "./e2e/seed/hashFixture.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFixture(tasks: Partial<FixtureTask>[]): Fixture {
  const full: FixtureTask[] = tasks.map((t, i) => ({
    taskNumber: t.taskNumber ?? i + 1,
    outline: t.outline ?? String(i + 1),
    name: t.name ?? `Task ${i + 1}`,
    priority: t.priority ?? null,
    progressPercent: t.progressPercent ?? null,
    start: t.start ?? null,
    finish: t.finish ?? null,
    effortHours: t.effortHours ?? null,
    bucket: t.bucket ?? null,
    milestone: t.milestone ?? null,
    parentTaskNumber: t.parentTaskNumber ?? null,
    dependsOn: t.dependsOn ?? [],
  }));
  return {
    buckets: ["Default"],
    taskCount: full.length,
    tasks: full,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("hashFixture", () => {
  it("produces a sha256: prefixed hex string", () => {
    const h = hashFixture(makeFixture([{ name: "Root" }]));
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("same content in different key ordering produces the same hash", () => {
    // Simulate tasks arriving in reverse taskNumber order vs forward order.
    const forward = makeFixture([
      { taskNumber: 1, name: "Alpha", bucket: "A" },
      { taskNumber: 2, name: "Beta", bucket: "B" },
    ]);
    // Reverse the tasks array — the canonicaliser sorts by taskNumber so hash
    // must be identical.
    const reversed: Fixture = {
      ...forward,
      tasks: [...forward.tasks].reverse(),
    };
    expect(hashFixture(forward)).toBe(hashFixture(reversed));
  });

  it("same content with re-ordered dependsOn entries produces the same hash", () => {
    const fixtureA = makeFixture([
      { taskNumber: 1, name: "Parent" },
      {
        taskNumber: 2,
        name: "Child",
        dependsOn: [
          { onTaskNumber: 1, type: "FS" },
          { onTaskNumber: 3, type: "SS" },
        ],
      },
      { taskNumber: 3, name: "Sibling" },
    ]);
    const fixtureB: Fixture = {
      ...fixtureA,
      tasks: fixtureA.tasks.map((t) =>
        t.taskNumber === 2
          ? {
              ...t,
              dependsOn: [
                { onTaskNumber: 3, type: "SS" }, // swapped order
                { onTaskNumber: 1, type: "FS" },
              ],
            }
          : t,
      ),
    };
    expect(hashFixture(fixtureA)).toBe(hashFixture(fixtureB));
  });

  it("changing a task name produces a different hash", () => {
    const original = makeFixture([{ taskNumber: 1, name: "Alpha" }]);
    const changed: Fixture = {
      ...original,
      tasks: [{ ...original.tasks[0], name: "Beta" }],
    };
    expect(hashFixture(original)).not.toBe(hashFixture(changed));
  });

  it("changing a task parent produces a different hash", () => {
    const original = makeFixture([
      { taskNumber: 1, name: "Root", parentTaskNumber: null },
      { taskNumber: 2, name: "Child", outline: "1.1", parentTaskNumber: 1 },
    ]);
    const changed: Fixture = {
      ...original,
      tasks: original.tasks.map((t) =>
        t.taskNumber === 2 ? { ...t, parentTaskNumber: null } : t,
      ),
    };
    expect(hashFixture(original)).not.toBe(hashFixture(changed));
  });

  it("changing a task bucket produces a different hash", () => {
    const original = makeFixture([{ taskNumber: 1, bucket: "Sprint 1" }]);
    const changed: Fixture = {
      ...original,
      tasks: [{ ...original.tasks[0], bucket: "Sprint 2" }],
    };
    expect(hashFixture(original)).not.toBe(hashFixture(changed));
  });

  it("adding a dependency produces a different hash", () => {
    const original = makeFixture([
      { taskNumber: 1, name: "A" },
      { taskNumber: 2, name: "B", dependsOn: [] },
    ]);
    const withDep: Fixture = {
      ...original,
      tasks: original.tasks.map((t) =>
        t.taskNumber === 2
          ? { ...t, dependsOn: [{ onTaskNumber: 1, type: "FS" }] }
          : t,
      ),
    };
    expect(hashFixture(original)).not.toBe(hashFixture(withDep));
  });

  it("changing the bucket list produces a different hash", () => {
    const original = makeFixture([{ name: "Task" }]);
    const changed: Fixture = { ...original, buckets: ["Default", "Extra"] };
    expect(hashFixture(original)).not.toBe(hashFixture(changed));
  });

  it("cosmetic-only fields (notes, milestone label, category) do NOT affect the hash", () => {
    const original = makeFixture([
      { taskNumber: 1, name: "Task", milestone: false },
    ]);
    // Add extra fields that hashFixture excludes from its projection.
    const withExtras: Fixture = {
      ...original,
      tasks: [
        {
          ...original.tasks[0],
          notes: "Some notes",
          category: "[P] Project",
          checklist: [{ title: "Check it" }],
          labels: ["Important"],
          assignedTo: "Alice",
        } as FixtureTask,
      ],
    };
    expect(hashFixture(original)).toBe(hashFixture(withExtras));
  });

  it("is deterministic across multiple calls", () => {
    const fixture = makeFixture([
      { taskNumber: 1, name: "X", bucket: "B1" },
      { taskNumber: 2, name: "Y", outline: "2", parentTaskNumber: 1 },
    ]);
    const h1 = hashFixture(fixture);
    const h2 = hashFixture(fixture);
    const h3 = hashFixture(fixture);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });
});
