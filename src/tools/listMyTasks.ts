import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, isGuid } from "../dataverse.js";
import { tasksForResourceIds } from "./taskAssignments.js";
import type { ToolDef } from "./types.js";

// The current user's task assignments across ALL their plans (or one plan).
// Identity chain: WhoAmI -> bookable resource (links the user) -> project-team
// memberships -> resource assignments -> tasks. 'overdue'/'active' exclude
// summary (parent) tasks, whose dates roll up from their children.
export const listMyTasks: ToolDef = {
  name: "list_my_tasks",
  title: "List My Tasks",
  description:
    "Returns the SIGNED-IN user's assigned tasks across all their plans (or one plan via projectId). filter: 'all', 'overdue' (past finish and under 100%), or 'active' (not yet complete). Resolves 'me' automatically via WhoAmI → the user's Project bookable resource → project-team memberships → resource assignments, so you do NOT pass a user id. Summary (parent) tasks are excluded from 'overdue'/'active' (their dates roll up from children). Each task includes its plan name, bucket, finish date and % complete. Returns count 0 with a note if the user is not a Project resource or has no assignments.",
  inputSchema: {
    filter: z
      .enum(["all", "overdue", "active"])
      .optional()
      .describe("Which of my tasks: 'all', 'overdue' (past finish, <100%), or 'active' (<100%). Default 'overdue'."),
    projectId: z
      .string()
      .optional()
      .describe("Optional plan GUID to scope to a single plan. Omit to span all my plans."),
  },
  handler: async (input: { filter?: "all" | "overdue" | "active"; projectId?: string }) => {
    const BASE = getApiBase();
    const filter = input.filter ?? "overdue";
    const scopeProject = (input.projectId || "").trim();
    if (scopeProject && !isGuid(scopeProject)) throw new Error("projectId must be a GUID.");

    // 1. Who am I.
    const who = await dvReq(
      { url: BASE + "/WhoAmI", method: "GET", headers: dvHeaders() },
      { retry: true },
    );
    if (who.status >= 400)
      throw new Error("list_my_tasks: WhoAmI failed (" + who.status + "): " + dvErrorMessage(who));
    const userId: string | undefined = who.json?.UserId;
    if (!userId) throw new Error("list_my_tasks: WhoAmI returned no UserId.");

    const empty = (note: string) => ({ ok: true, userId, filter, count: 0, tasks: [], note });

    // 2. The user's bookable resource(s).
    const brRes = await dvReq(
      {
        url:
          BASE +
          "/bookableresources?$select=bookableresourceid&$filter=_userid_value eq " +
          userId +
          "&$top=50",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (brRes.status >= 400)
      throw new Error("list_my_tasks: bookable-resource lookup failed (" + brRes.status + "): " + dvErrorMessage(brRes));
    const resourceIds = (brRes.json?.value || []).map((r: any) => r.bookableresourceid).filter(Boolean);
    if (resourceIds.length === 0)
      return empty("You are not a Project bookable resource, so you have no task assignments.");

    // 3-6. Shared chain: team memberships → assignments → tasks → summary-aware filter.
    const result = await tasksForResourceIds(BASE, resourceIds, filter, scopeProject);
    if (result.note) return empty(result.note);
    return { ok: true, userId, filter, count: result.count, tasks: result.tasks };
  },
};
