import { describe, it, expect } from "vitest";
import { renderReport } from "./e2e/report.js";
import type { RunSummary } from "./e2e/report.js";

const BASE: RunSummary = {
  runAt: "2026-06-15T12:00:00.000Z",
  orgUrl: "https://contoso.crm.dynamics.com",
  serverUrl: "http://localhost:3000/mcp",
  serverVersion: "1.0.0",
  protocol: "2025-03-26",
  toolsAdvertised: 23,
  userId: "user-123",
  writeMode: false,
  durationMs: 4200,
  steps: [],
};

describe("renderReport", () => {
  it("renders a header with the run timestamp and org", () => {
    const md = renderReport({ ...BASE, steps: [] });
    expect(md).toContain("MCP Planner Premium");
    expect(md).toContain("2026-06-15T12:00:00.000Z");
    expect(md).toContain("contoso.crm.dynamics.com");
  });

  it("reports ALL PASS when no steps failed", () => {
    const md = renderReport({
      ...BASE,
      steps: [{ name: "whoami", status: "pass", latencyMs: 100, tool: "whoami", evidence: "ok" }],
    });
    expect(md).toContain("ALL PASS");
    expect(md).not.toContain("❌");
  });

  it("reports failures with ❌ and shows error detail section", () => {
    const md = renderReport({
      ...BASE,
      steps: [{ name: "create_plan fails", status: "fail", latencyMs: 200, tool: "create_plan", error: "403 forbidden" }],
    });
    expect(md).toContain("❌");
    expect(md).toContain("403 forbidden");
    expect(md).toContain("Failure Detail");
  });

  it("shows agentic skip note when no agentic result", () => {
    const md = renderReport({ ...BASE, steps: [], agenticResult: { skipped: true, reason: "no key" } });
    expect(md).toContain("Skipped");
    expect(md).toContain("no key");
  });

  it("shows agentic pass when description usability passed", () => {
    const md = renderReport({
      ...BASE,
      steps: [],
      agenticResult: {
        skipped: false,
        modelUsed: "claude-opus-4-8",
        verifiedTaskCount: 2,
        expectedTaskCount: 2,
        descriptionUsabilityPassed: true,
      },
    });
    expect(md).toContain("claude-opus-4-8");
    expect(md).toContain("PASS");
  });

  it("never contains a bearer token string in the output", () => {
    const md = renderReport({
      ...BASE,
      steps: [
        {
          name: "step with token in args",
          status: "pass",
          latencyMs: 10,
          argsSummary: '{"operationSetId":"abc123"}',
          evidence: "Bearer [REDACTED]",
        },
      ],
    });
    // The test fixture already redacts — ensure no raw "sk-ant" or "Bearer e" pattern slips through.
    expect(md).not.toMatch(/Bearer\s+[A-Za-z0-9]{20}/);
  });

  it("shows residue note from manifest", () => {
    const md = renderReport({
      ...BASE,
      steps: [],
      manifest: { planName: "ZZ-MCP-E2E-test", leftoverNotes: ["Remove plan ZZ-MCP-E2E-test in Planner UI"] },
    });
    expect(md).toContain("Cleanup");
    expect(md).toContain("ZZ-MCP-E2E-test");
  });
});
