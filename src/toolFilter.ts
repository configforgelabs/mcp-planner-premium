/**
 * Pure tool-filtering function for production-ops controls.
 *
 * Determines which tools to expose based on three orthogonal constraints:
 *   1. READ_ONLY_MODE  — only tools with readOnlyHint===true are eligible
 *   2. ENABLED_TOOLS   — explicit allowlist of exact tool names
 *   3. TOOLSETS        — named group allowlist; a tool is eligible if it
 *                        belongs to ≥1 selected group
 *
 * All three are AND-ed together. An empty result is legal (the operator asked
 * for an impossible intersection). An unknown tool name in ENABLED_TOOLS or an
 * unknown group in TOOLSETS THROWS so a misconfiguration fails at boot, not
 * silently at runtime.
 *
 * No I/O. No side-effects. Fully unit-testable.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "./tools/types.js";
import { TOOLSETS } from "./toolsets.js";

export { TOOLSETS };

export interface ToolFilterEnv {
  readOnly: boolean;
  /** Exact tool names; undefined = no constraint. */
  enabledTools?: string[];
  /** Group names from TOOLSETS; undefined = no constraint. */
  toolsets?: string[];
}

export interface ToolFilterResult {
  /** Tools to register, in the original allTools order. */
  tools: ToolDef[];
  /** Per-excluded-tool human reason (for boot log and /healthz). */
  excluded: Record<string, string>;
  /** Read-only tool names, for the call-time read-only guard. */
  readOnlyNames: Set<string>;
}

/**
 * Validates inputs and returns the filtered set of tools.
 *
 * Throws for unknown tool names in `enabledTools` or unknown group names in
 * `toolsets` — fail-closed so a typo in config is caught at boot.
 */
export function filterTools(
  allTools: ToolDef[],
  annotations: Record<string, ToolAnnotations>,
  env: ToolFilterEnv,
): ToolFilterResult {
  const allNames = new Set(allTools.map((t) => t.name));

  // --- Validate inputs (fail-closed) ---

  if (env.enabledTools) {
    for (const name of env.enabledTools) {
      if (!allNames.has(name)) {
        throw new Error(
          `ENABLED_TOOLS contains unknown tool name: "${name}". ` +
            `Known tools: ${[...allNames].sort().join(", ")}`,
        );
      }
    }
  }

  if (env.toolsets) {
    const knownGroups = new Set(Object.keys(TOOLSETS));
    for (const group of env.toolsets) {
      if (!knownGroups.has(group)) {
        throw new Error(
          `TOOLSETS contains unknown toolset: "${group}". ` +
            `Known toolsets: ${[...knownGroups].sort().join(", ")}`,
        );
      }
    }
  }

  // --- Compute read-only name set (source of truth: annotations) ---

  const readOnlyNames = new Set<string>();
  for (const tool of allTools) {
    if (annotations[tool.name]?.readOnlyHint === true) {
      readOnlyNames.add(tool.name);
    }
  }

  // --- Compute toolset union (if toolsets constraint active) ---

  let toolsetNames: Set<string> | undefined;
  if (env.toolsets && env.toolsets.length > 0) {
    toolsetNames = new Set<string>();
    for (const group of env.toolsets) {
      for (const name of TOOLSETS[group]) {
        toolsetNames.add(name);
      }
    }
  }

  // --- Filter ---

  const enabledSet = env.enabledTools ? new Set(env.enabledTools) : undefined;

  const tools: ToolDef[] = [];
  const excluded: Record<string, string> = {};

  for (const tool of allTools) {
    // Constraint 1: READ_ONLY_MODE
    if (env.readOnly && !readOnlyNames.has(tool.name)) {
      excluded[tool.name] = "read-only mode";
      continue;
    }

    // Constraint 2: ENABLED_TOOLS
    if (enabledSet && !enabledSet.has(tool.name)) {
      excluded[tool.name] = "not in ENABLED_TOOLS";
      continue;
    }

    // Constraint 3: TOOLSETS
    if (toolsetNames && !toolsetNames.has(tool.name)) {
      excluded[tool.name] =
        `not in TOOLSETS [${env.toolsets!.join(", ")}]`;
      continue;
    }

    tools.push(tool);
  }

  return { tools, excluded, readOnlyNames };
}
