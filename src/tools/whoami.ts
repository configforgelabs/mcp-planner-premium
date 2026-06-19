import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Diagnostic - Dataverse WhoAmI. Replaces the Langdock OAuth "authTestCode" snippet;
// confirms the forwarded delegated token is valid and reaches Dataverse.
export const whoami: ToolDef = {
  name: "whoami",
  title: "Who Am I (diagnostic)",
  description:
    "Returns the signed-in user's identity: UserId (Dataverse systemuserid), BusinessUnitId, OrganizationId, and - when the user maps to a Project bookable resource - bookableResourceId and resourceName. The bookableResourceId is the identity used to find the user's task assignments (it links project-team memberships to the user); list_my_tasks uses this chain. Use to confirm the connection/token are valid and to know who 'me' is.",
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

    // Best-effort: resolve the caller's Project bookable resource (links the user
    // to project-team memberships and task assignments). Degrades to null if the
    // user is not a Project resource or the entity is unavailable.
    let bookableResourceId: string | null = null;
    let resourceName: string | null = null;
    if (body.UserId) {
      try {
        const res = await dvReq(
          {
            url:
              BASE +
              "/bookableresources?$select=bookableresourceid,name&$filter=_userid_value eq " +
              body.UserId +
              "&$top=1",
            method: "GET",
            headers: dvHeaders(),
          },
          { retry: true },
        );
        if (res.status < 400) {
          const r = res.json?.value?.[0];
          if (r) {
            bookableResourceId = r.bookableresourceid;
            resourceName = r.name ?? null;
          }
        }
      } catch {
        // Non-fatal — leave resource fields null.
      }
    }

    return {
      ok: true,
      userId: body.UserId,
      businessUnitId: body.BusinessUnitId,
      organizationId: body.OrganizationId,
      bookableResourceId,
      resourceName,
    };
  },
};
