import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// List recent plans for reporting ("show my plans"). Generalises find_plan_by_name
// (no name = most-recently-modified N).
export const listPlans: ToolDef = {
  name: "list_plans",
  title: "List Plans",
  description:
    "Lists Planner Premium plans for reporting - most-recently-modified first, with dates, % complete and effort. Optional name filter (substring). Use to show the user their plans or pick one to drill into; use find_plan_by_name when you need exact-match resolution of a single plan.",
  inputSchema: {
    nameContains: z
      .string()
      .optional()
      .describe("Optional case-insensitive substring to filter plan names."),
    top: z
      .number()
      .optional()
      .describe("Max plans to return (default 20, max 100)."),
  },
  handler: async (input: { nameContains?: string; top?: number }) => {
    const BASE = getApiBase();
    const top = Math.min(Math.max(input.top ?? 20, 1), 100);
    const name = (input.nameContains || "").trim();

    let url =
      BASE +
      "/msdyn_projects?$select=msdyn_projectid,msdyn_subject,msdyn_scheduledstart," +
      "msdyn_finish,msdyn_progress,msdyn_effort,msdyn_effortcompleted,modifiedon" +
      "&$orderby=modifiedon desc&$top=" +
      top;
    if (name) {
      const safe = name.replace(/'/g, "''");
      url += "&$filter=contains(msdyn_subject,'" + encodeURIComponent(safe) + "')";
    }

    const res = await dvReq({ url, method: "GET", headers: dvHeaders() }, { retry: true });
    if (res.status >= 400)
      throw new Error("list_plans failed (" + res.status + "): " + dvErrorMessage(res));

    const plans = (res.json?.value || []).map((p: any) => ({
      projectId: p.msdyn_projectid,
      name: p.msdyn_subject,
      start: p.msdyn_scheduledstart,
      finish: p.msdyn_finish,
      progressPercent:
        typeof p.msdyn_progress === "number" ? Math.round(p.msdyn_progress * 100) : null,
      effortHours: p.msdyn_effort ?? null,
      effortCompletedHours: p.msdyn_effortcompleted ?? null,
      modifiedOn: p.modifiedon,
    }));
    return { ok: true, count: plans.length, plans };
  },
};
