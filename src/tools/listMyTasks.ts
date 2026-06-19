import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, isGuid } from "../dataverse.js";
import { nowIso } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

/** Splits ids into OR-filter chunks so the $filter URL never grows unbounded. */
function chunkIds<T>(ids: T[], size = 20): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** GETs `entitySet` once per id-chunk, OR-ing `field eq <id>`, and merges rows. */
async function queryByIds(
  base: string,
  entitySet: string,
  field: string,
  ids: string[],
  selectAndExpand: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (const group of chunkIds(ids)) {
    const filter = group.map((id) => field + " eq " + id).join(" or ");
    const res = await dvReq(
      {
        url: base + "/" + entitySet + "?" + selectAndExpand + "&$filter=" + filter + "&$top=5000",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (res.status >= 400)
      throw new Error("list_my_tasks (" + entitySet + ") failed (" + res.status + "): " + dvErrorMessage(res));
    for (const r of res.json?.value || []) rows.push(r);
  }
  return rows;
}

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

    // 3. Project-team memberships for those resources (optionally one plan).
    const teamRows = await queryByIds(
      BASE,
      "msdyn_projectteams",
      "_msdyn_bookableresourceid_value",
      resourceIds,
      "$select=msdyn_projectteamid,_msdyn_project_value",
    );
    const teamIds = teamRows
      .filter((t: any) => !scopeProject || String(t._msdyn_project_value).toLowerCase() === scopeProject.toLowerCase())
      .map((t: any) => t.msdyn_projectteamid)
      .filter(Boolean);
    if (teamIds.length === 0) return empty("You are not on any project team" + (scopeProject ? " for that plan." : "."));

    // 4. Resource assignments -> task ids.
    const asgRows = await queryByIds(
      BASE,
      "msdyn_resourceassignments",
      "_msdyn_projectteamid_value",
      teamIds,
      "$select=_msdyn_taskid_value",
    );
    const taskIds = [...new Set(asgRows.map((a: any) => a._msdyn_taskid_value).filter(Boolean))] as string[];
    if (taskIds.length === 0) return empty("You have no task assignments" + (scopeProject ? " on that plan." : "."));

    // 5. The tasks themselves, with plan + bucket names.
    const taskRows = await queryByIds(
      BASE,
      "msdyn_projecttasks",
      "msdyn_projecttaskid",
      taskIds,
      "$select=msdyn_projecttaskid,msdyn_subject,msdyn_start,msdyn_finish,msdyn_progress," +
        "_msdyn_project_value,_msdyn_parenttask_value,_msdyn_projectbucket_value" +
        "&$expand=msdyn_project($select=msdyn_subject),msdyn_projectbucket($select=msdyn_name)",
    );

    // 6. Which of my tasks are summary tasks (a parent of some other task)? Those
    // are excluded from overdue/active (their dates/progress roll up).
    const parentRows = await queryByIds(
      BASE,
      "msdyn_projecttasks",
      "_msdyn_parenttask_value",
      taskIds,
      "$select=_msdyn_parenttask_value",
    );
    const summaryIds = new Set<string>(
      parentRows.map((p: any) => String(p._msdyn_parenttask_value).toLowerCase()).filter(Boolean),
    );

    const nowMs = new Date(nowIso()).getTime();
    const isSummary = (t: any) => summaryIds.has(String(t.msdyn_projecttaskid).toLowerCase());
    const isOverdue = (t: any) =>
      !isSummary(t) &&
      t.msdyn_finish &&
      new Date(t.msdyn_finish).getTime() < nowMs &&
      typeof t.msdyn_progress === "number" &&
      t.msdyn_progress < 1;
    const isActive = (t: any) =>
      !isSummary(t) && (typeof t.msdyn_progress !== "number" || t.msdyn_progress < 1);

    let chosen = taskRows;
    if (filter === "overdue") chosen = taskRows.filter(isOverdue);
    else if (filter === "active") chosen = taskRows.filter(isActive);

    const tasks = chosen
      .map((t: any) => ({
        taskId: t.msdyn_projecttaskid,
        subject: t.msdyn_subject,
        projectId: t._msdyn_project_value ?? null,
        planName: t.msdyn_project?.msdyn_subject ?? null,
        bucketName: t.msdyn_projectbucket?.msdyn_name ?? null,
        start: t.msdyn_start ?? null,
        finish: t.msdyn_finish ?? null,
        progressPercent:
          typeof t.msdyn_progress === "number" ? Math.round(t.msdyn_progress * 100) : null,
        isSummary: isSummary(t),
        overdue: isOverdue(t),
      }))
      .sort((a, b) => String(a.finish ?? "").localeCompare(String(b.finish ?? "")));

    return { ok: true, userId, filter, count: tasks.length, tasks };
  },
};
