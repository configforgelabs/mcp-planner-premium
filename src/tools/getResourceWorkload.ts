import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvErrorMessage, assertGuid } from "../dataverse.js";
import { pageAll, readHeaders, nowIso } from "./readHelpers.js";
import {
  getExtendedTaskFieldsCapability,
  setExtendedTaskFieldsCapability,
  isMissingPropertyError,
  EXTENDED_TASK_FIELDS,
} from "./capabilities.js";
import {
  computeResourceWorkload,
  type AnalyticsTask,
  type Assignment,
} from "./scheduleAnalytics.js";
import type { ToolDef } from "./types.js";

/**
 * get_resource_workload — per-team-member effort & overdue rollup for a plan.
 *
 * Thin handler: validates input, resolves the extended-field capability (cached),
 * fetches tasks + resource assignments, delegates to computeResourceWorkload.
 *
 * Identity is traced by teamMemberId (bookable resource id), never by display
 * name — a plan auto-adds its creator as "Project Manager 1", so names are
 * unreliable. See PSS-IMPLEMENTATION-LESSONS.md §2 (Identity).
 *
 * Read-only: only GETs, pages large results, honours the truncated flag.
 * Assignment 404/4xx degrades gracefully to a single (Unassigned) bucket.
 */
export const getResourceWorkload: ToolDef = {
  name: "get_resource_workload",
  title: "Get Resource Workload",
  description:
    "Returns per-team-member workload for a plan: assigned leaf-task count, total effort hours, remaining effort hours, and overdue count. Joins resource assignments to tasks. Members with no assignments are omitted unless they appear on the team. Remaining-effort hours are null on environments that don't expose msdyn_remainingeffort (a warning is added). Unassigned tasks are summed under a synthetic '(Unassigned)' row. If truncated=true a scan was incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { projectId: string }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const handlerWarnings: string[] = [];
    const currentNow = nowIso();

    // -----------------------------------------------------------------------
    // Step 1: Resolve extended-field capability (cached)
    // -----------------------------------------------------------------------
    let cap = getExtendedTaskFieldsCapability();
    let hasRemainingEffort = cap === "present";

    // Base task fields (always available)
    const CORE_TASK_SELECT =
      "msdyn_projecttaskid,msdyn_subject,msdyn_finish,msdyn_progress," +
      "msdyn_effort,_msdyn_parenttask_value";

    let taskUrl: string;
    const baseTaskUrl =
      BASE +
      "/msdyn_projecttasks?$select=" +
      CORE_TASK_SELECT;
    const filterSuffix = "&$filter=_msdyn_project_value eq " + projectId;

    // -----------------------------------------------------------------------
    // Step 2: Task scan with extended-field try-then-fallback
    // -----------------------------------------------------------------------
    let paged;

    if (cap === "absent") {
      // Known absent — skip probe, go straight to core select
      taskUrl = baseTaskUrl + filterSuffix;
      paged = await pageAll(taskUrl, readHeaders());
      hasRemainingEffort = false;
    } else if (cap === "present") {
      // Known present — use extended select directly
      taskUrl = baseTaskUrl + "," + EXTENDED_TASK_FIELDS + filterSuffix;
      paged = await pageAll(taskUrl, readHeaders());
      hasRemainingEffort = true;
    } else {
      // Unknown — try extended first (one probe request), then fall back
      const extUrl = baseTaskUrl + "," + EXTENDED_TASK_FIELDS + filterSuffix;

      // Try the extended URL with a single probe request (first page only)
      const probeRes = await dvReq(
        { url: extUrl, method: "GET", headers: readHeaders() },
        { retry: true },
      );

      if (isMissingPropertyError(probeRes.status, dvErrorMessage(probeRes))) {
        // Extended fields absent on this tenant
        setExtendedTaskFieldsCapability("absent");
        hasRemainingEffort = false;
        // Re-run the full paginated scan with core select
        taskUrl = baseTaskUrl + filterSuffix;
        paged = await pageAll(taskUrl, readHeaders());
      } else if (probeRes.status >= 400) {
        throw new Error(
          "get_resource_workload failed (" + probeRes.status + "): " + dvErrorMessage(probeRes),
        );
      } else {
        // Extended fields present — record and collect remaining pages via pageAll
        setExtendedTaskFieldsCapability("present");
        hasRemainingEffort = true;
        // The probe already returned the first page; collect the rest.
        // Simplest correct approach: re-run pageAll (the probe was a capability
        // check, not a page-accumulation step — pageAll handles pagination).
        taskUrl = extUrl;
        paged = await pageAll(taskUrl, readHeaders());
      }
    }

    if (paged.truncated) {
      handlerWarnings.push(
        "Task scan was truncated; resource workload result is a lower bound (some tasks were not analysed).",
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
      remainingEffort: hasRemainingEffort ? (t.msdyn_remainingeffort ?? null) : null,
    }));

    // -----------------------------------------------------------------------
    // Step 3: Assignment scan — paginated + plan-scoped. Degrades gracefully
    // (some tenants don't expose the entity set) and flips truncated on overflow.
    // -----------------------------------------------------------------------
    const assignments: Assignment[] = [];
    let assignmentsTruncated = false;

    const asgUrl =
      BASE +
      "/msdyn_resourceassignments?$select=_msdyn_taskid_value,_msdyn_projectteamid_value" +
      "&$expand=msdyn_projectteamid($select=msdyn_name)" +
      "&$filter=_msdyn_projectid_value eq " +
      projectId;

    try {
      const asgPaged = await pageAll(asgUrl, readHeaders());
      assignmentsTruncated = asgPaged.truncated;
      for (const a of asgPaged.rows) {
        assignments.push({
          taskId: String(a._msdyn_taskid_value).toLowerCase(),
          teamMemberId: a._msdyn_projectteamid_value ?? null,
          name: a.msdyn_projectteamid?.msdyn_name ?? null,
        });
      }
    } catch {
      // 404 / 4xx (entity set not exposed on this environment) → degrade.
      handlerWarnings.push("Resource assignments unavailable on this environment.");
    }

    if (assignmentsTruncated) {
      handlerWarnings.push(
        "Assignment scan was truncated; resource workload is a lower bound (some assignments were not counted).",
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Pure analytics core
    // -----------------------------------------------------------------------
    const result = computeResourceWorkload(tasks, assignments, currentNow, {
      hasRemainingEffort,
    });

    const allWarnings = [...handlerWarnings, ...result.warnings];

    return {
      ok: true,
      projectId,
      members: result.members,
      memberCount: result.members.length,
      hasRemainingEffort,
      truncated: paged.truncated || assignmentsTruncated,
      warnings: allWarnings,
    };
  },
};
