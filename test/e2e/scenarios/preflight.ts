/**
 * Phase 0 — Preflight.
 * Validates: token works, server reachable, all 23 tools advertised, whoami resolves.
 * Safe on ANY environment — read-only.
 */

import { mcpInitialize, mcpToolNames } from "../mcpClient.js";
import { step, assert, stepLog } from "../steps.js";
import type { StepContext } from "../steps.js";

const EXPECTED_TOOLS = [
  "create_plan", "add_bucket", "start_change_session",
  "add_tasks", "add_tasks_batch", "update_tasks", "update_tasks_batch",
  "delete_tasks_batch", "apply_changes", "check_change_session_status",
  "cancel_change_session", "find_plan_by_name", "find_team_member",
  "get_plan_tasks_and_buckets", "whoami",
  "list_plans", "get_plan_summary", "get_task", "list_plan_tasks",
  "get_bucket_breakdown", "list_dependencies", "list_team_members",
  "describe_option_set",
];

export interface PreflightResult {
  userId: string;
  serverName: string;
  toolsAdvertised: string[];
}

export async function runPreflight(ctx: StepContext): Promise<PreflightResult> {
  await mcpInitialize(ctx.mcpUrl, ctx.bearer);

  // 1. Tools list
  const t0 = Date.now();
  const toolNames = await mcpToolNames(ctx.mcpUrl, ctx.bearer);
  const missing = EXPECTED_TOOLS.filter((n) => !toolNames.includes(n));
  stepLog.push({
    name: "tools/list — all 23 tools advertised",
    status: missing.length === 0 ? "pass" : "fail",
    latencyMs: Date.now() - t0,
    evidence: missing.length === 0
      ? `${toolNames.length} tools advertised`
      : `Missing: ${missing.join(", ")}`,
    error: missing.length > 0 ? `Missing tools: ${missing.join(", ")}` : undefined,
  });
  assert(missing.length === 0, `Server missing tools: ${missing.join(", ")}`);

  // 2. whoami — proves the delegated token reaches Dataverse
  const whoami = await step(
    "whoami — delegated token valid against Dataverse",
    "whoami",
    {},
    (r) => {
      assert(r?.ok === true, "whoami returned ok:false");
      assert(typeof r?.userId === "string" && r.userId.length > 0, "userId missing");
      return r;
    },
    ctx,
  );

  return {
    userId: whoami!.userId,
    serverName: "mcp-planner-premium",
    toolsAdvertised: toolNames,
  };
}
