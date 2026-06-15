import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Abandon OperationSet - msdyn_AbandonOperationSetV1 (cleanup / rollback before execution)
export const cancelSession: ToolDef = {
  name: "cancel_change_session",
  title: "Cancel Change Session",
  description:
    "Cancels an unsaved change session via msdyn_AbandonOperationSetV1, discarding all queued (uncommitted) changes - a rollback before saving. The session then shows status 192350004 (Abandoned) in check_change_session_status. Use to clean up stale sessions or when the user cancels a pending change set.",
  inputSchema: {
    operationSetId: z.string().describe("GUID of the OperationSet to abandon."),
  },
  handler: async (input: { operationSetId: string }) => {
    const BASE = getApiBase();

    const operationSetId = assertGuid(input.operationSetId, "operationSetId");

    const response = await dvReq({
      url: BASE + "/msdyn_AbandonOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { OperationSetId: operationSetId },
    });

    if (response.status >= 400) {
      throw new Error(
        "abandon_operation_set failed (" + response.status + "): " + dvErrorMessage(response),
      );
    }
    return {
      ok: true,
      operationSetId: operationSetId,
      note: "OperationSet abandoned - queued (uncommitted) operations discarded.",
    };
  },
};
