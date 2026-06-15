import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Create Premium Plan - msdyn_CreateProjectV1 (runs immediately, creates default bucket)
export const createPlan: ToolDef = {
  name: "create_plan",
  title: "Create New Plan",
  description:
    "Creates a new Planner Premium plan (project) in the signed-in user's context via msdyn_CreateProjectV1. Runs immediately - no change session needed - and auto-creates the default bucket 'Bucket 1'. Returns the projectId needed by all other actions. Use FIRST when building a new plan, then add buckets, then start a change session for tasks.",
  inputSchema: {
    subject: z.string().describe("Plan name (visible in Planner)."),
    description: z.string().optional().describe("Optional plan description."),
    scheduledStart: z
      .string()
      .optional()
      .describe(
        "Optional ISO start date, e.g. 2026-07-01. Must be a working day in the project calendar.",
      ),
  },
  handler: async (input: {
    subject: string;
    description?: string;
    scheduledStart?: string;
  }) => {
    const BASE = getApiBase();

    const subject = (input.subject || "").trim();
    if (!subject) throw new Error("subject is required (plan name).");

    const project: Record<string, unknown> = {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_project",
      msdyn_subject: subject,
    };
    if (input.description) project.msdyn_description = input.description;
    if (input.scheduledStart) project.msdyn_scheduledstart = input.scheduledStart;

    const response = await dvReq({
      url: BASE + "/msdyn_CreateProjectV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { Project: project },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      const msg = dvErrorMessage(response);
      if (response.status === 403)
        throw new Error(
          "403 - Your account lacks a Planner/Project license or Dataverse privileges: " +
            msg,
        );
      throw new Error("create_project failed (" + response.status + "): " + msg);
    }
    return {
      ok: true,
      projectId: body.ProjectId,
      note: "Plan created with default bucket 'Bucket 1'. Runs in YOUR user context.",
    };
  },
};
