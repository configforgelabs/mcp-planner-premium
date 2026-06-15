import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Create OperationSet - msdyn_CreateOperationSetV1 (opens a PSS transaction)
export const startChangeSession: ToolDef = {
  name: "start_change_session",
  title: "Start Change Session",
  description:
    "Opens a change session (PSS OperationSet via msdyn_CreateOperationSetV1) for one plan - required before adding, updating or deleting tasks in batch. Returns the operationSetId used by the batch actions. IMPORTANT: wait for the returned operationSetId before queuing any batch - never call this in the same parallel block as a batch action (causes duplicate-entity errors). Max 10 open sessions per user; list and cancel stale ones via 'Check Change Session Status' / 'Cancel Change Session'. Nothing is saved until 'Apply Changes to Plan'.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan this transaction belongs to."),
    description: z
      .string()
      .optional()
      .describe("Short label for the transaction, e.g. 'Add sprint 3 tasks'."),
  },
  handler: async (input: { projectId: string; description?: string }) => {
    const BASE = getApiBase();

    const projectId = assertGuid(input.projectId, "projectId");

    const response = await dvReq({
      url: BASE + "/msdyn_CreateOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: {
        ProjectId: projectId,
        Description: input.description || "Langdock writer session",
      },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      const msg = dvErrorMessage(response);
      if (/operation ?set/i.test(msg) && /limit|maximum|10/i.test(msg)) {
        throw new Error(
          "Open change session limit reached (max 10 per user). Run 'Check Change Session Status' in list mode and cancel stale sessions first. Detail: " +
            msg,
        );
      }
      throw new Error(
        "create_operation_set failed (" + response.status + "): " + msg,
      );
    }
    return {
      ok: true,
      operationSetId: body.OperationSetId,
      note: "Change session open. Queue batch-add/update/delete calls, then apply. Nothing is saved until 'Apply Changes to Plan'.",
    };
  },
};
