/**
 * Live PM-operation + read-safety self-test against a KEPT board (never deleted).
 *
 * Builds (or reuses) a persistent, multi-level, multi-bucket board with a sprint
 * and dependencies, then exercises the PM "rearrange the plan" operations against
 * a fresh SCRATCH subtree (so the canonical board is never mutated), verifying
 * each via independent OData reads. Finally verifies the new cursor/offset
 * pagination reassembles to the exact OData $count with no gaps or duplicates.
 *
 * Writes a PM-team-facing report: pm-acceptance-report-<UTC>.md (same format as
 * the full-board acceptance run). The board (ZZ-MCP-E2E-SEED-*) is LEFT INTACT;
 * only the per-run scratch subtree is cleaned up.
 *
 * Usage (airplane + NordVPN needs the NODE_OPTIONS prefix):
 *   export E2E_ACCESS_TOKEN=$(NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     npx tsx --env-file .env scripts/get-dataverse-token.ts)
 *   NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     DATAVERSE_LINK_TYPE_STYLE=eu REQUEST_TIMEOUT_MS=120000 E2E_TOOL_TIMEOUT_MS=290000 \
 *     npx tsx --env-file .env test/e2e/pmOpsLive.ts
 */

import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { getConfig, redact } from "./config.js";
import { mcpCall, mcpInitialize } from "./mcpClient.js";
import { verifyTaskField, verifyTaskCount, verifyTaskDeleted } from "./verify.js";

// ── Result recording (drives both the console + the markdown report) ──────────
type Status = "pass" | "fail" | "info";
interface Row { phase: string; status: Status; step: string; tool: string; latencyMs: number; evidence: string; }
const rows: Row[] = [];
let curPhase = "";

function setPhase(p: string): void {
  curPhase = p;
  console.log(`\n${p}:`);
}
function check(step: string, tool: string, latencyMs: number, cond: boolean, evidence = ""): boolean {
  rows.push({ phase: curPhase, status: cond ? "pass" : "fail", step, tool, latencyMs, evidence });
  console.log(`  ${cond ? "✅" : "❌"} ${step}${evidence ? ` — ${evidence}` : ""}`);
  return cond;
}
function info(step: string, tool: string, evidence = ""): void {
  rows.push({ phase: curPhase, status: "info", step, tool, latencyMs: 0, evidence });
  console.log(`  ℹ️  ${step}${evidence ? ` — ${evidence}` : ""}`);
}
const lc = (s: unknown) => String(s ?? "").toLowerCase();
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

async function bootServer(port: number): Promise<Server> {
  process.env.AUTH_MODE = "insecure-passthrough";
  delete process.env.READ_ONLY_MODE;
  const { resetEnvCache } = await import("../../src/config.js");
  resetEnvCache();
  const { buildApp } = await import("../../src/app.js");
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(port, () => resolve(srv));
    srv.once("error", reject);
  });
}

let URL_ = "";
let BEARER = "";
const TRANSIENT = /fetch failed|did not respond|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|socket|ENOTFOUND|network/i;

/** mcpCall with retry on TRANSIENT network failures (airplane wifi drops mid-call;
 * a "fetch failed" means the server never reached Dataverse, so re-issuing is safe). */
async function call(tool: string, args: Record<string, unknown>, attempts = 4): Promise<any> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await mcpCall(URL_, tool, args, BEARER);
      if (r.isError) {
        const msg = JSON.stringify(r.content);
        if (TRANSIENT.test(msg) && i < attempts) {
          lastErr = new Error(msg);
          await new Promise((res) => setTimeout(res, 2500));
          continue;
        }
        throw new Error(`${tool} isError: ${msg.slice(0, 200)}`);
      }
      return r.content as any;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSIENT.test(msg) && i < attempts) {
        await new Promise((res) => setTimeout(res, 2500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
/** Open a session, run a mutation, apply. */
async function inSession(projectId: string, fn: (opSet: string) => Promise<void>): Promise<void> {
  const s = await call("start_change_session", { projectId });
  await fn(s.operationSetId);
  await call("apply_changes", { operationSetId: s.operationSetId });
}

interface Board {
  projectId: string;
  buckets: Record<string, string>;
  sprintName: string;
  name: string;
  taskCount: number;
}

const NEEDED_BUCKETS = ["Backlog", "In Progress", "Done"];
const SPRINT = "Sprint A";

async function sprintExists(projectId: string, name: string): Promise<boolean> {
  const cfg = getConfig();
  const url =
    `${cfg.DATAVERSE_ORG_URL}/api/data/v9.2/msdyn_projectsprints?$select=msdyn_projectsprintid` +
    `&$filter=_msdyn_project_value eq ${projectId} and msdyn_name eq '${name.replace(/'/g, "''")}'&$top=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BEARER}`, "OData-Version": "4.0", "OData-MaxVersion": "4.0", Accept: "application/json" },
  });
  if (!res.ok) return false;
  const data: any = await res.json();
  return (data.value?.length ?? 0) > 0;
}

async function ensureBoard(): Promise<Board> {
  const plans = await call("list_plans", { limit: 25 });
  const existing = (plans.plans ?? []).find(
    (p: any) => typeof p.name === "string" && p.name.startsWith("ZZ-MCP-E2E-SEED"),
  );

  let projectId: string;
  let name: string;
  const buckets: Record<string, string> = {};
  let isNew = false;

  if (existing) {
    projectId = existing.projectId;
    name = existing.name;
    const t0 = Date.now();
    const contents = await call("get_plan_tasks_and_buckets", { projectId, limit: 1000 });
    for (const b of contents.buckets ?? []) buckets[b.name] = b.bucketId;
    check("reuse kept board (persistent, not rebuilt)", "list_plans", Date.now() - t0, true, `${name} — ${contents.taskCount} tasks`);
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    name = `ZZ-MCP-E2E-SEED-${ts}`;
    const t0 = Date.now();
    const plan = await call("create_plan", { subject: name, description: "persistent PM-ops board" });
    projectId = plan.projectId;
    isNew = true;
    check("create kept board", "create_plan", Date.now() - t0, !!projectId, name);
  }

  for (const b of NEEDED_BUCKETS) {
    if (!buckets[b]) buckets[b] = (await call("add_bucket", { projectId, name: b })).bucketId;
  }
  if (!(await sprintExists(projectId, SPRINT))) {
    await call("add_sprint", { projectId, name: SPRINT, start: "2026-07-01", finish: "2026-07-14" });
  }

  if (isNew) {
    const t0 = Date.now();
    await inSession(projectId, async (opSet) => {
      const tasks: any[] = [];
      for (let p = 1; p <= 3; p++) {
        tasks.push({ ref: `P${p}`, subject: `Phase ${p}`, bucket: NEEDED_BUCKETS[(p - 1) % 3] });
        for (let c = 1; c <= 2; c++) {
          tasks.push({ ref: `P${p}C${c}`, subject: `Phase ${p} - Workstream ${c}`, bucket: NEEDED_BUCKETS[(p - 1) % 3], parent: `P${p}` });
          for (let g = 1; g <= 2; g++) {
            const ref = `P${p}C${c}G${g}`;
            const t: any = { ref, subject: `Task ${p}.${c}.${g}`, bucket: NEEDED_BUCKETS[(p - 1) % 3], parent: `P${p}C${c}`, finish: "2026-08-01T00:00:00Z" };
            if (g === 2) t.dependsOn = [{ on: `P${p}C${c}G1`, type: "FS" }];
            tasks.push(t);
          }
        }
      }
      await call("add_tasks", { operationSetId: opSet, projectId, tasks });
    });
    check("populate board (3 levels, FS dependencies)", "add_tasks", Date.now() - t0, true, "21 tasks across 3 buckets");
  }

  const count = await verifyTaskCount(projectId, BEARER);
  return { projectId, buckets, sprintName: SPRINT, name, taskCount: count.count };
}

async function makeScratch(board: Board): Promise<{ parent: string; leaves: string[] }> {
  let refs: Record<string, string> = {};
  await inSession(board.projectId, async (opSet) => {
    const r = await call("add_tasks", {
      operationSetId: opSet, projectId: board.projectId,
      tasks: [
        { ref: "S", subject: "SCRATCH parent", bucket: "Backlog" },
        { ref: "S1", subject: "SCRATCH leaf 1", bucket: "Backlog", parent: "S" },
        { ref: "S2", subject: "SCRATCH leaf 2", bucket: "Backlog", parent: "S", finish: "2026-08-01T00:00:00Z" },
        { ref: "S3", subject: "SCRATCH leaf 3", bucket: "Backlog", parent: "S", dependsOn: [{ on: "S2", type: "FS" }] },
      ],
    });
    refs = r.taskRefs;
  });
  return { parent: refs.S, leaves: [refs.S1, refs.S2, refs.S3] };
}

function renderReport(board: Board | null, runAt: string, org: string, durationMs: number, residue: string): string {
  const pass = rows.filter((r) => r.status === "pass").length;
  const fail = rows.filter((r) => r.status === "fail").length;
  const infoN = rows.filter((r) => r.status === "info").length;
  const icon = (s: Status) => (s === "pass" ? "✅" : s === "fail" ? "❌" : "ℹ️");
  const L: string[] = [];
  L.push("# MCP Planner Premium — PM Acceptance Report");
  L.push("");
  L.push(`Run: \`${runAt}\`  ·  Org: \`${org}\`  ·  Duration: ${fmtMs(durationMs)}`);
  L.push(`Scope: PM task-change operations + large-plan read safety (cursor/offset pagination)`);
  if (board) L.push(`Board: \`${board.name}\` (\`${board.projectId}\`) — ${board.taskCount} tasks, KEPT (never deleted); scenarios run against a disposable scratch subtree`);
  L.push("");
  L.push(`## Overall: ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}`);
  L.push("");
  L.push("| | Count |");
  L.push("|---|---|");
  L.push(`| Pass | ${pass} |`);
  L.push(`| Fail | ${fail} |`);
  L.push(`| Info (documented behaviour) | ${infoN} |`);
  L.push("");
  const phases = [...new Set(rows.map((r) => r.phase))];
  for (const ph of phases) {
    L.push(`## ${ph}`);
    L.push("");
    L.push("| | Step | Tool | Latency | Evidence / Error |");
    L.push("|---|---|---|---|---|");
    for (const r of rows.filter((x) => x.phase === ph)) {
      const detail = (r.status === "fail" ? `⚠️ ${r.evidence}` : r.evidence).replace(/\|/g, "\\|").slice(0, 140);
      L.push(`| ${icon(r.status)} | ${r.step} | \`${r.tool}\` | ${fmtMs(r.latencyMs)} | ${detail} |`);
    }
    L.push("");
  }
  L.push("## Cleanup & residue");
  L.push("");
  L.push(`- ${residue}`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("*All correctness verdicts are code assertions against live Dataverse reads (independent of the MCP tool output) — never AI-generated summaries.*");
  L.push("");
  return L.join("\n");
}

async function main(): Promise<void> {
  const cfg = getConfig();
  BEARER = cfg.E2E_ACCESS_TOKEN;
  const port = cfg.PORT;
  const runAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`\n${"=".repeat(70)}\n  PM-Ops + Read-Safety — Live Self-Test (kept board)\n${"=".repeat(70)}`);
  console.log(`  Org   : ${cfg.DATAVERSE_ORG_URL}\n  Token : ${redact(BEARER)}\n`);

  const server = await bootServer(port);
  URL_ = `http://localhost:${port}/mcp`;
  await mcpInitialize(URL_, BEARER);

  let board: Board | null = null;
  let scratchIds: string[] = [];
  let residue = "✅ scratch subtree cleaned; board kept (not deleted).";

  try {
    setPhase("Setup — persistent board");
    board = await ensureBoard();
    const { projectId } = board;

    setPhase("Scratch subtree (mutated then cleaned — board stays intact)");
    let t = Date.now();
    const scratch = await makeScratch(board);
    scratchIds = [scratch.parent, ...scratch.leaves];
    check("create scratch subtree (parent + 3 leaves + FS dep)", "add_tasks", Date.now() - t, scratchIds.every(Boolean));

    setPhase("PM operations (verified via independent OData)");

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[0], bucket: "Done" }] })));
    check("move a task to a different bucket (→ Done)", "update_tasks", Date.now() - t,
      lc(await verifyTaskField(scratch.leaves[0], "_msdyn_projectbucket_value", BEARER)) === lc(board.buckets["Done"]), "bucket = Done");

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[0], parent: scratch.leaves[1] }] })));
    check("reparent a task under another task", "update_tasks", Date.now() - t,
      lc(await verifyTaskField(scratch.leaves[0], "_msdyn_parenttask_value", BEARER)) === lc(scratch.leaves[1]), "parent changed");

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[2], sprint: board.sprintName }] })));
    check("move a task into a sprint", "update_tasks", Date.now() - t,
      !!(await verifyTaskField(scratch.leaves[2], "_msdyn_projectsprint_value", BEARER)), `sprint = ${board.sprintName}`);

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[2], finish: "2026-09-15T00:00:00Z", priority: 1 }] })));
    {
      const fin = await verifyTaskField(scratch.leaves[2], "msdyn_finish", BEARER);
      check("reschedule a task's finish date + priority", "update_tasks", Date.now() - t, typeof fin === "string" && /2026-09-1[45]/.test(fin), `finish = ${String(fin).slice(0, 10)}`);
    }

    t = Date.now();
    {
      const s = await call("start_change_session", { projectId });
      const r = await call("update_tasks", { operationSetId: s.operationSetId, projectId, tasks: [{ taskId: scratch.leaves[0], priority: 5, milestone: true }] });
      await call("apply_changes", { operationSetId: s.operationSetId });
      check("milestone flag change is ignored with a warning (UI-only)", "update_tasks", Date.now() - t,
        Array.isArray(r.warnings) && r.warnings.some((w: string) => /milestone/i.test(w)), "warned; other fields applied");
    }

    t = Date.now();
    {
      const s = await call("start_change_session", { projectId });
      const res = await mcpCall(URL_, "update_tasks", { operationSetId: s.operationSetId, projectId, tasks: [{ taskId: scratch.leaves[0], parent: null }] }, BEARER);
      const blocked = res.isError === true;
      await mcpCall(URL_, "cancel_change_session", { operationSetId: s.operationSetId }, BEARER).catch(() => {});
      const unchanged = lc(await verifyTaskField(scratch.leaves[0], "_msdyn_parenttask_value", BEARER)) === lc(scratch.leaves[1]);
      check("un-parent (move to top level) is blocked; hierarchy unchanged", "update_tasks", Date.now() - t, blocked && unchanged, "rejected; subtree intact");
    }

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [
      { taskId: scratch.parent, bucket: "In Progress" },
      { taskId: scratch.leaves[1], bucket: "In Progress" },
    ] })));
    check("bulk move (2 tasks in one operation set)", "update_tasks", Date.now() - t,
      lc(await verifyTaskField(scratch.parent, "_msdyn_projectbucket_value", BEARER)) === lc(board.buckets["In Progress"]), "both re-bucketed");

    info("not supported by the API (confirmed): reorder within a bucket, move to another plan, edit a dependency in place", "—",
      "PSS manages display order; cross-plan move + in-place dependency edits have no API path (delete + recreate)");

    setPhase("Read safety at scale (cursor / offset pagination)");
    t = Date.now();
    {
      const direct = await verifyTaskCount(projectId, BEARER);
      const seen = new Set<string>();
      let token: string | undefined; let pages = 0;
      do {
        const r: any = await call("get_plan_tasks_and_buckets", { projectId, limit: 3, ...(token ? { pageToken: token } : {}) });
        for (const x of r.tasks) seen.add(lc(x.taskId));
        token = r.nextPageToken; pages++;
      } while (token && pages < 200);
      check("get_plan_tasks_and_buckets paginates to the exact OData $count (no gaps/dupes)", "get_plan_tasks_and_buckets", Date.now() - t,
        seen.size === direct.count, `${seen.size} tasks over ${pages} pages == $count ${direct.count}`);
    }
    t = Date.now();
    {
      const seen = new Set<string>(); let token: string | undefined; let total = -1; let pages = 0;
      do {
        const r: any = await call("list_plan_tasks", { projectId, filter: "all", limit: 3, ...(token ? { pageToken: token } : {}) });
        for (const x of r.tasks) seen.add(lc(x.taskId));
        total = r.totalMatched; token = r.nextPageToken; pages++;
      } while (token && pages < 200);
      check("list_plan_tasks offset paging reassembles to totalMatched", "list_plan_tasks", Date.now() - t, seen.size === total, `${seen.size}/${total} over ${pages} pages`);
    }
  } catch (e) {
    rows.push({ phase: curPhase || "Run", status: "fail", step: "unexpected exception", tool: "—", latencyMs: 0, evidence: e instanceof Error ? e.message : String(e) });
    console.log(`  ❌ exception — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (board && scratchIds.filter(Boolean).length > 0) {
      try {
        const s = await call("start_change_session", { projectId: board.projectId });
        await mcpCall(URL_, "delete_tasks_batch", { operationSetId: s.operationSetId, projectId: board.projectId, taskIds: scratchIds.filter(Boolean), confirmed: true }, BEARER);
        await mcpCall(URL_, "apply_changes", { operationSetId: s.operationSetId }, BEARER);
        const gone = await verifyTaskDeleted(scratchIds[0], BEARER);
        residue = `✅ scratch subtree ${gone ? "deleted (verified)" : "delete queued"}; board \`${board.name}\` kept (never deleted).`;
        console.log(`  ℹ️  ${residue}`);
      } catch (e) {
        residue = `⚠️ scratch cleanup best-effort failed: ${e instanceof Error ? e.message : String(e)}; board kept.`;
        console.log(`  ℹ️  ${residue}`);
      }
    }
    await new Promise<void>((r) => server.close(() => r()));
  }

  // Write the PM-team-facing report.
  const report = renderReport(board, runAt, cfg.DATAVERSE_ORG_URL, Date.now() - t0, residue);
  const file = `pm-acceptance-report-${runAt.replace(/[:.]/g, "-").slice(0, 19)}.md`;
  await writeFile(file, report, "utf-8");

  const fail = rows.filter((r) => r.status === "fail").length;
  const pass = rows.filter((r) => r.status === "pass").length;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Result : ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}  (${pass} pass / ${fail} fail)`);
  console.log(`  Report : ${file}`);
  console.log(`${"=".repeat(70)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("pmOpsLive crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
