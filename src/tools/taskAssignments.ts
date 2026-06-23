/**
 * Shared task-assignment chain: bookable resource(s) → project-team memberships
 * → resource assignments → tasks, with summary-aware overdue/active filtering.
 *
 * Extracted from listMyTasks so the "tasks for the signed-in user" (list_my_tasks)
 * and "tasks for a named/looked-up user" (list_user_tasks) tools run the SAME
 * proven query path — only the starting resource id(s) differ (WhoAmI for "me",
 * a caller-supplied bookableResourceId for an arbitrary person).
 *
 * Read-only. Chunks long $filter id lists so the URL never grows unbounded.
 */
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import { nowIso } from "./readHelpers.js";

/** Splits ids into OR-filter chunks so the $filter URL never grows unbounded. */
export function chunkIds<T>(ids: T[], size = 20): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** GETs `entitySet` once per id-chunk, OR-ing `field eq <id>`, and merges rows. */
export async function queryByIds(
  base: string,
  entitySet: string,
  field: string,
  ids: string[],
  selectAndExpand: string,
  label = "task lookup",
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
      throw new Error(label + " (" + entitySet + ") failed (" + res.status + "): " + dvErrorMessage(res));
    for (const r of res.json?.value || []) rows.push(r);
  }
  return rows;
}

export interface AssignedTask {
  taskId: string;
  subject: string;
  projectId: string | null;
  planName: string | null;
  bucketName: string | null;
  start: string | null;
  finish: string | null;
  progressPercent: number | null;
  isSummary: boolean;
  overdue: boolean;
}

export interface ResourceTasksResult {
  count: number;
  tasks: AssignedTask[];
  note?: string;
}

/**
 * Resolves the tasks assigned to the given bookable-resource id(s), optionally
 * scoped to one plan, and filtered by 'all' | 'overdue' | 'active'. Summary
 * (parent) tasks are excluded from overdue/active (their dates roll up).
 *
 * `scopeProject` is a lowercase-comparable plan GUID or "" for all plans. The
 * caller is responsible for validating it as a GUID.
 */
export async function tasksForResourceIds(
  base: string,
  resourceIds: string[],
  filter: "all" | "overdue" | "active",
  scopeProject: string,
): Promise<ResourceTasksResult> {
  const empty = (note: string): ResourceTasksResult => ({ count: 0, tasks: [], note });

  // 1. Project-team memberships for those resources (optionally one plan).
  const teamRows = await queryByIds(
    base,
    "msdyn_projectteams",
    "_msdyn_bookableresourceid_value",
    resourceIds,
    "$select=msdyn_projectteamid,_msdyn_project_value",
  );
  const teamIds = teamRows
    .filter((t: any) => !scopeProject || String(t._msdyn_project_value).toLowerCase() === scopeProject.toLowerCase())
    .map((t: any) => t.msdyn_projectteamid)
    .filter(Boolean);
  if (teamIds.length === 0)
    return empty("Not on any project team" + (scopeProject ? " for that plan." : "."));

  // 2. Resource assignments -> task ids.
  const asgRows = await queryByIds(
    base,
    "msdyn_resourceassignments",
    "_msdyn_projectteamid_value",
    teamIds,
    "$select=_msdyn_taskid_value",
  );
  const taskIds = [...new Set(asgRows.map((a: any) => a._msdyn_taskid_value).filter(Boolean))] as string[];
  if (taskIds.length === 0)
    return empty("No task assignments" + (scopeProject ? " on that plan." : "."));

  // 3. The tasks themselves, with plan + bucket names.
  const taskRows = await queryByIds(
    base,
    "msdyn_projecttasks",
    "msdyn_projecttaskid",
    taskIds,
    "$select=msdyn_projecttaskid,msdyn_subject,msdyn_start,msdyn_finish,msdyn_progress," +
      "_msdyn_project_value,_msdyn_parenttask_value,_msdyn_projectbucket_value" +
      "&$expand=msdyn_project($select=msdyn_subject),msdyn_projectbucket($select=msdyn_name)",
  );

  // 4. Which of these tasks are summary tasks (a parent of some other task)?
  const parentRows = await queryByIds(
    base,
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

  const tasks: AssignedTask[] = chosen
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

  return { count: tasks.length, tasks };
}
