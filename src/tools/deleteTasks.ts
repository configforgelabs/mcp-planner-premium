import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, asArray } from "../dataverse.js";
import type { ToolDef } from "./types.js";

const DELETABLE = [
  "msdyn_projecttask",
  "msdyn_projecttaskdependency",
  "msdyn_resourceassignment",
  "msdyn_projectbucket",
  "msdyn_projectsprint",
  "msdyn_projectchecklist",
  "msdyn_projecttasktolabel",
];

/**
 * Validates the delete record list for msdyn_PssDeleteV2. Whole-plan deletes
 * are hard-blocked by policy. Pure (no network); unit-testable.
 */
export function validateDeleteRecords(records: any[]): void {
  if (!Array.isArray(records) || records.length === 0)
    throw new Error(
      "records must be a non-empty JSON array of { entityLogicalName, recordId }.",
    );
  if (records.length > 200)
    throw new Error("Max 200 deletes per OperationSet.");

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.entityLogicalName === "msdyn_project") {
      throw new Error(
        "records[" +
          i +
          "]: deleting whole plans via API is blocked by policy (and unsupported by PSS).",
      );
    }
    if (!DELETABLE.includes(r.entityLogicalName) || !r.recordId) {
      throw new Error(
        "records[" +
          i +
          "]: invalid entityLogicalName or missing recordId. Deletable: " +
          DELETABLE.join(", "),
      );
    }
  }
}

// PSS Batch Delete - msdyn_PssDeleteV2 (guarded; whole-plan deletes blocked by policy)
export const deleteTasks: ToolDef = {
  name: "delete_tasks_batch",
  title: "Delete Tasks from Plan (Batch)",
  description:
    "Deletes up to 200 items (tasks, dependencies, assignments, buckets, checklists) in ONE call via msdyn_PssDeleteV2, inside an open change session. REQUIRES confirmed=true after an explicit per-record user confirmation. Provide at least one of taskIds (task GUIDs) or records. Deleting whole plans is hard-blocked by policy. Deletions are saved only after 'Apply Changes to Plan'.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    taskIds: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Convenience for the common case: a JSON array of task GUIDs to delete. Expanded to msdyn_projecttask records. Use 'records' instead for dependencies, buckets, assignments etc.",
      ),
    records: z
      .union([z.string(), z.array(z.record(z.any()))])
      .optional()
      .describe(
        'For non-task deletes (or mixed): JSON array [{"entityLogicalName":"msdyn_projecttaskdependency","recordId":"<guid>"}]. Combined with taskIds if both are given. Max 200 total.',
      ),
    confirmed: z
      .boolean()
      .describe(
        "Set true ONLY after the user explicitly confirmed each listed record.",
      ),
  },
  handler: async (input: {
    operationSetId: string;
    taskIds?: unknown;
    records?: unknown;
    confirmed: boolean;
  }) => {
    const BASE = getApiBase();

    const operationSetId = (input.operationSetId || "").trim();
    if (!operationSetId) throw new Error("operationSetId is required.");
    if (input.confirmed !== true && (input.confirmed as unknown) !== "true") {
      throw new Error(
        "Refused: 'confirmed' must be true. Obtain an explicit per-record user confirmation BEFORE calling this action.",
      );
    }

    const records: { entityLogicalName: string; recordId: string }[] = [];
    if (input.taskIds !== undefined && input.taskIds !== null) {
      const ids = asArray<string>(input.taskIds, "taskIds");
      for (const id of ids)
        records.push({ entityLogicalName: "msdyn_projecttask", recordId: id });
    }
    if (input.records !== undefined && input.records !== null) {
      const raw = asArray<{ entityLogicalName: string; recordId: string }>(
        input.records,
        "records",
      );
      for (const r of raw) records.push(r);
    }
    if (records.length === 0)
      throw new Error("Provide taskIds (task GUIDs) and/or records to delete.");
    validateDeleteRecords(records);

    const response = await dvReq({
      url: BASE + "/msdyn_PssDeleteV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: {
        EntityCollection: records.map((r) => ({
          EntityLogicalName: r.entityLogicalName,
          RecordId: r.recordId,
        })),
        OperationSetId: operationSetId,
      },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      const msg = dvErrorMessage(response);
      if (response.status === 403)
        throw new Error("403 - missing license or privileges: " + msg);
      throw new Error("pss_delete_batch failed (" + response.status + "): " + msg);
    }
    return {
      ok: true,
      queued: records.length,
      response: body,
      note: "Deletes queued. Saved only after 'Apply Changes to Plan'.",
    };
  },
};
