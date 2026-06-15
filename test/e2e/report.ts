/**
 * Markdown report renderer. Pure function — no I/O, no side effects.
 * Unit-testable without a live server.
 */

import type { StepResult } from "./steps.js";
import type { AgenticResult } from "./agentic.js";
import type { Manifest } from "./scenarios/lifecycle.js";

export interface RunSummary {
  runAt: string;
  orgUrl: string;
  serverUrl: string;
  serverVersion: string;
  protocol: string;
  toolsAdvertised: number;
  userId?: string;
  writeMode: boolean;
  durationMs: number;
  steps: StepResult[];
  agenticResult?: AgenticResult;
  manifest?: Partial<Manifest>;
}

const ICON: Record<string, string> = {
  pass: "✅",
  fail: "❌",
  skip: "⏭️",
};

function badge(status: string): string {
  return ICON[status] ?? "❓";
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function renderReport(s: RunSummary): string {
  const total = s.steps.length;
  const passed = s.steps.filter((r) => r.status === "pass").length;
  const failed = s.steps.filter((r) => r.status === "fail").length;
  const skipped = s.steps.filter((r) => r.status === "skip").length;
  const guardrails = s.steps.filter((r) => r.name.toLowerCase().includes("rejected") || r.name.toLowerCase().includes("refused") || r.name.toLowerCase().includes("rejected") || r.name.includes("guardrail") || r.name.toLowerCase().includes("blocked") || r.name.toLowerCase().includes("confirmed") || r.name.toLowerCase().includes("cycle") || r.name.toLowerCase().includes("duplicate") || r.name.toLowerCase().includes("disallowed") || r.name.toLowerCase().includes(">200") || r.name.toLowerCase().includes("out of range"));
  const guardrailsFired = guardrails.filter((r) => r.status === "pass").length;
  const overall = failed === 0 ? "✅ ALL PASS" : `❌ ${failed} FAILURE(S)`;

  const lines: string[] = [];
  lines.push("# MCP Planner Premium — E2E Acceptance Report");
  lines.push("");
  lines.push(`Run: \`${s.runAt}\`  ·  Org: \`${s.orgUrl}\`  ·  Server: \`${s.serverUrl}\``);
  lines.push(`Protocol: \`${s.protocol}\`  ·  Tools advertised: ${s.toolsAdvertised}  ·  User: \`${s.userId ?? "n/a"}\``);
  lines.push(`Mode: **${s.writeMode ? "WRITES ENABLED" : "READ-ONLY"}**  ·  Duration: ${fmt(s.durationMs)}`);
  lines.push("");
  lines.push(`## Overall Result: ${overall}`);
  lines.push("");
  lines.push(`| Category | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Total steps | ${total} |`);
  lines.push(`| Pass | ${passed} |`);
  lines.push(`| Fail | ${failed} |`);
  lines.push(`| Skip | ${skipped} |`);
  lines.push(`| Guardrails fired (correctly rejected) | ${guardrailsFired}/${guardrails.length} |`);
  lines.push("");

  // ── Section 1: Deterministic (functional) ──────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## Section 1 — Functional (Deterministic)");
  lines.push("");
  lines.push("*Pass/fail decided by code assertions. Repeatable on every run.*");
  lines.push("");

  // Group by rough phase.
  const phaseOrder = ["preflight", "read", "verify", "write", "lifecycle", "guardrail", "cleanup", "collateral", "independent", "spot"];
  const phaseGroups = new Map<string, StepResult[]>();
  for (const r of s.steps.filter((s) => !s.name.startsWith("agentic"))) {
    const key = detectPhase(r.name, phaseOrder);
    if (!phaseGroups.has(key)) phaseGroups.set(key, []);
    phaseGroups.get(key)!.push(r);
  }

  for (const [phase, results] of phaseGroups) {
    lines.push(`### ${capitalise(phase)}`);
    lines.push("");
    lines.push(`| | Step | Tool | Latency | Evidence |`);
    lines.push(`|---|---|---|---|---|`);
    for (const r of results) {
      const icon = badge(r.status);
      const detail = r.status === "fail" ? `⚠️ ${r.error ?? ""}` : (r.evidence ?? r.skipped ?? "");
      lines.push(`| ${icon} | ${r.name} | \`${r.tool ?? ""}\` | ${fmt(r.latencyMs)} | ${detail.replace(/\|/g, "\\|").slice(0, 120)} |`);
    }
    lines.push("");
  }

  if (failed > 0) {
    lines.push("### ❌ Failure Detail");
    lines.push("");
    for (const r of s.steps.filter((s) => s.status === "fail")) {
      lines.push(`**${r.name}**`);
      lines.push(`- Tool: \`${r.tool ?? "n/a"}\``);
      if (r.argsSummary) lines.push(`- Args: \`${r.argsSummary}\``);
      lines.push(`- Error: ${r.error}`);
      lines.push("");
    }
  }

  // ── Section 2: Agentic (exploratory) ──────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## Section 2 — Interface Usability (Agentic, Exploratory)");
  lines.push("");
  lines.push("*A real AI model drives the tools from descriptions alone. Pass/fail still decided by code (OData verification), not by the model's own summary.*");
  lines.push("");

  if (!s.agenticResult || s.agenticResult.skipped) {
    lines.push(`⏭️  **Skipped** — ${s.agenticResult?.reason ?? "E2E_AGENTIC not set"}`);
    lines.push("");
    lines.push("To enable: set `E2E_AGENTIC=true` and `ANTHROPIC_API_KEY=<key>`.");
  } else {
    const ag = s.agenticResult;
    const agIcon = ag.descriptionUsabilityPassed ? "✅" : "❌";
    lines.push(`${agIcon} **Model:** \`${ag.modelUsed ?? "n/a"}\``);
    lines.push("");
    lines.push(`| Check | Result |`);
    lines.push(`|---|---|`);
    lines.push(`| Description usability (model built correct plan) | ${agIcon} ${ag.descriptionUsabilityPassed ? "PASS" : "FAIL"} |`);
    lines.push(`| Tasks verified via direct OData GET | ${ag.verifiedTaskCount ?? "n/a"} (expected ${ag.expectedTaskCount ?? 2}) |`);
    lines.push(`| Plan projectId returned | \`${ag.projectId ?? "none"}\` |`);
    if (ag.error) lines.push(`| Error | ${ag.error} |`);
    lines.push("");
    if (ag.agentRaw) {
      lines.push("**Model output (last 500 chars):**");
      lines.push("```");
      lines.push(ag.agentRaw);
      lines.push("```");
    }
  }

  // ── Cleanup / residue ──────────────────────────────────────────────────
  if (s.manifest) {
    lines.push("---");
    lines.push("");
    lines.push("## Cleanup & Residue");
    lines.push("");
    if (s.manifest.leftoverNotes?.length) {
      for (const n of s.manifest.leftoverNotes) {
        lines.push(`- ⚠️  ${n}`);
      }
    } else {
      lines.push("- ✅  No residue noted.");
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*This report was generated automatically by `npm run e2e`. All correctness verdicts are code assertions — never AI-generated summaries.*");
  lines.push("");

  return lines.join("\n");
}

function detectPhase(name: string, phases: string[]): string {
  const lower = name.toLowerCase();
  for (const p of phases) {
    if (lower.includes(p)) return p;
  }
  return "other";
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
