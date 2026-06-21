import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import { pageAll, readHeaders, linkTypeLabel } from "./readHelpers.js";
import { computeCriticalPath, type AnalyticsTask, type AnalyticsDep } from "./scheduleAnalytics.js";
import type { ToolDef } from "./types.js";

/**
 * get_critical_path — returns the critical path of a plan.
 *
 * Thin handler: validates input, fetches tasks + deps via proven patterns,
 * delegates all analysis to the pure computeCriticalPath core.
 *
 * Read-only: only GETs, pages large results, honours the truncated flag.
 * GUID is assertGuid'd before entering any URL. 404 on the dependency entity
 * degrades gracefully (returns path derived from dates only, with a warning).
 */
export const getCriticalPath: ToolDef = {
  name: "get_critical_path",
  title: "Get Critical Path",
  description:
    "Returns the critical path of a plan: the chain of leaf tasks with ~zero total float that drives the plan finish date, plus per-task total float (slack) in working days. Trusts the PSS-scheduled start/finish dates; computes late dates by a backward pass over the dependency graph (FS links are modelled exactly; SS/FF/SF are modelled where dates allow and flagged in warnings). Summary/parent tasks are excluded. If dependency links are unavailable on this environment, returns an empty path with a warning. If truncated=true the task scan was incomplete and the result is a lower bound.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    floatToleranceDays: z
      .number()
      .optional()
      .describe(
        "Total-float threshold (working days) at/below which a task is 'critical'. Default 0.5.",
      ),
    nearCriticalDays: z
      .number()
      .optional()
      .describe(
        "Tasks with float <= this (but above the critical tolerance) are counted as near-critical. Default 2.",
      ),
  },
  handler: async (input: {
    projectId: string;
    floatToleranceDays?: number;
    nearCriticalDays?: number;
  }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const handlerWarnings: string[] = [];

    // -----------------------------------------------------------------------
    // Task scan — one paginated read of all leaf+summary task fields needed
    // for critical path (engine dates, parent linkage, effort).
    // -----------------------------------------------------------------------
    const taskUrl =
      BASE +
      "/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject,msdyn_start," +
      "msdyn_finish,msdyn_progress,msdyn_ismilestone,msdyn_effort,_msdyn_parenttask_value" +
      "&$filter=_msdyn_project_value eq " +
      projectId;

    const paged = await pageAll(taskUrl, readHeaders());
    if (paged.truncated) {
      handlerWarnings.push(
        "Task scan was truncated; critical path result is a lower bound (some tasks were not analysed).",
      );
    }

    // Derive summary set (a task is a summary if some other task names it as parent)
    const summaryIds = new Set<string>();
    for (const t of paged.rows) {
      const p = t._msdyn_parenttask_value;
      if (p) summaryIds.add(String(p).toLowerCase());
    }

    // Map raw rows to AnalyticsTask
    const tasks: AnalyticsTask[] = paged.rows.map((t: any) => ({
      taskId: String(t.msdyn_projecttaskid).toLowerCase(),
      subject: t.msdyn_subject ?? null,
      start: t.msdyn_start ?? null,
      finish: t.msdyn_finish ?? null,
      progress: typeof t.msdyn_progress === "number" ? t.msdyn_progress : null,
      isMilestone: t.msdyn_ismilestone === true,
      isSummary: summaryIds.has(String(t.msdyn_projecttaskid).toLowerCase()),
      parentTaskId: t._msdyn_parenttask_value ?? null,
      effort: t.msdyn_effort ?? null,
      remainingEffort: null, // not needed for critical path
    }));

    // -----------------------------------------------------------------------
    // Dependency fetch — reuse proven query + 404 degrade from listDependencies
    // -----------------------------------------------------------------------
    const deps: AnalyticsDep[] = [];

    const depRes = await dvReq(
      {
        url:
          BASE +
          "/msdyn_projecttaskdependencies?$select=_msdyn_predecessortask_value," +
          "_msdyn_successortask_value,msdyn_projecttaskdependencylinktype," +
          "msdyn_projecttaskdependencylinklag" +
          "&$filter=_msdyn_project_value eq " +
          projectId +
          "&$top=2000",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );

    if (depRes.status === 404) {
      handlerWarnings.push("Dependency links unavailable on this environment.");
    } else if (depRes.status >= 400) {
      throw new Error(
        "get_critical_path failed (" + depRes.status + "): " + dvErrorMessage(depRes),
      );
    } else {
      for (const d of depRes.json?.value || []) {
        const rawType = linkTypeLabel(d.msdyn_projecttaskdependencylinktype);
        let type: AnalyticsDep["type"];
        if (rawType === "FS" || rawType === "SS" || rawType === "FF" || rawType === "SF") {
          type = rawType;
        } else if (rawType && rawType.startsWith("Unknown(")) {
          type = "Unknown" as const;
        } else {
          type = undefined;
        }
        deps.push({
          predecessorTaskId: String(d._msdyn_predecessortask_value).toLowerCase(),
          successorTaskId: String(d._msdyn_successortask_value).toLowerCase(),
          type,
          lagMinutes: d.msdyn_projecttaskdependencylinklag ?? null,
        });
      }
    }

    // -----------------------------------------------------------------------
    // Run the pure analytics core
    // -----------------------------------------------------------------------
    const result = computeCriticalPath(tasks, deps, {
      floatToleranceDays: input.floatToleranceDays,
      nearCriticalDays: input.nearCriticalDays,
    });

    const allWarnings = [...handlerWarnings, ...result.warnings];

    return {
      ok: true,
      projectId,
      projectStart: result.projectStart,
      projectFinish: result.projectFinish,
      totalDurationDays: result.totalDurationDays,
      criticalPath: result.path,
      criticalCount: result.criticalCount,
      nearCriticalCount: result.nearCriticalCount,
      floatToleranceDays: input.floatToleranceDays ?? 0.5,
      nearCriticalDays: input.nearCriticalDays ?? 2,
      truncated: paged.truncated,
      warnings: allWarnings,
    };
  },
};
