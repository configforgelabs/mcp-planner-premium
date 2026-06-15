import { describe, it, expect } from "vitest";
import { buildUpdateEntities } from "../src/tools/updateTasksSimple.js";
import { validateUpdateEntities } from "../src/tools/updateTasks.js";

const ID = "11111111-2222-3333-4444-555555555555";
const TASK = "Microsoft.Dynamics.CRM.msdyn_projecttask";

describe("buildUpdateEntities", () => {
  it("emits only the provided fields with the right Dataverse keys", () => {
    const ents = buildUpdateEntities([
      { taskId: ID, subject: "Renamed", finish: "2026-08-01", effortHours: 8 },
    ]);
    expect(ents).toHaveLength(1);
    const e = ents[0];
    expect(e["@odata.type"]).toBe(TASK);
    expect(e.msdyn_projecttaskid).toBe(ID);
    expect(e.msdyn_subject).toBe("Renamed");
    expect(e.msdyn_finish).toBe("2026-08-01");
    expect(e.msdyn_effort).toBe(8);
    expect("msdyn_start" in e).toBe(false);
  });

  it("converts progressPercent (0-100) to msdyn_progress (0-1)", () => {
    expect(buildUpdateEntities([{ taskId: ID, progressPercent: 50 }])[0].msdyn_progress).toBe(0.5);
    expect(buildUpdateEntities([{ taskId: ID, progressPercent: 100 }])[0].msdyn_progress).toBe(1);
    expect(buildUpdateEntities([{ taskId: ID, progressPercent: 0 }])[0].msdyn_progress).toBe(0);
  });

  it("rejects out-of-range progress", () => {
    expect(() => buildUpdateEntities([{ taskId: ID, progressPercent: 150 }])).toThrow(
      /between 0 and 100/,
    );
  });

  it("maps milestone to msdyn_ismilestone (allowed on update)", () => {
    expect(buildUpdateEntities([{ taskId: ID, milestone: true }])[0].msdyn_ismilestone).toBe(true);
  });

  it("requires a GUID taskId and at least one change", () => {
    expect(() => buildUpdateEntities([{ taskId: "nope", subject: "x" }])).toThrow(
      /taskId must be a GUID/,
    );
    expect(() => buildUpdateEntities([{ taskId: ID }])).toThrow(/nothing to change/);
  });

  it("output is rejected by the summary-task guard when targeting a summary task", () => {
    const ents = buildUpdateEntities([{ taskId: ID, finish: "2026-08-01" }]);
    expect(() => validateUpdateEntities(ents, [ID])).toThrow(/roll up from its children/);
    // ...but a rename on the same summary task is fine.
    const rename = buildUpdateEntities([{ taskId: ID, subject: "ok" }]);
    expect(() => validateUpdateEntities(rename, [ID])).not.toThrow();
  });
});
