import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Find Plan - narrow read: resolve plan(s) by name (fixed $select, no free-text OData)
export const findPlan: ToolDef = {
  name: "find_plan_by_name",
  title: "Find Plan by Name",
  description:
    "Finds Planner Premium plan(s) by full or partial name (top 10, newest first) and returns their projectId, dates and progress. Use BEFORE any change to an existing plan to resolve the projectId. The returned 'progress' is a 0-1 fraction (0.5 = 50%), not a percentage. If multiple plans match, ask the user which one is meant.",
  inputSchema: {
    name: z.string().describe("Full or partial plan name to search for."),
  },
  handler: async (input: { name: string }) => {
    const BASE = getApiBase();

    const name = (input.name || "").trim();
    if (!name) throw new Error("name is required (full or partial plan name).");
    // Escape single quotes for OData literal
    const safe = name.replace(/'/g, "''");

    const url =
      BASE +
      "/msdyn_projects?$select=msdyn_projectid,msdyn_subject,msdyn_description," +
      "msdyn_scheduledstart,msdyn_finish,msdyn_progress,modifiedon" +
      "&$filter=contains(msdyn_subject,'" +
      encodeURIComponent(safe) +
      "')" +
      "&$orderby=modifiedon desc&$top=10";

    const response = await dvReq(
      {
        url: url,
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    const body = response.json || {};
    if (response.status >= 400) {
      throw new Error(
        "find_plan failed (" + response.status + "): " + dvErrorMessage(response),
      );
    }
    const target = name.toLowerCase(); // name is already trimmed above
    const plans = (body.value || []).map((p: any) => ({
      projectId: p.msdyn_projectid,
      name: p.msdyn_subject,
      start: p.msdyn_scheduledstart,
      finish: p.msdyn_finish,
      progress: p.msdyn_progress,
      modifiedOn: p.modifiedon,
      exactMatch:
        typeof p.msdyn_subject === "string" &&
        p.msdyn_subject.trim().toLowerCase() === target,
    }));
    // Exact matches first, then most-recently-modified.
    plans.sort((a: any, b: any) => {
      if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
      return String(b.modifiedOn || "").localeCompare(String(a.modifiedOn || ""));
    });
    const exactCount = plans.filter((p: any) => p.exactMatch).length;
    let hint: string;
    if (plans.length === 0) hint = "No plan matched. Ask the user for the exact plan name.";
    else if (exactCount === 1) hint = "Exact name match found - prefer this one.";
    else if (exactCount > 1)
      hint = "Multiple plans share this exact name - ask the user, never pick silently.";
    else if (plans.length > 1)
      hint = "Multiple matches - ask the user which plan is meant before writing.";
    else hint = "Unique match.";
    return {
      ok: true,
      count: plans.length,
      exactMatchCount: exactCount,
      plans: plans,
      hint: hint,
    };
  },
};
