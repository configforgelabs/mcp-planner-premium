/**
 * Handler-level tests for get_critical_path.
 *
 * Uses vi.spyOn(globalThis, "fetch") to mock Dataverse responses, following
 * the listDependencies.test.ts and listMyTasks.test.ts patterns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { getCriticalPath } from "../src/tools/getCriticalPath.js";

const ORG = "https://org12345.crm4.dynamics.com";
const PROJECT = "11111111-2222-3333-4444-555555555555";
const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const T2 = "bbbbbbbb-0000-0000-0000-000000000002";
const T3 = "cccccccc-0000-0000-0000-000000000003";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("get_critical_path handler", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "global";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetEnvCache();
  });

  it("returns ok:true with a dependency-unavailable warning when dep entity 404s", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projecttaskdependencies")) {
        return jsonRes({ error: { message: "Resource not found for the segment." } }, 404);
      }
      // Task scan
      return jsonRes({
        value: [
          {
            msdyn_projecttaskid: T1,
            msdyn_subject: "Task A",
            msdyn_start: "2026-01-01T00:00:00Z",
            msdyn_finish: "2026-01-03T00:00:00Z",
            msdyn_progress: 0,
            msdyn_ismilestone: false,
            msdyn_effort: 16,
            _msdyn_parenttask_value: null,
          },
        ],
      });
    });

    const res = await withBearer(() =>
      (getCriticalPath.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    const hasDepWarn = res.warnings.some((w: string) =>
      /dependency links unavailable/i.test(w),
    );
    expect(hasDepWarn).toBe(true);
    // Path should still contain T1 (only leaf, at projectFinish)
    expect(res.criticalPath).toHaveLength(1);
    expect(res.criticalPath[0].taskId).toBe(T1.toLowerCase());
  });

  it("throws on a non-404 dep error (e.g. 403)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projecttaskdependencies")) {
        return jsonRes({ error: { message: "forbidden" } }, 403);
      }
      return jsonRes({
        value: [
          {
            msdyn_projecttaskid: T1,
            msdyn_subject: "A",
            msdyn_start: "2026-01-01T00:00:00Z",
            msdyn_finish: "2026-01-02T00:00:00Z",
            msdyn_progress: 0,
            msdyn_ismilestone: false,
            msdyn_effort: null,
            _msdyn_parenttask_value: null,
          },
        ],
      });
    });

    await expect(
      withBearer(() => (getCriticalPath.handler as any)({ projectId: PROJECT })),
    ).rejects.toThrow(/get_critical_path failed/);
  });

  it("happy path: returns criticalPath with correct ordering and projectFinish", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projecttaskdependencies")) {
        return jsonRes({
          value: [
            {
              _msdyn_predecessortask_value: T1,
              _msdyn_successortask_value: T2,
              msdyn_projecttaskdependencylinktype: 192350000, // FS global
              msdyn_projecttaskdependencylinklag: null,
            },
            {
              _msdyn_predecessortask_value: T2,
              _msdyn_successortask_value: T3,
              msdyn_projecttaskdependencylinktype: 192350000,
              msdyn_projecttaskdependencylinklag: null,
            },
          ],
        });
      }
      // Task scan
      return jsonRes({
        value: [
          {
            msdyn_projecttaskid: T1,
            msdyn_subject: "Design",
            msdyn_start: "2026-01-01T00:00:00Z",
            msdyn_finish: "2026-01-02T00:00:00Z",
            msdyn_progress: 0,
            msdyn_ismilestone: false,
            msdyn_effort: 8,
            _msdyn_parenttask_value: null,
          },
          {
            msdyn_projecttaskid: T2,
            msdyn_subject: "Build",
            msdyn_start: "2026-01-02T00:00:00Z",
            msdyn_finish: "2026-01-03T00:00:00Z",
            msdyn_progress: 0,
            msdyn_ismilestone: false,
            msdyn_effort: 8,
            _msdyn_parenttask_value: null,
          },
          {
            msdyn_projecttaskid: T3,
            msdyn_subject: "Test",
            msdyn_start: "2026-01-03T00:00:00Z",
            msdyn_finish: "2026-01-04T00:00:00Z",
            msdyn_progress: 0,
            msdyn_ismilestone: false,
            msdyn_effort: 8,
            _msdyn_parenttask_value: null,
          },
        ],
      });
    });

    const res = await withBearer(() =>
      (getCriticalPath.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    expect(res.projectFinish).toBe("2026-01-04T00:00:00Z");
    const pathIds = res.criticalPath.map((p: any) => p.taskId);
    expect(pathIds).toEqual([T1, T2, T3]);
    expect(res.criticalCount).toBe(3);
    expect(res.truncated).toBe(false);
  });

  it("sets truncated:true and adds a truncation warning when task pages are capped", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projecttaskdependencies")) {
        return jsonRes({ value: [] });
      }
      // First task page has nextLink (simulate truncation)
      if (!url.includes("nextLink=true")) {
        return jsonRes({
          value: [
            {
              msdyn_projecttaskid: T1,
              msdyn_subject: "A",
              msdyn_start: "2026-01-01T00:00:00Z",
              msdyn_finish: "2026-01-02T00:00:00Z",
              msdyn_progress: 0,
              msdyn_ismilestone: false,
              msdyn_effort: null,
              _msdyn_parenttask_value: null,
            },
          ],
          "@odata.nextLink": ORG + "/api/data/v9.2/msdyn_projecttasks?nextLink=true",
        });
      }
      // After 10 pages (maxPages default) the page loop stops. This is page 2+.
      callCount++;
      // Return a next link forever to force truncation after maxPages
      if (callCount < 15) {
        return jsonRes({
          value: [
            {
              msdyn_projecttaskid: `${String(callCount).padStart(8, "a")}-0000-0000-0000-000000000002`,
              msdyn_subject: `Task ${callCount}`,
              msdyn_start: "2026-01-01T00:00:00Z",
              msdyn_finish: "2026-01-02T00:00:00Z",
              msdyn_progress: 0,
              msdyn_ismilestone: false,
              msdyn_effort: null,
              _msdyn_parenttask_value: null,
            },
          ],
          "@odata.nextLink": ORG + "/api/data/v9.2/msdyn_projecttasks?nextLink=true",
        });
      }
      return jsonRes({ value: [] });
    });

    const res = await withBearer(() =>
      (getCriticalPath.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    const hasTruncWarn = res.warnings.some((w: string) =>
      /truncated/i.test(w),
    );
    expect(hasTruncWarn).toBe(true);
  });

  it("rejects an invalid projectId GUID", async () => {
    await expect(
      withBearer(() =>
        (getCriticalPath.handler as any)({ projectId: "not-a-guid" }),
      ),
    ).rejects.toThrow(/projectId must be a GUID/i);
  });
});
