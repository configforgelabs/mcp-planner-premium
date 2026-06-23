import { z } from "zod";
import { getApiBase } from "../config.js";
import { isGuid } from "../dataverse.js";
import { tasksForResourceIds } from "./taskAssignments.js";
import type { ToolDef } from "./types.js";

// Tasks assigned to a SPECIFIC person, identified by their bookable-resource id.
// Generalises list_my_tasks (which is hardwired to WhoAmI / "me") to any team
// member — get the bookableResourceId from find_team_member,
// find_team_member_across_plans, or list_team_members first.
//
// Identity chain: bookable resource -> project-team memberships -> resource
// assignments -> tasks. 'overdue'/'active' exclude summary (parent) tasks.
export const listUserTasks: ToolDef = {
  name: "list_user_tasks",
  title: "List User Tasks",
  description:
    "Returns the tasks assigned to a SPECIFIC person across all their plans (or one plan via projectId), given that person's bookableResourceId. Use this to answer 'which tasks does <name> have?': first resolve the name to a bookableResourceId with find_team_member_across_plans (all plans) or find_team_member (one plan) — NEVER guess the id — then call this. filter: 'all', 'overdue' (past finish and under 100%), or 'active' (not yet complete, i.e. open tasks). Default 'active'. Summary (parent) tasks are excluded from 'overdue'/'active'. Each task includes its plan name, bucket, finish date and % complete. Returns count 0 with a note if the resource is on no team or has no assignments.",
  inputSchema: {
    bookableResourceId: z
      .string()
      .describe(
        "GUID of the person's Project bookable resource (the `bookableResourceId` returned by find_team_member / find_team_member_across_plans / list_team_members).",
      ),
    filter: z
      .enum(["all", "overdue", "active"])
      .optional()
      .describe(
        "Which tasks: 'all', 'overdue' (past finish, <100%), or 'active' (open/incomplete, <100%). Default 'active'.",
      ),
    projectId: z
      .string()
      .optional()
      .describe("Optional plan GUID to scope to a single plan. Omit to span all the person's plans."),
  },
  handler: async (input: {
    bookableResourceId: string;
    filter?: "all" | "overdue" | "active";
    projectId?: string;
  }) => {
    const BASE = getApiBase();
    const filter = input.filter ?? "active";
    const resourceId = (input.bookableResourceId || "").trim();
    if (!isGuid(resourceId)) throw new Error("bookableResourceId must be a GUID.");
    const scopeProject = (input.projectId || "").trim();
    if (scopeProject && !isGuid(scopeProject)) throw new Error("projectId must be a GUID.");

    const result = await tasksForResourceIds(BASE, [resourceId], filter, scopeProject);
    return {
      ok: true,
      bookableResourceId: resourceId,
      filter,
      count: result.count,
      tasks: result.tasks,
      ...(result.note ? { note: result.note } : {}),
    };
  },
};
