import type { ZodRawShape } from "zod";

/**
 * A tool definition. `name` is the MCP tool id (snake_case); `title` is the
 * human label (the original Langdock action name); `description` carries the
 * guardrail prose the model reads; `inputSchema` is a Zod raw shape that the
 * MCP SDK turns into the tool's JSON Schema.
 *
 * Handlers return any JSON-serialisable value; the registrar wraps it into MCP
 * text content. Throwing an Error surfaces its message to the model as a tool
 * error, matching how the original action code used `throw new Error(...)`.
 */
export interface ToolDef<TArgs = any> {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: TArgs) => Promise<unknown> | unknown;
}
