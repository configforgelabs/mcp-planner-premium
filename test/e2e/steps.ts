/**
 * Step execution engine.
 * Each step records its outcome; the runner/report reads the log.
 * `assert` throws on failure — the runner catches and marks the step failed.
 */

import { mcpCall } from "./mcpClient.js";
import { redact } from "./config.js";

export type StepStatus = "pass" | "fail" | "skip";

export interface StepResult {
  name: string;
  status: StepStatus;
  latencyMs: number;
  tool?: string;
  /** Sanitised (no bearer) summary of args sent. */
  argsSummary?: string;
  /** Sanitised key fields from the response. */
  evidence?: string;
  error?: string;
  skipped?: string;
}

export const stepLog: StepResult[] = [];

export function clearLog(): void {
  stepLog.length = 0;
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assertField(obj: any, field: string, label?: string): any {
  const val = obj?.[field];
  assert(val !== undefined && val !== null, `${label ?? field} must be present in response`);
  return val;
}

export interface StepContext {
  mcpUrl: string;
  bearer: string;
}

export interface StepOptions {
  skip?: string; // reason; step is recorded as skipped
  mutates?: boolean; // hint for the runner (no effect on execution)
}

export async function step<T>(
  name: string,
  tool: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check: (result: any) => T,
  ctx: StepContext,
  opts: StepOptions = {},
): Promise<T | undefined> {
  if (opts.skip) {
    stepLog.push({ name, status: "skip", latencyMs: 0, tool, skipped: opts.skip });
    return undefined;
  }

  const t0 = Date.now();
  const argsSummary = safeArgSummary(args);

  try {
    const { isError, content } = await mcpCall(ctx.mcpUrl, tool, args, ctx.bearer);

    if (isError) {
      throw new Error(`Tool returned isError=true: ${JSON.stringify(content).slice(0, 300)}`);
    }

    const value = check(content);
    const latencyMs = Date.now() - t0;
    stepLog.push({
      name,
      status: "pass",
      latencyMs,
      tool,
      argsSummary,
      evidence: safeEvidence(content),
    });
    return value;
  } catch (e: unknown) {
    const latencyMs = Date.now() - t0;
    stepLog.push({
      name,
      status: "fail",
      latencyMs,
      tool,
      argsSummary,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    });
    throw e; // bubble up so the phase can catch and abort cleanly
  }
}

/**
 * Negative step: expects the tool to return isError=true with a message
 * matching `expectedFragment`. Records as FAIL if the call unexpectedly succeeds.
 */
export async function guardStep(
  name: string,
  tool: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  expectedFragment: string,
  ctx: StepContext,
): Promise<void> {
  const t0 = Date.now();
  const argsSummary = safeArgSummary(args);
  try {
    const { isError, content } = await mcpCall(ctx.mcpUrl, tool, args, ctx.bearer);
    const latencyMs = Date.now() - t0;
    if (!isError) {
      stepLog.push({
        name,
        status: "fail",
        latencyMs,
        tool,
        argsSummary,
        error: `Expected rejection (isError=true) but call SUCCEEDED. Response: ${JSON.stringify(content).slice(0, 200)}`,
      });
      return;
    }
    const msg = JSON.stringify(content).toLowerCase();
    if (!msg.includes(expectedFragment.toLowerCase())) {
      stepLog.push({
        name,
        status: "fail",
        latencyMs,
        tool,
        argsSummary,
        error: `Rejection OK but wrong message — expected "${expectedFragment}" in: ${JSON.stringify(content).slice(0, 200)}`,
      });
      return;
    }
    stepLog.push({
      name,
      status: "pass",
      latencyMs,
      tool,
      argsSummary,
      evidence: `Correctly rejected (isError=true); message contains "${expectedFragment}"`,
    });
  } catch (e: unknown) {
    // If the tool threw (not isError but HTTP error), that is also an error.
    const latencyMs = Date.now() - t0;
    stepLog.push({
      name,
      status: "fail",
      latencyMs,
      tool,
      argsSummary,
      error: `Unexpected exception: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeArgSummary(args: Record<string, any>): string {
  // Shallow copy; redact anything that looks like a token.
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 40 && k !== "name" && k !== "subject") {
      safe[k] = `${v.slice(0, 12)}…`;
    } else if (typeof v === "string" && (k.toLowerCase().includes("token") || k.toLowerCase().includes("bearer"))) {
      safe[k] = redact(v);
    } else {
      safe[k] = v;
    }
  }
  return JSON.stringify(safe).slice(0, 200);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeEvidence(content: any): string {
  if (content === null || content === undefined) return "";
  const s = typeof content === "string" ? content : JSON.stringify(content);
  // Never include anything that could carry a token.
  return s.replace(/(Bearer\s+\S+)/gi, "[REDACTED]").slice(0, 300);
}
