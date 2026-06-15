import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Diagnostic - Dataverse WhoAmI. Replaces the Langdock OAuth "authTestCode" snippet;
// confirms the forwarded delegated token is valid and reaches Dataverse.
export const whoami: ToolDef = {
  name: "whoami",
  title: "Who Am I (diagnostic)",
  description:
    "Diagnostic only: calls Dataverse WhoAmI with the signed-in user's forwarded token and returns UserId / BusinessUnitId / OrganizationId. Use to confirm the connection and token are valid before running real actions.",
  inputSchema: {},
  handler: async () => {
    const BASE = getApiBase();
    const response = await dvReq(
      {
        url: BASE + "/WhoAmI",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    const body = response.json || {};
    if (response.status >= 400) {
      throw new Error("whoami failed (" + response.status + "): " + dvErrorMessage(response));
    }
    return {
      ok: true,
      userId: body.UserId,
      businessUnitId: body.BusinessUnitId,
      organizationId: body.OrganizationId,
    };
  },
};
