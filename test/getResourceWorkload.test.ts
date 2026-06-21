/**
 * Handler-level tests for get_resource_workload.
 *
 * Uses vi.spyOn(globalThis, "fetch") to mock Dataverse responses, following
 * the listDependencies.test.ts and listMyTasks.test.ts patterns.
 *
 * After each test: resetEnvCache() + resetCapabilities() so cached state
 * never leaks between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { getResourceWorkload } from "../src/tools/getResourceWorkload.js";
import {
  getExtendedTaskFieldsCapability,
  resetCapabilities,
} from "../src/tools/capabilities.js";

const ORG = "https://org12345.crm4.dynamics.com";
const PROJECT = "11111111-2222-3333-4444-555555555555";
const T1 = "tttttttt-0000-0000-0000-000000000001";
const T2 = "tttttttt-0000-0000-0000-000000000002";
const M1 = "m1m1m1m1-0000-0000-0000-000000000001";
const M2 = "m2m2m2m2-0000-0000-0000-000000000002";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("get_resource_workload handler", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "global";
    delete process.env.TENANT_ID;
    resetEnvCache();
    resetCapabilities();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetEnvCache();
    resetCapabilities();
  });

  it("returns all tasks under (Unassigned) and a warning when assignments 404", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_resourceassignments")) {
        return jsonRes({ error: { message: "not found" } }, 404);
      }
      // Task scan (extended fields absent → return 400 on first probe attempt)
      if (url.includes("msdyn_remainingeffort")) {
        return jsonRes(
          { error: { message: "Could not find a property named 'msdyn_remainingeffort'." } },
          400,
        );
      }
      // Core task scan
      return jsonRes({
        value: [
          {
            msdyn_projecttaskid: T1,
            msdyn_subject: "T1",
            msdyn_finish: "2026-07-01T00:00:00Z",
            msdyn_progress: 0,
            msdyn_effort: 8,
            _msdyn_parenttask_value: null,
          },
        ],
      });
    });

    const res = await withBearer(() =>
      (getResourceWorkload.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    const hasAsgWarn = res.warnings.some((w: string) =>
      /resource assignments unavailable/i.test(w),
    );
    expect(hasAsgWarn).toBe(true);
    // All tasks in (Unassigned)
    const unassigned = res.members.find((m: any) => m.teamMemberId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned.assignedTaskCount).toBe(1);
  });

  it("capability absent: core select on retry, hasRemainingEffort=false, cache set to absent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_resourceassignments")) {
        return jsonRes({
          value: [
            {
              _msdyn_taskid_value: T1,
              _msdyn_projectteamid_value: M1,
              msdyn_projectteamid: { msdyn_name: "Alice" },
            },
          ],
        });
      }
      // First probe with extended fields → 400 property not found
      if (url.includes("msdyn_remainingeffort")) {
        return jsonRes(
          { error: { message: "Could not find a property named 'msdyn_remainingeffort'." } },
          400,
        );
      }
      // Core task scan
      return jsonRes({
        value: [
          {
            msdyn_projecttaskid: T1,
            msdyn_subject: "Task A",
            msdyn_finish: "2026-07-01T00:00:00Z",
            msdyn_progress: 0,
            msdyn_effort: 8,
            _msdyn_parenttask_value: null,
          },
        ],
      });
    });

    const res = await withBearer(() =>
      (getResourceWorkload.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    expect(res.hasRemainingEffort).toBe(false);
    for (const m of res.members) {
      expect(m.remainingEffortHours).toBeNull();
    }
    // Capability must be recorded as absent
    expect(getExtendedTaskFieldsCapability()).toBe("absent");
  });

  it("happy path: assignments expand member names; per-member counts correct", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_resourceassignments")) {
        return jsonRes({
          value: [
            {
              _msdyn_taskid_value: T1,
              _msdyn_projectteamid_value: M1,
              msdyn_projectteamid: { msdyn_name: "Alice" },
            },
            {
              _msdyn_taskid_value: T2,
              _msdyn_projectteamid_value: M2,
              msdyn_projectteamid: { msdyn_name: "Bob" },
            },
          ],
        });
      }
      // Extended fields probe succeeds
      return jsonRes({
        value: [
          {
            msdyn_projecttaskid: T1,
            msdyn_subject: "Task A",
            msdyn_finish: "2026-07-01T00:00:00Z",
            msdyn_progress: 0,
            msdyn_effort: 8,
            msdyn_remainingeffort: 4,
            _msdyn_parenttask_value: null,
          },
          {
            msdyn_projecttaskid: T2,
            msdyn_subject: "Task B",
            msdyn_finish: "2026-07-01T00:00:00Z",
            msdyn_progress: 0,
            msdyn_effort: 16,
            msdyn_remainingeffort: 8,
            _msdyn_parenttask_value: null,
          },
        ],
      });
    });

    const res = await withBearer(() =>
      (getResourceWorkload.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    expect(res.hasRemainingEffort).toBe(true);
    const alice = res.members.find((m: any) => m.name === "Alice");
    const bob = res.members.find((m: any) => m.name === "Bob");
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice.assignedTaskCount).toBe(1);
    expect(alice.totalEffortHours).toBe(8);
    expect(alice.remainingEffortHours).toBe(4);
    expect(bob.assignedTaskCount).toBe(1);
    expect(bob.totalEffortHours).toBe(16);
    expect(bob.remainingEffortHours).toBe(8);
    // memberCount should include both
    expect(res.memberCount).toBeGreaterThanOrEqual(2);
  });

  it("rejects an invalid projectId GUID", async () => {
    await expect(
      withBearer(() =>
        (getResourceWorkload.handler as any)({ projectId: "not-a-guid" }),
      ),
    ).rejects.toThrow(/projectId must be a GUID/i);
  });
});
