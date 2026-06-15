import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// All team members of a plan (generalises find_team_member without the name filter).
export const listTeamMembers: ToolDef = {
  name: "list_team_members",
  title: "List Team Members",
  description:
    "Lists all team members of a plan with their projectteamid and bookableresourceid (needed for resource assignments). Use find_team_member to resolve a single person by name.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { projectId: string }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");

    const res = await dvReq(
      {
        url:
          BASE +
          "/msdyn_projectteams?$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value" +
          "&$filter=_msdyn_project_value eq " +
          projectId +
          "&$top=200",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (res.status >= 400)
      throw new Error("list_team_members failed (" + res.status + "): " + dvErrorMessage(res));

    const members = (res.json?.value || []).map((m: any) => ({
      teamMemberId: m.msdyn_projectteamid,
      name: m.msdyn_name,
      bookableResourceId: m._msdyn_bookableresourceid_value,
    }));
    return { ok: true, projectId, count: members.length, members };
  },
};
