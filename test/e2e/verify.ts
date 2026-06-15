/**
 * Independent verification via direct Dataverse OData GETs.
 * Uses the delegated bearer directly — bypasses the MCP server so a bug
 * there can't mask a failed write.
 */

import { getConfig } from "./config.js";
import { redact } from "./config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dvGet(path: string, bearer: string): Promise<any> {
  const cfg = getConfig();
  const base = cfg.DATAVERSE_ORG_URL + "/api/data/v9.2";
  const res = await fetch(base + path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    throw new Error(
      `Independent verification: 401 Unauthorized (token ${redact(bearer)} may be expired or wrong audience)`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Independent verification HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Count tasks in a plan directly from Dataverse (bypasses MCP). */
export async function verifyTaskCount(
  projectId: string,
  bearer: string,
): Promise<{ count: number; truncated: boolean }> {
  const data = await dvGet(
    `/msdyn_projecttasks?$filter=_msdyn_project_value eq ${projectId}&$count=true&$top=0`,
    bearer,
  );
  return { count: data["@odata.count"] ?? 0, truncated: false };
}

/** Check a specific task exists and has the expected field value. */
export async function verifyTaskField(
  taskId: string,
  field: string,
  bearer: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const data = await dvGet(
    `/msdyn_projecttasks(${taskId})?$select=${field}`,
    bearer,
  );
  return data[field];
}

/** Confirm a task no longer exists (returns true if deleted). */
export async function verifyTaskDeleted(taskId: string, bearer: string): Promise<boolean> {
  const base = getConfig().DATAVERSE_ORG_URL + "/api/data/v9.2";
  const res = await fetch(
    `${base}/msdyn_projecttasks(${taskId})?$select=msdyn_projecttaskid`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  return res.status === 404;
}
