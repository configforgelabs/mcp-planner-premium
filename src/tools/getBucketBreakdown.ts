import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import { pageAll, readHeaders } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

// Per-bucket task count + average progress. Primary path uses OData $apply
// group-by aggregation; falls back to a client-side group if $apply is rejected
// by the environment ($orderby is never used - unsupported with $apply).
export const getBucketBreakdown: ToolDef = {
  name: "get_bucket_breakdown",
  title: "Get Bucket Breakdown",
  description:
    "Returns per-bucket task count and average % complete (avgProgressPercent, 0-100) for one plan - a quick status-by-bucket report, not an authoritative count. Uses server-side aggregation where supported, otherwise a client-side pass that is page-capped; if truncated=true the breakdown may be incomplete on a very large plan.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { projectId: string }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");

    // Bucket id -> name map.
    const bucketRes = await dvReq(
      {
        url:
          BASE +
          "/msdyn_projectbuckets?$select=msdyn_projectbucketid,msdyn_name&$filter=_msdyn_project_value eq " +
          projectId +
          "&$top=200",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (bucketRes.status >= 400)
      throw new Error(
        "get_bucket_breakdown (buckets) failed (" + bucketRes.status + "): " + dvErrorMessage(bucketRes),
      );
    const nameById = new Map<string, string>();
    for (const b of bucketRes.json?.value || [])
      nameById.set(String(b.msdyn_projectbucketid).toLowerCase(), b.msdyn_name);

    let method = "aggregate";
    let truncated = false;
    const counts = new Map<string, { taskCount: number; progressSum: number; progressN: number }>();

    // Primary: $apply group-by aggregation.
    const applyUrl =
      BASE +
      "/msdyn_projecttasks?$apply=filter(_msdyn_project_value eq " +
      projectId +
      ")/groupby((_msdyn_projectbucket_value),aggregate($count as taskCount,msdyn_progress with average as avgProgress))";
    const aggRes = await dvReq({ url: applyUrl, method: "GET", headers: dvHeaders() }, { retry: true });

    if (aggRes.status < 400) {
      for (const row of aggRes.json?.value || []) {
        const id = String(row._msdyn_projectbucket_value || "").toLowerCase();
        counts.set(id, {
          taskCount: Number(row.taskCount) || 0,
          progressSum: (Number(row.avgProgress) || 0) * (Number(row.taskCount) || 0),
          progressN: Number(row.taskCount) || 0,
        });
      }
    } else {
      // Fallback: client-side group over a task scan.
      method = "client";
      const paged = await pageAll(
        BASE +
          "/msdyn_projecttasks?$select=_msdyn_projectbucket_value,msdyn_progress&$filter=_msdyn_project_value eq " +
          projectId,
        readHeaders(),
      );
      truncated = paged.truncated;
      for (const t of paged.rows) {
        const id = String(t._msdyn_projectbucket_value || "").toLowerCase();
        const cur = counts.get(id) || { taskCount: 0, progressSum: 0, progressN: 0 };
        cur.taskCount++;
        if (typeof t.msdyn_progress === "number") {
          cur.progressSum += t.msdyn_progress;
          cur.progressN++;
        }
        counts.set(id, cur);
      }
    }

    const buckets = [...counts.entries()].map(([id, c]) => ({
      bucketId: id,
      name: nameById.get(id) ?? null,
      taskCount: c.taskCount,
      avgProgressPercent: c.progressN ? Math.round((c.progressSum / c.progressN) * 100) : null,
    }));
    // Sort client-side (no $orderby with $apply).
    buckets.sort((a, b) => (b.taskCount ?? 0) - (a.taskCount ?? 0));

    return { ok: true, projectId, method, truncated, bucketCount: buckets.length, buckets };
  },
};
