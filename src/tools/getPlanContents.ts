import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, assertGuid, isGuid, type DvResponse } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Get Plan Contents - narrow read: buckets + ALL tasks of ONE plan (paginated) for verification.
// Returns parentTaskId / isMilestone / isSummary plus a summaryTaskIds array so callers can
// protect rolled-up fields. Summary (parent) task dates/effort/progress roll up from children
// and MUST NOT be written to via PSS update.
export const getPlanContents: ToolDef = {
  name: "get_plan_tasks_and_buckets",
  title: "Get Plan Tasks & Buckets",
  description:
    "Returns all buckets and ALL tasks (paginated, no silent truncation) of ONE plan, ordered as displayed: id, name, dates, progress, effort, outline level, bucket, plus parentTaskId, isMilestone and isSummary flags. Also returns summaryTaskIds (the ids of all summary/parent tasks). Summary task dates, effort and progress are ROLLED UP from their children and MUST NOT be written to - pass summaryTaskIds to update_tasks / update_tasks_batch so those rolled-up fields are protected. The returned task/plan 'progress' is a 0-1 fraction (0.5 = 50%). Use to verify results after 'Apply Changes to Plan' completes, and to look up taskIds/bucketIds before updates or deletions. If truncated=true the plan exceeded the page cap and the task list is incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    bucketId: z
      .string()
      .optional()
      .describe(
        "Optional bucketId GUID. If given, only that bucket's tasks are returned - use it to narrow large plans and keep the response within the model's context budget.",
      ),
  },
  handler: async (input: { projectId: string; bucketId?: string }) => {
    const BASE = getApiBase();

    const projectId = assertGuid(input.projectId, "projectId");
    const bucketFilter = (input.bucketId || "").trim();
    if (bucketFilter && !isGuid(bucketFilter))
      throw new Error("bucketId must be a GUID.");

    // odata.maxpagesize raises the server page size; we still follow @odata.nextLink to be safe.
    const headers = dvHeaders({
      extra: {
        Prefer:
          'odata.maxpagesize=1000,odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
      },
    });

    // Runaway guard: 10 pages x 1000 rows = 10,000 task cap. Hitting it (or leaving a nextLink
    // unfollowed) sets truncated=true so callers never report false success.
    const MAX_PAGES = 10;

    async function pageAll(firstUrl: string, label: string) {
      const rows: any[] = [];
      let url: string | null = firstUrl;
      let pages = 0;
      let truncated = false;
      while (url) {
        if (pages >= MAX_PAGES) {
          truncated = true;
          break;
        }
        const res: DvResponse = await dvReq(
          { url, method: "GET", headers },
          { retry: true },
        );
        const body = res.json || {};
        if (res.status >= 400) {
          const msg = (body.error && body.error.message) || "HTTP " + res.status;
          throw new Error(
            "get_plan_contents (" + label + ") failed (" + res.status + "): " + msg,
          );
        }
        pages++;
        const page = body.value || [];
        for (let i = 0; i < page.length; i++) rows.push(page[i]);
        url = body["@odata.nextLink"] || null;
      }
      return { rows, pages, truncated };
    }

    // Buckets rarely paginate, but handle nextLink anyway.
    const bucketsUrl =
      BASE +
      "/msdyn_projectbuckets?$select=msdyn_projectbucketid,msdyn_name" +
      "&$filter=_msdyn_project_value eq " +
      projectId +
      "&$top=200";
    const bucketsPaged = await pageAll(bucketsUrl, "buckets");

    const taskFilter =
      "_msdyn_project_value eq " +
      projectId +
      (bucketFilter ? " and _msdyn_projectbucket_value eq " + bucketFilter : "");
    const tasksUrl =
      BASE +
      "/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject," +
      "msdyn_start,msdyn_finish,msdyn_progress,msdyn_effort,msdyn_outlinelevel,msdyn_displaysequence," +
      "_msdyn_projectbucket_value,_msdyn_parenttask_value,msdyn_ismilestone" +
      "&$filter=" +
      taskFilter +
      "&$orderby=msdyn_displaysequence asc";
    const tasksPaged = await pageAll(tasksUrl, "tasks");

    // A task is a summary task if some other task names it as its parent.
    const rawTasks = tasksPaged.rows;
    const parentIds: Record<string, boolean> = {};
    for (let i = 0; i < rawTasks.length; i++) {
      const pid = rawTasks[i]._msdyn_parenttask_value;
      if (pid) parentIds[String(pid).toLowerCase()] = true;
    }

    const tasks = rawTasks.map((t: any) => {
      const id = t.msdyn_projecttaskid;
      return {
        taskId: id,
        subject: t.msdyn_subject,
        start: t.msdyn_start,
        finish: t.msdyn_finish,
        progress: t.msdyn_progress,
        effortHours: t.msdyn_effort,
        outlineLevel: t.msdyn_outlinelevel,
        bucketId: t._msdyn_projectbucket_value,
        parentTaskId: t._msdyn_parenttask_value || null,
        isMilestone: t.msdyn_ismilestone === true,
        isSummary: !!parentIds[String(id).toLowerCase()],
      };
    });

    const summaryTaskIds = tasks.filter((t: any) => t.isSummary).map((t: any) => t.taskId);

    return {
      ok: true,
      projectId: projectId,
      truncated: bucketsPaged.truncated || tasksPaged.truncated,
      pageCount: bucketsPaged.pages + tasksPaged.pages,
      buckets: bucketsPaged.rows.map((b: any) => ({
        bucketId: b.msdyn_projectbucketid,
        name: b.msdyn_name,
      })),
      taskCount: tasks.length,
      summaryTaskIds: summaryTaskIds,
      tasks: tasks,
    };
  },
};
