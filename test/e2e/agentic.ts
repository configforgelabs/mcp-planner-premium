/**
 * Agentic exploratory pass (optional — requires ANTHROPIC_API_KEY + E2E_AGENTIC=true).
 *
 * A real Claude model reads only the tool descriptions and a plain-English objective,
 * drives the MCP tools autonomously to build a small plan, and code verifies the result.
 *
 * Pass/fail oracle: CODE ASSERTIONS — never the model's own summary.
 * The model is used to test description usability, not to judge correctness.
 */

import Anthropic from "@anthropic-ai/sdk";
import { mcpCall, mcpToolNames } from "./mcpClient.js";
import { stepLog } from "./steps.js";
import type { StepContext } from "./steps.js";
import { getConfig } from "./config.js";
import { verifyTaskCount } from "./verify.js";

const OBJECTIVE = `
You are an AI assistant using the Planner Premium tools.
Create a small project plan called "ZZ-MCP-AGENTIC-TEST" with one bucket called "Backlog"
and add exactly 2 tasks: "Task Alpha" and "Task Beta".
Do NOT use msdyn_* fields or @odata.bind — use the ergonomic add_tasks tool with refs.
Return ONLY a JSON object with keys: projectId (string), taskCount (number).
Do not explain, do not summarize — only the JSON.
`.trim();

export interface AgenticResult {
  skipped: boolean;
  reason?: string;
  modelUsed?: string;
  projectId?: string;
  verifiedTaskCount?: number;
  expectedTaskCount?: number;
  descriptionUsabilityPassed?: boolean;
  agentRaw?: string;
  error?: string;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export async function runAgentic(ctx: StepContext): Promise<AgenticResult> {
  const cfg = getConfig();

  if (!cfg.E2E_AGENTIC) {
    return { skipped: true, reason: "E2E_AGENTIC=false (not set)" };
  }
  if (!cfg.ANTHROPIC_API_KEY) {
    return {
      skipped: true,
      reason: "ANTHROPIC_API_KEY not set — required for the agentic layer",
    };
  }

  const t0 = Date.now();
  const anthropic = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const MODEL = "claude-opus-4-8";

  // Fetch real tool schemas from the server (what the client actually sees).
  const toolNamesWanted = [
    "create_plan", "add_bucket", "start_change_session", "add_tasks", "apply_changes",
    "check_change_session_status",
  ];

  // Build the raw tools/list call to get schemas (not just names).
  const rawTools = await fetchToolSchemas(ctx, toolNamesWanted);
  if (rawTools.length === 0) {
    return { skipped: true, reason: "Could not fetch tool schemas from server" };
  }

  // Convert to Anthropic tool format (input_schema already present from MCP).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anthropicTools: Anthropic.Tool[] = rawTools.map((t: ToolDef) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: OBJECTIVE },
  ];

  let finalText = "";
  let iterCount = 0;
  const MAX_ITERS = 15;

  // Agentic tool-use loop. The model drives; we execute.
  while (iterCount < MAX_ITERS) {
    iterCount++;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: anthropicTools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      break;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) break;

    // Execute each tool call on the real MCP server.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const { isError, content } = await mcpCall(
        ctx.mcpUrl,
        tu.name,
        tu.input as Record<string, unknown>,
        ctx.bearer,
      );
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(isError ? { error: content } : content),
      });
    }
    messages.push({ role: "user", content: results });
  }

  const latencyMs = Date.now() - t0;

  // Parse the model's final JSON output.
  let agentProjectId: string | undefined;
  let agentTaskCount: number | undefined;
  try {
    const jsonMatch = finalText.match(/\{[^}]+\}/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      agentProjectId = parsed.projectId;
      agentTaskCount = parsed.taskCount;
    }
  } catch { /* ok */ }

  // CODE verifies: never trust the model's own count.
  let verifiedCount: number | undefined;
  let descriptionUsabilityPassed = false;
  if (agentProjectId) {
    try {
      const { count } = await verifyTaskCount(agentProjectId, ctx.bearer);
      verifiedCount = count;
      // Pass if the model correctly created exactly 2 tasks.
      descriptionUsabilityPassed = count === 2;
    } catch { /* plan may not have been created */ }
  }

  stepLog.push({
    name: "agentic — description usability: model built correct plan from descriptions alone",
    status: descriptionUsabilityPassed ? "pass" : "fail",
    latencyMs,
    tool: MODEL,
    evidence: verifiedCount !== undefined
      ? `Verified ${verifiedCount} tasks via direct OData; expected 2; model reported ${agentTaskCount}`
      : "Could not verify — no projectId returned",
    error: !descriptionUsabilityPassed
      ? `Model produced ${verifiedCount ?? "?"} tasks (expected 2) or failed to create plan`
      : undefined,
  });

  return {
    skipped: false,
    modelUsed: MODEL,
    projectId: agentProjectId,
    verifiedTaskCount: verifiedCount,
    expectedTaskCount: 2,
    descriptionUsabilityPassed,
    agentRaw: finalText.slice(0, 500),
  };
}

async function fetchToolSchemas(
  ctx: StepContext,
  wantedNames: string[],
): Promise<ToolDef[]> {
  const id = 9900;
  const res = await fetch(ctx.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${ctx.bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  const dataLine = text.split(/\r?\n/).filter((l) => l.startsWith("data: ")).pop();
  if (!dataLine) return [];
  const parsed = JSON.parse(dataLine.slice(6));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: ToolDef[] = parsed.result?.tools ?? [];
  return allTools.filter((t) => wantedNames.includes(t.name));
}

// Keep mcpToolNames import happy (re-export as side-effect).
void mcpToolNames;
