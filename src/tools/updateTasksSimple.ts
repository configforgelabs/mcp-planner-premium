import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, asArray } from "../dataverse.js";
import { validateUpdateEntities } from "./updateTasks.js";
import type { ToolDef } from "./types.js";

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

export interface SimpleTaskUpdate {
  taskId: string;
  subject?: string;
  description?: string;
  start?: string;
  finish?: string;
  effortHours?: number;
  progressPercent?: number; // 0-100, converted to msdyn_progress 0-1
  milestone?: boolean;
  priority?: number;
}

/**
 * Translates the ergonomic update list into PSS update entities. Only the fields
 * the caller provides are emitted; `progressPercent` (0-100) is converted to
 * `msdyn_progress` (0-1). Pure and unit-testable. Summary-task rolled-up-field
 * protection is enforced separately by validateUpdateEntities (which the handler
 * runs on the result).
 */
export function buildUpdateEntities(tasks: SimpleTaskUpdate[]): any[] {
  if (!Array.isArray(tasks) || tasks.length === 0)
    throw new Error("tasks must be a non-empty array.");

  return tasks.map((t, i) => {
    const id = (t.taskId || "").trim();
    if (!id) throw new Error("tasks[" + i + "]: taskId is required.");
    if (!GUID_RE.test(id))
      throw new Error("tasks[" + i + "]: taskId must be a GUID.");

    const ent: Record<string, unknown> = {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
      msdyn_projecttaskid: id,
    };
    let changed = 0;
    if (t.subject !== undefined) {
      ent.msdyn_subject = t.subject;
      changed++;
    }
    if (t.description !== undefined) {
      ent.msdyn_description = t.description;
      changed++;
    }
    if (t.start !== undefined) {
      ent.msdyn_start = t.start;
      changed++;
    }
    if (t.finish !== undefined) {
      ent.msdyn_finish = t.finish;
      changed++;
    }
    if (t.effortHours !== undefined) {
      ent.msdyn_effort = t.effortHours;
      changed++;
    }
    if (t.progressPercent !== undefined) {
      if (typeof t.progressPercent !== "number" || t.progressPercent < 0 || t.progressPercent > 100)
        throw new Error(
          "tasks[" + i + "]: progressPercent must be a number between 0 and 100.",
        );
      ent.msdyn_progress = t.progressPercent / 100;
      changed++;
    }
    if (t.milestone !== undefined) {
      ent.msdyn_ismilestone = t.milestone;
      changed++;
    }
    if (t.priority !== undefined) {
      ent.msdyn_priority = t.priority;
      changed++;
    }
    if (changed === 0)
      throw new Error(
        "tasks[" + i + "]: nothing to change - provide at least one field besides taskId.",
      );
    return ent;
  });
}

const updateSchema = z.object({
  taskId: z.string().describe("GUID of the task to update (msdyn_projecttaskid)."),
  subject: z.string().optional().describe("Rename the task."),
  description: z.string().optional().describe("Set the task note / description."),
  start: z.string().optional().describe("New ISO start date."),
  finish: z.string().optional().describe("New ISO finish date."),
  effortHours: z.number().optional().describe("New effort in hours."),
  progressPercent: z
    .number()
    .optional()
    .describe("Percent complete, 0-100 (server converts to the 0-1 the API expects)."),
  milestone: z.boolean().optional().describe("Set/clear the milestone flag."),
  priority: z.number().optional().describe("Priority (integer option-set value)."),
});

// Ergonomic update - the model sends a plain list keyed by taskId; the server
// builds the PSS update payload and converts percent -> 0-1.
export const updateTasksSimple: ToolDef = {
  name: "update_tasks",
  title: "Update Tasks in Plan",
  description:
    "Updates existing tasks from a SIMPLE list - you pass taskId plus only the fields to change (subject, description, start, finish, effortHours, progressPercent 0-100, milestone, priority); the server builds the Dataverse payload. Requires an open change session. NEVER change start/finish/effort/progress on summary (parent) tasks - fetch get_plan_tasks_and_buckets first and pass its summaryTaskIds so such writes are rejected (renames/descriptions on summary tasks are fine). Dependencies cannot be updated (delete and recreate). This IS where you set/clear the milestone flag (milestone is blocked on create but allowed on update - add_tasks returns milestoneTaskIds for exactly this follow-up). Get explicit user approval before queuing schedule changes. Saved only after 'Apply Changes to Plan'. For raw OData field control use the advanced update_tasks_batch.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    tasks: z
      .union([z.string(), z.array(updateSchema)])
      .describe("The task updates. A JSON array (or JSON string) of update objects."),
    summaryTaskIds: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Optional JSON array of summary-task GUIDs from get_plan_tasks_and_buckets. If provided, rolled-up-field writes (start/finish/effort/progress/duration) on those tasks are rejected.",
      ),
  },
  handler: async (input: {
    operationSetId: string;
    tasks: unknown;
    summaryTaskIds?: unknown;
  }) => {
    const BASE = getApiBase();

    const operationSetId = (input.operationSetId || "").trim();
    if (!operationSetId) throw new Error("operationSetId is required.");

    const tasks = asArray<SimpleTaskUpdate>(input.tasks, "tasks");
    const entities = buildUpdateEntities(tasks);

    // Defense in depth + summary-task protection (same checks as the raw tool).
    validateUpdateEntities(entities, input.summaryTaskIds);

    const response = await dvReq({
      url: BASE + "/msdyn_PssUpdateV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { EntityCollection: entities, OperationSetId: operationSetId },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      const msg = dvErrorMessage(response);
      if (response.status === 403)
        throw new Error("403 - missing license or privileges: " + msg);
      throw new Error("pss_update_batch failed (" + response.status + "): " + msg);
    }
    return {
      ok: true,
      queued: entities.length,
      response: body,
      note: "Queued. Saved only after 'Apply Changes to Plan'.",
    };
  },
};
