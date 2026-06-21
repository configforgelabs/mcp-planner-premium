import { describe, it, expect } from "vitest";
import {
  buildDeleteEntities,
  validateDeleteRecords,
  sortTaskIdsLeavesFirst,
  selectDependenciesToDelete,
} from "../src/tools/deleteTasks.js";

const GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("buildDeleteEntities", () => {
  it("produces OData entity objects, not {EntityLogicalName, RecordId} descriptors", () => {
    const result = buildDeleteEntities([
      { entityLogicalName: "msdyn_projecttask", recordId: GUID },
    ]);
    expect(result).toHaveLength(1);
    const e = result[0];
    // Must have @odata.type — Dataverse uses this to determine the entity type.
    expect(e["@odata.type"]).toBe("Microsoft.Dynamics.CRM.msdyn_projecttask");
    // Primary key follows the <logicalname>id pattern.
    expect(e["msdyn_projecttaskid"]).toBe(GUID);
    // The old descriptor fields must NOT be present — they cause
    // "Invalid property 'EntityLogicalName' was found in entity crmbaseentity".
    expect("EntityLogicalName" in e).toBe(false);
    expect("RecordId" in e).toBe(false);
  });

  it("builds the correct primary key field for each deletable entity type", () => {
    const types = [
      "msdyn_projecttask",
      "msdyn_projecttaskdependency",
      "msdyn_resourceassignment",
      "msdyn_projectbucket",
      "msdyn_projectsprint",
      "msdyn_projectchecklist",
      "msdyn_projecttasktolabel",
    ];
    const entities = buildDeleteEntities(types.map((t) => ({ entityLogicalName: t, recordId: GUID })));
    for (let i = 0; i < types.length; i++) {
      expect(entities[i]["@odata.type"]).toBe("Microsoft.Dynamics.CRM." + types[i]);
      expect(entities[i][types[i] + "id"]).toBe(GUID);
    }
  });
});

describe("sortTaskIdsLeavesFirst", () => {
  // Mirrors the 6-level test hierarchy: L1 > L2 > L3 > L4 > L5 > L6, SIB under L1.
  const L1 = "l1000000-0000-0000-0000-000000000001";
  const L2 = "l2000000-0000-0000-0000-000000000002";
  const L3 = "l3000000-0000-0000-0000-000000000003";
  const L4 = "l4000000-0000-0000-0000-000000000004";
  const L5 = "l5000000-0000-0000-0000-000000000005";
  const L6 = "l6000000-0000-0000-0000-000000000006";
  const SIB = "sib00000-0000-0000-0000-000000000007";

  const parentMap = new Map<string, string | null>([
    [L1.toLowerCase(), null],
    [L2.toLowerCase(), L1.toLowerCase()],
    [L3.toLowerCase(), L2.toLowerCase()],
    [L4.toLowerCase(), L3.toLowerCase()],
    [L5.toLowerCase(), L4.toLowerCase()],
    [L6.toLowerCase(), L5.toLowerCase()],
    [SIB.toLowerCase(), L1.toLowerCase()],
  ]);

  it("puts every leaf before its ancestor in the 6-level hierarchy", () => {
    const sorted = sortTaskIdsLeavesFirst([L1, L2, L3, L4, L5, L6, SIB], parentMap);
    // L6 and SIB (leaves) must appear before L5, L4, L3, L2, L1.
    const idx = (id: string) => sorted.findIndex((x) => x.toLowerCase() === id.toLowerCase());
    expect(idx(L6)).toBeLessThan(idx(L5));
    expect(idx(L5)).toBeLessThan(idx(L4));
    expect(idx(L4)).toBeLessThan(idx(L3));
    expect(idx(L3)).toBeLessThan(idx(L2));
    expect(idx(L2)).toBeLessThan(idx(L1));
    expect(idx(SIB)).toBeLessThan(idx(L1));
    // All 7 IDs are present exactly once.
    expect(sorted).toHaveLength(7);
  });

  it("is a no-op for a flat list with no parent relationships in the delete set", () => {
    const flat = [L1, L2, L3];
    const noParents = new Map<string, null>([
      [L1.toLowerCase(), null],
      [L2.toLowerCase(), null],
      [L3.toLowerCase(), null],
    ]);
    const sorted = sortTaskIdsLeavesFirst(flat, noParents);
    expect(sorted).toHaveLength(3);
    // No ordering constraint — all are roots, original order preserved.
    expect(new Set(sorted)).toEqual(new Set(flat));
  });

  it("handles tasks whose parent is outside the delete set (treated as roots)", () => {
    // Deleting only L5 and L6 — L4 (parent of L5) is not in the batch.
    const sorted = sortTaskIdsLeavesFirst([L5, L6], parentMap);
    const idxL6 = sorted.findIndex((x) => x.toLowerCase() === L6.toLowerCase());
    const idxL5 = sorted.findIndex((x) => x.toLowerCase() === L5.toLowerCase());
    expect(idxL6).toBeLessThan(idxL5);
  });

  it("returns single-element arrays unchanged", () => {
    expect(sortTaskIdsLeavesFirst([L1], parentMap)).toEqual([L1]);
  });

  it("handles a 200-level deep chain without stack overflow (iterative DFS)", () => {
    const DEPTH = 200;
    const ids = Array.from({ length: DEPTH }, (_, i) =>
      String(i).padStart(8, "0") + "-0000-0000-0000-000000000000",
    );
    const deepMap = new Map<string, string | null>();
    deepMap.set(ids[0].toLowerCase(), null);
    for (let i = 1; i < DEPTH; i++) {
      deepMap.set(ids[i].toLowerCase(), ids[i - 1].toLowerCase());
    }
    const sorted = sortTaskIdsLeavesFirst([...ids], deepMap);
    expect(sorted).toHaveLength(DEPTH);
    // The deepest node (last in the chain) must appear first.
    expect(sorted[0].toLowerCase()).toBe(ids[DEPTH - 1].toLowerCase());
    // The root must appear last.
    expect(sorted[DEPTH - 1].toLowerCase()).toBe(ids[0].toLowerCase());
  });
});

describe("validateDeleteRecords", () => {
  it("blocks msdyn_project (whole-plan delete)", () => {
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "msdyn_project", recordId: GUID }]),
    ).toThrow(/blocked by policy/);
  });

  it("rejects unknown entity types", () => {
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "account", recordId: GUID }]),
    ).toThrow(/invalid entityLogicalName/);
  });

  it("accepts valid deletable entity types", () => {
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "msdyn_projecttask", recordId: GUID }]),
    ).not.toThrow();
  });
});

// ---- Feature 4: selectDependenciesToDelete ----

// Use a simpler, explicit dependency graph for F4 cascade tests:
// TASK_X --[DEP_XY]--> TASK_Y   (X is predecessor, Y is successor)
// TASK_Y --[DEP_YZ]--> TASK_Z   (Y is predecessor, Z is successor)
// TASK_X --[DEP_XZ]--> TASK_Z   (X is predecessor, Z is successor)
const TASK_X = "taskxxxx-1111-0000-0000-000000000001";
const TASK_Y = "taskyyyy-2222-0000-0000-000000000002";
const TASK_Z = "taskzzzz-3333-0000-0000-000000000003";
const DEP_XY = "dep00000-0000-0000-0000-000000000001"; // X -> Y
const DEP_YZ = "dep00000-0000-0000-0000-000000000002"; // Y -> Z
const DEP_XZ = "dep00000-0000-0000-0000-000000000003"; // X -> Z
// DEP_LONE references two tasks that will never be in the delete set
const TASK_LONE_A = "loneaaaa-0000-0000-0000-000000000010";
const TASK_LONE_B = "lonebbbbb-0000-0000-0000-000000000011";
const DEP_LONE = "dep00000-0000-0000-0000-000000000004"; // LONE_A -> LONE_B

const depRows = [
  {
    msdyn_projecttaskdependencyid: DEP_XY,
    _msdyn_predecessortask_value: TASK_X,
    _msdyn_successortask_value: TASK_Y,
  },
  {
    msdyn_projecttaskdependencyid: DEP_YZ,
    _msdyn_predecessortask_value: TASK_Y,
    _msdyn_successortask_value: TASK_Z,
  },
  {
    msdyn_projecttaskdependencyid: DEP_XZ,
    _msdyn_predecessortask_value: TASK_X,
    _msdyn_successortask_value: TASK_Z,
  },
  {
    msdyn_projecttaskdependencyid: DEP_LONE,
    _msdyn_predecessortask_value: TASK_LONE_A,
    _msdyn_successortask_value: TASK_LONE_B,
  },
];

describe("selectDependenciesToDelete (F4 cascade)", () => {
  it("selects a dependency whose successor is in the delete set", () => {
    // Delete only TASK_Y. DEP_XY has TASK_Y as successor.
    // DEP_YZ has TASK_Y as predecessor, so it is also selected.
    // Only DEP_XY tests the "successor" path specifically; we verify it is included.
    const deleteSet = new Set([TASK_Y.toLowerCase()]);
    const result = selectDependenciesToDelete(deleteSet, depRows);
    const ids = result.map((r) => r.recordId);
    expect(ids).toContain(DEP_XY); // TASK_Y is the successor in DEP_XY
    expect(ids).toContain(DEP_YZ); // TASK_Y is the predecessor in DEP_YZ
    expect(ids).not.toContain(DEP_XZ);  // neither endpoint is TASK_Y
    expect(ids).not.toContain(DEP_LONE);
    for (const r of result) {
      expect(r.entityLogicalName).toBe("msdyn_projecttaskdependency");
    }
  });

  it("selects a dependency whose predecessor is in the delete set (but not its successor)", () => {
    // Delete only TASK_X. DEP_XY and DEP_XZ have TASK_X as predecessor.
    const deleteSet = new Set([TASK_X.toLowerCase()]);
    const result = selectDependenciesToDelete(deleteSet, depRows);
    const ids = result.map((r) => r.recordId);
    expect(ids).toContain(DEP_XY);
    expect(ids).toContain(DEP_XZ);
    expect(ids).not.toContain(DEP_YZ);  // TASK_X is not an endpoint of DEP_YZ
    expect(ids).not.toContain(DEP_LONE);
    expect(result).toHaveLength(2);
  });

  it("ignores a dependency referencing only tasks NOT being deleted", () => {
    // Delete a task that has no deps referencing it.
    const deleteSet = new Set(["ffffffff-0000-0000-0000-000000000099"]); // no such dep
    const result = selectDependenciesToDelete(deleteSet, depRows);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when depRows is empty", () => {
    const deleteSet = new Set([TASK_X.toLowerCase()]);
    expect(selectDependenciesToDelete(deleteSet, [])).toHaveLength(0);
  });

  it("de-dupes a dependency id already present in caller records", () => {
    // Delete TASK_X → DEP_XY and DEP_XZ would be selected.
    // Caller already queued DEP_XY — only DEP_XZ should be returned.
    const deleteSet = new Set([TASK_X.toLowerCase()]);
    const callerIds = new Set([DEP_XY.toLowerCase()]);
    const result = selectDependenciesToDelete(deleteSet, depRows, callerIds);
    const ids = result.map((r) => r.recordId);
    expect(ids).not.toContain(DEP_XY); // de-duped
    expect(ids).toContain(DEP_XZ);
    expect(result).toHaveLength(1);
  });

  it("integration with ordering: dependency entities precede task entities in buildDeleteEntities output", () => {
    // Delete only TASK_Z — only DEP_YZ and DEP_XZ reference TASK_Z (as successor).
    // DEP_LONE is unrelated, DEP_XY is unrelated.
    const deleteSet = new Set([TASK_Z.toLowerCase()]);
    const cascadedDeps = selectDependenciesToDelete(deleteSet, depRows);
    // Combine: cascaded deps first, then the task itself.
    const records = [
      ...cascadedDeps,
      { entityLogicalName: "msdyn_projecttask" as const, recordId: TASK_Z },
    ];
    expect(() => validateDeleteRecords(records)).not.toThrow();
    const entities = buildDeleteEntities(records);
    // First two entities must be dependency entities (DEP_YZ, DEP_XZ), last is the task.
    for (let i = 0; i < cascadedDeps.length; i++) {
      expect(entities[i]["@odata.type"]).toBe("Microsoft.Dynamics.CRM.msdyn_projecttaskdependency");
    }
    expect(entities[entities.length - 1]["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.msdyn_projecttask",
    );
  });

  it("tasks + auto-deps exceeding 200 triggers the validateDeleteRecords cap", () => {
    // Create 201 task records — should hit the cap via validateDeleteRecords
    const records = Array.from({ length: 201 }, (_, i) => ({
      entityLogicalName: "msdyn_projecttask" as const,
      recordId: String(i).padStart(8, "0") + "-0000-0000-0000-000000000000",
    }));
    expect(() => validateDeleteRecords(records)).toThrow(/200/);
  });

  it("confirmed gate (handler) and whole-plan-delete block (validateDeleteRecords) are intact", () => {
    // confirmed gate is at the handler level (not validateDeleteRecords), so we verify
    // the allow-list / whole-plan guardrails remain unchanged after adding cascade logic.
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "msdyn_project", recordId: GUID }]),
    ).toThrow(/blocked by policy/); // whole-plan block intact
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "msdyn_projecttask", recordId: GUID }]),
    ).not.toThrow(); // valid task passes
  });
});
