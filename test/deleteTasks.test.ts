import { describe, it, expect } from "vitest";
import { buildDeleteEntities, validateDeleteRecords } from "../src/tools/deleteTasks.js";

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
