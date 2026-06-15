import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Execute OperationSet - msdyn_ExecuteOperationSetV1 (commits the transaction, async)
export const applyChanges: ToolDef = {
  name: "apply_changes",
  title: "Apply Changes to Plan",
  description:
    "Saves (commits) all queued changes of a change session via msdyn_ExecuteOperationSetV1. Saving is ASYNCHRONOUS - after this call, poll 'Check Change Session Status' every ~5s until statusCode 192350003 (Completed). Never report success to the user before Completed.",
  inputSchema: {
    operationSetId: z.string().describe("GUID of the open OperationSet to commit."),
  },
  handler: async (input: { operationSetId: string }) => {
    const BASE = getApiBase();

    const operationSetId = assertGuid(input.operationSetId, "operationSetId");

    const response = await dvReq({
      url: BASE + "/msdyn_ExecuteOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { OperationSetId: operationSetId },
    });

    if (response.status >= 400) {
      throw new Error(
        "execute_operation_set failed (" + response.status + "): " + dvErrorMessage(response),
      );
    }
    return {
      ok: true,
      operationSetId: operationSetId,
      note: "Execution accepted - PSS persists asynchronously. Poll 'Check Change Session Status' every ~5s until statusCode 192350003 (Completed) before telling the user it is done.",
    };
  },
};
