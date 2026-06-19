import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { addTasksSimple } from "../src/tools/addTasksSimple.js";

const ORG = "https://org12345.crm4.dynamics.com";
const PROJECT = "11111111-2222-3333-4444-555555555555";
const OPSET = "22222222-3333-4444-5555-666666666666";
const BUCKET = "33333333-4444-5555-6666-777777777777";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}

// Mock fetch: the task-existence probe returns `existingTasks`, PssCreateV2 succeeds.
function mockFetch(existingTasks: any[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("msdyn_PssCreateV2")) return new Response(JSON.stringify({}), { status: 200 });
    if (url.includes("msdyn_projecttasks")) return new Response(JSON.stringify({ value: existingTasks }), { status: 200 });
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  });
}

describe("add_tasks root-task auto-nesting warning", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetEnvCache();
  });

  it("warns when a parentless task is added to a NON-EMPTY plan", async () => {
    mockFetch([{ msdyn_projecttaskid: "99999999-0000-0000-0000-000000000001" }]); // plan already has tasks
    const res = await withBearer(() =>
      (addTasksSimple.handler as any)({
        operationSetId: OPSET,
        projectId: PROJECT,
        tasks: [{ ref: "root1", subject: "A new top-level task", bucketId: BUCKET }],
      }),
    );
    expect(res.ok).toBe(true);
    const warnings: string[] = res.warnings ?? [];
    expect(warnings.some((w) => /nest these top-level tasks/i.test(w))).toBe(true);
    expect(warnings.some((w) => /root1/.test(w))).toBe(true);
  });

  it("does NOT warn when the plan is still empty (first batch)", async () => {
    mockFetch([]); // empty plan
    const res = await withBearer(() =>
      (addTasksSimple.handler as any)({
        operationSetId: OPSET,
        projectId: PROJECT,
        tasks: [{ ref: "root1", subject: "First top-level task", bucketId: BUCKET }],
      }),
    );
    expect(res.ok).toBe(true);
    const warnings: string[] = res.warnings ?? [];
    expect(warnings.some((w) => /nest these top-level tasks/i.test(w))).toBe(false);
  });

  it("does NOT warn when every task has an explicit parent", async () => {
    mockFetch([{ msdyn_projecttaskid: "99999999-0000-0000-0000-000000000001" }]); // non-empty plan
    const res = await withBearer(() =>
      (addTasksSimple.handler as any)({
        operationSetId: OPSET,
        projectId: PROJECT,
        tasks: [
          { ref: "p", subject: "Parent", bucketId: BUCKET },
          { ref: "c", subject: "Child", bucketId: BUCKET, parent: "p" },
        ],
      }),
    );
    // 'p' is a root, but it is the parent of 'c' in this same batch — still a root
    // relative to the plan, so the warning SHOULD fire for 'p' only.
    const warnings: string[] = res.warnings ?? [];
    expect(warnings.some((w) => /\bp\b/.test(w))).toBe(true);
    expect(warnings.some((w) => /\bc\b/.test(w))).toBe(false);
  });
});
