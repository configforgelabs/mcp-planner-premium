import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import { pageAll, readHeaders, nowIso, linkTypeLabel } from "./readHelpers.js";
import {
  computeScheduleHealth,
  type AnalyticsTask,
  type AnalyticsDep,
} from "./scheduleAnalytics.js";
import type { ToolDef } from "./types.js";

/**
 * get_schedule_health — schedule risk rollup for a plan.
 *
 * Thin handler: validates input, fetches tasks + deps, delegates all analysis
 * to the pure computeScheduleHealth core. Shares the same task scan shape as
 * get_critical_path for consistency.
 *
 * Read-only: only GETs, pages large results, honours the truncated flag.
 * 404 on the dependency entity degrades gracefully (blocked = [], warning).
 */
export const getScheduleHealth: ToolDef = {
  name: "get_schedule_health",
  title: "Get Schedule Health",
  description:
    "Returns a schedule-risk rollup for a plan: overdue leaf tasks, at-risk tasks (due within N days and under X% complete), blocked tasks (an incomplete predecessor while the successor is scheduled to have started), milestones at risk, and summary tasks slipping (a child finishes after the summary's finish). N (atRiskWithinDays) and X (atRiskMinProgressPercent) are parameters with sensible defaults. Counts leaf tasks for overdue/at-risk (summary dates roll up). Degrades to a warning if dependency links are unavailable. If truncated=true the scan was incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    atRiskWithinDays: z
      .number()
      .optional()
      .describe(
        "A leaf task due within this many days (and below the progress floor) is 'at risk'. Default 7.",
      ),
    atRiskMinProgressPercent: z
      .number()
      .optional()
      .describe(
        "Progress floor (0-100): an at-risk-window task at/below this percent is flagged. Default 50.",
      ),
  },
  handler: async (input: {
    projectId: string;
    atRiskWithinDays?: number;
    atRiskMinProgressPercent?: number;
  }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const handlerWarnings: string[] = [];
    const currentNow = nowIso();

    // -----------------------------------------------------------------------
    // Task scan — superset of fields needed for both health and critical path
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
        "Task scan was truncated; schedule health result is a lower bound (some tasks were not analysed).",
      );
    }

    // Derive summary set
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
      remainingEffort: null,
    }));

    // -----------------------------------------------------------------------
    // Dependency fetch — 404 degrade (same as getCriticalPath)
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
      handlerWarnings.push(
        "Dependency links unavailable on this environment; blocked task detection skipped.",
      );
    } else if (depRes.status >= 400) {
      throw new Error(
        "get_schedule_health failed (" + depRes.status + "): " + dvErrorMessage(depRes),
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
    // Pure analytics core
    // -----------------------------------------------------------------------
    const result = computeScheduleHealth(tasks, deps, currentNow, {
      atRiskWithinDays: input.atRiskWithinDays,
      atRiskMinProgressPercent: input.atRiskMinProgressPercent,
    });

    const allWarnings = [...handlerWarnings, ...result.warnings];

    return {
      ok: true,
      projectId,
      now: currentNow,
      counts: result.counts,
      overdue: result.overdue,
      atRisk: result.atRisk,
      blocked: result.blocked,
      milestonesAtRisk: result.milestonesAtRisk,
      slippingSummaries: result.slippingSummaries,
      atRiskWithinDays: input.atRiskWithinDays ?? 7,
      atRiskMinProgressPercent: input.atRiskMinProgressPercent ?? 50,
      truncated: paged.truncated,
      warnings: allWarnings,
    };
  },
};
