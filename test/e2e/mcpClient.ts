/**
 * Thin MCP Streamable-HTTP client.
 * Sends `tools/call` JSON-RPC requests and parses the SSE response stream.
 * Tests against the real protocol (same path Langdock uses), not internal handlers.
 */

import { getConfig } from "./config.js";

export interface McpCallResult {
  isError: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
}

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

export function isGuid(s: string): boolean {
  return GUID_RE.test(s);
}

let _requestId = 0;

async function sseToData(res: Response): Promise<string> {
  const text = await res.text();
  // SSE: extract `data: ...` lines
  const lines = text.split(/\r?\n/);
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data: ")) dataParts.push(line.slice(6));
  }
  if (dataParts.length === 0) return text; // fallback: plain JSON
  return dataParts[dataParts.length - 1]; // last data frame is the result
}

export async function mcpCall(
  mcpUrl: string,
  tool: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  bearer: string,
): Promise<McpCallResult> {
  const cfg = getConfig();
  const id = ++_requestId;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.E2E_TOOL_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${bearer}`,
      },
      body,
      signal: ctrl.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    throw new Error(`MCP request for ${tool} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  clearTimeout(timer);

  const raw = await sseToData(res);
  let parsed: { result?: { content?: unknown[]; isError?: boolean }; error?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`MCP response not JSON for ${tool}: ${raw.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(`MCP JSON-RPC error for ${tool}: ${JSON.stringify(parsed.error)}`);
  }

  const result = parsed.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const isError = Boolean(result.isError);

  // Parse the text blob to a plain object when possible.
  if (content.length > 0 && content[0]?.type === "text") {
    try {
      const parsed2 = JSON.parse(content[0].text);
      return { isError, content: parsed2 };
    } catch {
      return { isError, content: content[0].text };
    }
  }
  return { isError, content };
}

/** Sends an MCP `initialize` handshake to the server. */
export async function mcpInitialize(mcpUrl: string, bearer: string): Promise<void> {
  const id = ++_requestId;
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e-harness", version: "1.0" },
      },
    }),
  });
  if (!res.ok) throw new Error(`MCP initialize HTTP ${res.status}`);
}

/** Fetches the tool list and returns their names. */
export async function mcpToolNames(mcpUrl: string, bearer: string): Promise<string[]> {
  const id = ++_requestId;
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  const raw = await sseToData(res);
  const parsed = JSON.parse(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (parsed.result?.tools ?? []).map((t: any) => t.name);
}
