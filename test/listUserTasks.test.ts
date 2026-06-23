import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { listUserTasks } from "../src/tools/listUserTasks.js";

const ORG = "https://org12345.crm4.dynamics.com";
const RES = "00000000-0000-0000-0000-0000000000bb";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Chain for a GIVEN bookable resource id (no WhoAmI / no bookableresource lookup).
function mockChain() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("/msdyn_projectteams"))
      return jsonRes({ value: [{ msdyn_projectteamid: "team1", _msdyn_project_value: "proj1" }] });
    if (url.includes("/msdyn_resourceassignments"))
      return jsonRes({ value: [{ _msdyn_taskid_value: "taskOverdue" }, { _msdyn_taskid_value: "taskFuture" }] });
    if (url.includes("/msdyn_projecttasks")) {
      if (url.includes("_msdyn_parenttask_value eq")) return jsonRes({ value: [] });
      return jsonRes({
        value: [
          { msdyn_projecttaskid: "taskOverdue", msdyn_subject: "Past task", msdyn_finish: "2020-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", msdyn_project: { msdyn_subject: "Plan A" } },
          { msdyn_projecttaskid: "taskFuture", msdyn_subject: "Future task", msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", msdyn_project: { msdyn_subject: "Plan A" } },
        ],
      });
    }
    return jsonRes({ value: [] });
  });
}

describe("list_user_tasks", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("defaults to 'active' → returns all incomplete tasks for the resource", async () => {
    mockChain();
    const res: any = await withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES }));
    expect(res.ok).toBe(true);
    expect(res.bookableResourceId).toBe(RES);
    expect(res.filter).toBe("active");
    expect(res.count).toBe(2);
  });

  it("filter=overdue → only the past-due task", async () => {
    mockChain();
    const res: any = await withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES, filter: "overdue" }));
    expect(res.count).toBe(1);
    expect(res.tasks[0].subject).toBe("Past task");
    expect(res.tasks[0].overdue).toBe(true);
    expect(res.tasks[0].planName).toBe("Plan A");
  });

  it("rejects a non-GUID bookableResourceId", async () => {
    await expect(
      withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: "not-a-guid" })),
    ).rejects.toThrow(/bookableResourceId must be a GUID/);
  });

  it("rejects a non-GUID projectId", async () => {
    await expect(
      withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES, projectId: "nope" })),
    ).rejects.toThrow(/projectId must be a GUID/);
  });

  it("count 0 with a note when the resource is on no project team", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams")) return jsonRes({ value: [] });
      return jsonRes({ value: [] });
    });
    const res: any = await withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES }));
    expect(res.count).toBe(0);
    expect(res.note).toMatch(/not on any project team/i);
  });
});
