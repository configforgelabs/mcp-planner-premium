import { describe, it, expect } from "vitest";
import {
  buildAssignmentEntities,
  type ResolvedMember,
} from "../src/tools/assignTask.js";
import { validateAddEntities } from "../src/tools/addTasks.js";
import { validateDeleteRecords } from "../src/tools/deleteTasks.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const TASK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TEAM_MEMBER_1 = "cccccccc-dddd-eeee-ffff-000000000001";
const TEAM_MEMBER_2 = "cccccccc-dddd-eeee-ffff-000000000002";
const BOOKABLE_1 = "bbbbbbbb-1111-2222-3333-000000000001";
const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

const ASG_TYPE = "Microsoft.Dynamics.CRM.msdyn_resourceassignment";

const member1: ResolvedMember = {
  name: "Alice",
  teamMemberId: TEAM_MEMBER_1,
  bookableResourceId: BOOKABLE_1,
};

const member2: ResolvedMember = {
  name: "Bob",
  teamMemberId: TEAM_MEMBER_2,
  bookableResourceId: "",
};

describe("buildAssignmentEntities", () => {
  it("builds a single assignment with the four proven binds, no start or finish", () => {
    const { entities, assigned, skipped, warnings } = buildAssignmentEntities(
      PROJECT,
      TASK,
      [member1],
    );
    expect(entities).toHaveLength(1);
    expect(assigned).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(warnings).toHaveLength(0);

    const e = entities[0];
    expect(e["@odata.type"]).toBe(ASG_TYPE);
    expect(GUID_RE.test(e.msdyn_resourceassignmentid)).toBe(true);
    expect(e.msdyn_name).toBe("Alice");

    // Proven lowercase bind names (§5 / addTasksSimple.ts:356-365)
    expect(e["msdyn_taskid@odata.bind"]).toBe("/msdyn_projecttasks(" + TASK + ")");
    expect(e["msdyn_projectid@odata.bind"]).toBe("/msdyn_projects(" + PROJECT + ")");
    expect(e["msdyn_projectteamid@odata.bind"]).toBe("/msdyn_projectteams(" + TEAM_MEMBER_1 + ")");
    expect(e["msdyn_bookableresourceid@odata.bind"]).toBe("/bookableresources(" + BOOKABLE_1 + ")");

    // start/finish MUST NOT be present — blocked on create (PSS derives them)
    expect("msdyn_start" in e).toBe(false);
    expect("msdyn_finish" in e).toBe(false);

    // The assignmentId in the returned metadata matches the entity pk
    expect(assigned[0].assignmentId).toBe(e.msdyn_resourceassignmentid);
    expect(assigned[0].teamMemberId).toBe(TEAM_MEMBER_1);

    // Defense in depth: must pass raw guardrails
    expect(() => validateAddEntities(entities)).not.toThrow();
  });

  it("omits the bookableresource bind when bookableResourceId is empty", () => {
    const { entities } = buildAssignmentEntities(PROJECT, TASK, [member2]);
    expect(entities).toHaveLength(1);
    expect("msdyn_bookableresourceid@odata.bind" in entities[0]).toBe(false);
    // Must still pass guardrails (optional bind)
    expect(() => validateAddEntities(entities)).not.toThrow();
  });

  it("multiple members produce one entity each with unique GUIDs", () => {
    const { entities, assigned } = buildAssignmentEntities(PROJECT, TASK, [member1, member2]);
    expect(entities).toHaveLength(2);
    expect(assigned).toHaveLength(2);

    const id0 = entities[0].msdyn_resourceassignmentid;
    const id1 = entities[1].msdyn_resourceassignmentid;
    expect(GUID_RE.test(id0)).toBe(true);
    expect(GUID_RE.test(id1)).toBe(true);
    expect(id0).not.toBe(id1); // unique GUIDs

    // Both must pass raw guardrails (duplicate-GUID check)
    expect(() => validateAddEntities(entities)).not.toThrow();
  });

  it("skips a member whose teamMemberId is in alreadyAssignedTeamIds (idempotence guard)", () => {
    const already = new Set([TEAM_MEMBER_1.toLowerCase()]);
    const { entities, assigned, skipped, warnings } = buildAssignmentEntities(
      PROJECT,
      TASK,
      [member1, member2],
      already,
    );
    // member1 should be skipped; member2 should be built
    expect(entities).toHaveLength(1);
    expect(assigned).toHaveLength(1);
    expect(skipped).toContain("Alice");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/already assigned/i);
    expect(entities[0]["msdyn_projectteamid@odata.bind"]).toContain(TEAM_MEMBER_2);
  });

  it("throws a clear error when members array is empty", () => {
    expect(() => buildAssignmentEntities(PROJECT, TASK, [])).toThrow(
      /non-empty array/,
    );
  });

  it("all-skipped scenario produces no entities (all already assigned)", () => {
    const already = new Set([TEAM_MEMBER_1.toLowerCase(), TEAM_MEMBER_2.toLowerCase()]);
    const { entities, assigned, skipped } = buildAssignmentEntities(
      PROJECT,
      TASK,
      [member1, member2],
      already,
    );
    expect(entities).toHaveLength(0);
    expect(assigned).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });
});

// Delete / unassign path — tests against validateDeleteRecords (msdyn_resourceassignment
// is in the DELETABLE list and must pass the guardrails).
describe("unassign delete records (validateDeleteRecords)", () => {
  const ASSIGNMENT_ID = "dddddddd-eeee-ffff-0000-111111111111";

  it("msdyn_resourceassignment passes validateDeleteRecords", () => {
    expect(() =>
      validateDeleteRecords([
        { entityLogicalName: "msdyn_resourceassignment", recordId: ASSIGNMENT_ID },
      ]),
    ).not.toThrow();
  });

  it("whole-plan delete is still blocked when mixing assignment + project records", () => {
    expect(() =>
      validateDeleteRecords([
        { entityLogicalName: "msdyn_project", recordId: ASSIGNMENT_ID },
      ]),
    ).toThrow(/blocked by policy/);
  });

  it("more than 200 assignment records still hits the cap", () => {
    const records = Array.from({ length: 201 }, (_, i) => ({
      entityLogicalName: "msdyn_resourceassignment",
      recordId: String(i).padStart(8, "0") + "-0000-0000-0000-000000000000",
    }));
    expect(() => validateDeleteRecords(records)).toThrow(/200/);
  });
});
