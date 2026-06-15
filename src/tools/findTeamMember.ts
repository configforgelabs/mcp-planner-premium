import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Find Team Member - resolve project team member(s) by display name for ONE plan.
// Returns teamMemberId (projectteamid) + bookableResourceId for msdyn_resourceassignment.
export const findTeamMember: ToolDef = {
  name: "find_team_member",
  title: "Find Team Member",
  description:
    "Resolves project team members by display name for ONE plan. Returns projectteamid AND bookableresourceid needed for msdyn_resourceassignment entities. Use BEFORE adding assignments. If no team member matches, the person must first be added to the plan in the Planner UI - never guess GUIDs.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    name: z
      .string()
      .describe("Full or partial display name of the team member, e.g. 'Marcin Baluta'."),
  },
  handler: async (input: { projectId: string; name: string }) => {
    const BASE = getApiBase();

    const projectId = assertGuid(input.projectId, "projectId");
    const name = (input.name || "").trim();
    if (!name) throw new Error("name is required (full or partial display name).");
    // Escape single quotes for the OData literal.
    const safe = name.replace(/'/g, "''");

    // NOTE: collection 'msdyn_projectteams' and lookup '_msdyn_bookableresourceid_value' are the
    // standard Project for the web names; confirm against metadata if this environment differs.
    const url =
      BASE +
      "/msdyn_projectteams?$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value" +
      "&$filter=_msdyn_project_value eq " +
      projectId +
      " and contains(msdyn_name,'" +
      encodeURIComponent(safe) +
      "')" +
      "&$top=20";

    const response = await dvReq(
      {
        url: url,
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    const body = response.json || {};
    if (response.status >= 400) {
      throw new Error(
        "find_team_member failed (" + response.status + "): " + dvErrorMessage(response),
      );
    }

    const target = name.toLowerCase();
    const members = (body.value || []).map((m: any) => ({
      teamMemberId: m.msdyn_projectteamid,
      name: m.msdyn_name,
      bookableResourceId: m._msdyn_bookableresourceid_value,
      exactMatch:
        typeof m.msdyn_name === "string" && m.msdyn_name.trim().toLowerCase() === target,
    }));
    members.sort((a: any, b: any) => {
      if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
      return 0;
    });
    const exactCount = members.filter((m: any) => m.exactMatch).length;
    let hint: string;
    if (members.length === 0)
      hint =
        "No team member matched - the person may not be on the plan team yet; add them in Planner UI first.";
    else if (exactCount === 1)
      hint = "Exact name match found - use this bookableResourceId for the assignment.";
    else if (exactCount > 1)
      hint = "Multiple team members share this exact name - ask the user, never pick silently.";
    else if (members.length > 1) hint = "Multiple matches - ask the user.";
    else hint = "Unique match.";
    return {
      ok: true,
      count: members.length,
      exactMatchCount: exactCount,
      members: members,
      hint: hint,
    };
  },
};
