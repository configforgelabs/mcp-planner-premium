import { describe, it, expect } from "vitest";
import { buildTaskEntities, type SimpleTask } from "../src/tools/addTasksSimple.js";
import { validateAddEntities } from "../src/tools/addTasks.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const BUCKET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const resolve = (b: string) => (GUID_RE.test(b) ? b : BUCKET);
const TASK = "Microsoft.Dynamics.CRM.msdyn_projecttask";

function guid(n: number): string {
  const h = n.toString(16).padStart(2, "0");
  return `${h}aaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
}

// Six-level chain L1 (root) -> L2 -> ... -> L6 (leaf).
function chain(): SimpleTask[] {
  const t: SimpleTask[] = [];
  for (let i = 1; i <= 6; i++) {
    t.push({
      ref: `L${i}`,
      subject: `Level ${i}`,
      bucket: BUCKET,
      ...(i > 1 ? { parent: `L${i - 1}` } : {}),
    });
  }
  return t;
}

describe("ergonomic add_tasks - 6-level hierarchy", () => {
  it("builds correct parent binds and parent-before-child order from REVERSED input", () => {
    const built = buildTaskEntities(PROJECT, [...chain()].reverse(), resolve);

    // 6 task entities, no dependencies.
    expect(built.entities).toHaveLength(6);
    expect(built.entities.every((e) => e["@odata.type"] === TASK)).toBe(true);

    const indexOf = (ref: string) =>
      built.entities.findIndex((e) => e.msdyn_projecttaskid === built.refToId[ref]);

    // Root has no parent bind; each Li binds to L(i-1) and appears AFTER it.
    expect(built.entities[indexOf("L1")]["msdyn_parenttask@odata.bind"]).toBeUndefined();
    for (let i = 2; i <= 6; i++) {
      const childEnt = built.entities[indexOf(`L${i}`)];
      expect(childEnt["msdyn_parenttask@odata.bind"]).toBe(
        "/msdyn_projecttasks(" + built.refToId[`L${i - 1}`] + ")",
      );
      expect(indexOf(`L${i - 1}`)).toBeLessThan(indexOf(`L${i}`));
    }

    // The built collection must satisfy the raw guardrails (parents-before-children).
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });

  it("generates a unique client GUID per level", () => {
    const built = buildTaskEntities(PROJECT, chain(), resolve);
    const ids = Object.values(built.refToId);
    expect(new Set(ids).size).toBe(6);
    expect(ids.every((id) => GUID_RE.test(id))).toBe(true);
  });

  it("roots a 6-level subtree under an EXISTING task GUID", () => {
    const existing = "99999999-8888-7777-6666-555555555555";
    const tasks = chain();
    tasks[0] = { ...tasks[0], parent: existing }; // L1.parent = existing task
    const built = buildTaskEntities(PROJECT, tasks, resolve);

    const l1 = built.entities.find((e) => e.msdyn_projecttaskid === built.refToId.L1)!;
    expect(l1["msdyn_parenttask@odata.bind"]).toBe("/msdyn_projecttasks(" + existing + ")");
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });

  it("orders a shuffled wide tree (root, 2 children, 4 grandchildren) parents-first", () => {
    const tasks: SimpleTask[] = [
      { ref: "gc4", subject: "gc4", bucket: BUCKET, parent: "c2" },
      { ref: "c1", subject: "c1", bucket: BUCKET, parent: "root" },
      { ref: "gc1", subject: "gc1", bucket: BUCKET, parent: "c1" },
      { ref: "root", subject: "root", bucket: BUCKET },
      { ref: "gc3", subject: "gc3", bucket: BUCKET, parent: "c2" },
      { ref: "c2", subject: "c2", bucket: BUCKET, parent: "root" },
      { ref: "gc2", subject: "gc2", bucket: BUCKET, parent: "c1" },
    ];
    const built = buildTaskEntities(PROJECT, tasks, resolve);
    const idx = (ref: string) =>
      built.entities.findIndex((e) => e.msdyn_projecttaskid === built.refToId[ref]);
    // Every parent precedes every one of its children.
    for (const [parent, child] of [
      ["root", "c1"],
      ["root", "c2"],
      ["c1", "gc1"],
      ["c1", "gc2"],
      ["c2", "gc3"],
      ["c2", "gc4"],
    ]) {
      expect(idx(parent)).toBeLessThan(idx(child));
    }
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });
});

describe("raw add_tasks_batch - 6-level hierarchy validation", () => {
  function rawChain(order: "root-first" | "leaf-first") {
    const ids = Array.from({ length: 6 }, (_, i) => guid(i + 1));
    const ents = ids.map((id, i) => ({
      "@odata.type": TASK,
      msdyn_projecttaskid: id,
      msdyn_subject: `Level ${i + 1}`,
      "msdyn_project@odata.bind": "/msdyn_projects(" + PROJECT + ")",
      "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(" + BUCKET + ")",
      ...(i > 0
        ? { "msdyn_parenttask@odata.bind": "/msdyn_projecttasks(" + ids[i - 1] + ")" }
        : {}),
    }));
    return order === "root-first" ? ents : ents.reverse();
  }

  it("accepts a correctly ordered (root-first) 6-level chain", () => {
    expect(() => validateAddEntities(rawChain("root-first"))).not.toThrow();
  });

  it("rejects a child-before-parent (leaf-first) 6-level chain", () => {
    expect(() => validateAddEntities(rawChain("leaf-first"))).toThrow(
      /Parents must appear BEFORE their children/,
    );
  });
});
