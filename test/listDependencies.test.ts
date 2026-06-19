import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { listDependencies } from "../src/tools/listDependencies.js";

const ORG = "https://org12345.crm4.dynamics.com";
const PROJECT = "11111111-2222-3333-4444-555555555555";

// Run a tool handler inside a request context with a dummy bearer.
function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}

describe("list_dependencies graceful degrade", () => {
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

  it("returns ok with an empty list and a warning when the entity 404s", async () => {
    // Some environments do not expose msdyn_projecttaskdependency - the segment
    // 404s. The tool must degrade, not throw.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Resource not found for the segment 'msdyn_projecttaskdependency'." },
        }),
        { status: 404 },
      ),
    );

    const res = await withBearer(() =>
      (listDependencies.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    expect(res.count).toBe(0);
    expect(res.dependencies).toEqual([]);
    expect(res.warnings).toContain("Dependency links unavailable on this environment.");
  });

  it("queries the plural entity set and returns enriched dependencies", async () => {
    // Regression guard: the dependency entity SET name is the pluralised
    // 'msdyn_projecttaskdependencies'. The singular form 404s on the live tenant,
    // which silently returned count 0. Lock in the correct set name + success path.
    const PRED = "aaaaaaaa-0000-0000-0000-000000000001";
    const SUCC = "bbbbbbbb-0000-0000-0000-000000000002";
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/msdyn_projecttaskdependencies")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                _msdyn_predecessortask_value: PRED,
                _msdyn_successortask_value: SUCC,
                msdyn_projecttaskdependencylinktype: 192350000,
                msdyn_linklagduration: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      // task-subject enrichment scan
      return new Response(
        JSON.stringify({
          value: [
            { msdyn_projecttaskid: PRED, msdyn_subject: "Design" },
            { msdyn_projecttaskid: SUCC, msdyn_subject: "Build" },
          ],
        }),
        { status: 200 },
      );
    });

    const res = await withBearer(() =>
      (listDependencies.handler as any)({ projectId: PROJECT }),
    );

    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.dependencies[0]).toMatchObject({
      predecessorSubject: "Design",
      successorSubject: "Build",
      type: "FS",
    });
    // The dependency query must hit the PLURAL set, never the singular 404 path.
    expect(urls.some((u) => u.includes("/msdyn_projecttaskdependencies?"))).toBe(true);
    expect(urls.some((u) => /\/msdyn_projecttaskdependency\?/.test(u))).toBe(false);
  });

  it("still throws on a non-404 error (e.g. 403)", async () => {
    // 403 is not retryable (only 429/5xx retry), so this returns immediately.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 }),
    );

    await expect(
      withBearer(() => (listDependencies.handler as any)({ projectId: PROJECT })),
    ).rejects.toThrow(/list_dependencies failed/);
  });
});
