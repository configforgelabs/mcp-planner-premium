import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Create Bucket - plain Dataverse insert (officially supported for msdyn_projectbucket)
export const addBucket: ToolDef = {
  name: "add_bucket",
  title: "Add Bucket to Plan",
  description:
    "Adds a bucket (column/grouping) to an existing plan via a direct Dataverse insert into msdyn_projectbuckets (officially supported - buckets are not engine-managed). Returns the bucketId. Runs immediately - no change session needed. Buckets MUST exist before tasks reference them in add_tasks / add_tasks_batch (add_tasks can reference a bucket by this name or by bucketId).",
  inputSchema: {
    name: z.string().describe("Bucket name."),
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { name: string; projectId: string }) => {
    const BASE = getApiBase();

    const name = (input.name || "").trim();
    if (!name) throw new Error("name is required (bucket name).");
    const projectId = assertGuid(input.projectId, "projectId");

    const response = await dvReq({
      url: BASE + "/msdyn_projectbuckets",
      method: "POST",
      headers: dvHeaders({ json: true, extra: { Prefer: "return=representation" } }),
      body: {
        msdyn_name: name,
        "msdyn_project@odata.bind": "/msdyn_projects(" + projectId + ")",
      },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      throw new Error(
        "create_bucket failed (" + response.status + "): " + dvErrorMessage(response),
      );
    }
    return { ok: true, bucketId: body.msdyn_projectbucketid, name: body.msdyn_name };
  },
};
