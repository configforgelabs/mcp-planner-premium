/**
 * Live PM-operation + read-safety self-test against a KEPT board (never deleted).
 *
 * Builds (or reuses) a persistent, multi-level, multi-bucket board with a sprint
 * and dependencies, then exercises the PM "rearrange the plan" operations against
 * a fresh SCRATCH subtree (so the canonical board is never mutated), verifying
 * each via independent OData reads. Finally verifies the new cursor/offset
 * pagination reassembles to the exact OData $count with no gaps or duplicates.
 *
 * The board plan (ZZ-MCP-E2E-SEED-*) is LEFT INTACT; only the per-run scratch
 * subtree is cleaned up.
 *
 * Usage (airplane + NordVPN needs the NODE_OPTIONS prefix):
 *   export E2E_ACCESS_TOKEN=$(NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     npx tsx --env-file .env scripts/get-dataverse-token.ts)
 *   NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     DATAVERSE_LINK_TYPE_STYLE=eu E2E_TOOL_TIMEOUT_MS=290000 npx tsx --env-file .env test/e2e/pmOpsLive.ts
 */

import { createServer, type Server } from "node:http";
import { getConfig, redact } from "./config.js";
import { mcpCall, mcpInitialize } from "./mcpClient.js";
import { verifyTaskField, verifyTaskCount, verifyTaskDeleted } from "./verify.js";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function ok(cond: boolean, label: string, evidence = ""): boolean {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}${evidence ? ` — ${evidence}` : ""}`);
  } else {
    fail++;
    fails.push(label);
    console.log(`  ❌ ${label}${evidence ? ` — ${evidence}` : ""}`);
  }
  return cond;
}

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
/** Open a session, run a mutation, apply, return nothing. */
async function inSession(projectId: string, fn: (opSet: string) => Promise<void>): Promise<void> {
  const s = await call("start_change_session", { projectId });
  await fn(s.operationSetId);
  await call("apply_changes", { operationSetId: s.operationSetId });
}

interface Board {
  projectId: string;
  buckets: Record<string, string>; // name -> bucketId
  sprintName: string;
}

const NEEDED_BUCKETS = ["Backlog", "In Progress", "Done"];
const SPRINT = "Sprint A";

/** Direct-OData check whether a named sprint exists (no MCP list-sprints tool). */
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

/** Find a kept seed board or build one; idempotently ensure the needed buckets +
 * sprint exist. A fresh build is populated with ~21 tasks (3 levels) so the
 * read-safety pagination has a real population to page over. Never deleted. */
async function ensureBoard(): Promise<Board> {
  const plans = await call("list_plans", { limit: 25 });
  const existing = (plans.plans ?? []).find(
    (p: any) => typeof p.name === "string" && p.name.startsWith("ZZ-MCP-E2E-SEED"),
  );

  let projectId: string;
  const buckets: Record<string, string> = {};
  let isNew = false;

  if (existing) {
    projectId = existing.projectId;
    const contents = await call("get_plan_tasks_and_buckets", { projectId, limit: 1000 });
    for (const b of contents.buckets ?? []) buckets[b.name] = b.bucketId;
    ok(true, "reuse kept board", `${existing.name} (${contents.taskCount} tasks)`);
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const plan = await call("create_plan", { subject: `ZZ-MCP-E2E-SEED-${ts}`, description: "persistent PM-ops board" });
    projectId = plan.projectId;
    isNew = true;
    ok(!!projectId, "created kept board", `ZZ-MCP-E2E-SEED-${ts}`);
  }

  // Idempotently ensure buckets + sprint.
  for (const name of NEEDED_BUCKETS) {
    if (!buckets[name]) buckets[name] = (await call("add_bucket", { projectId, name })).bucketId;
  }
  if (!(await sprintExists(projectId, SPRINT))) {
    await call("add_sprint", { projectId, name: SPRINT, start: "2026-07-01", finish: "2026-07-14" });
  }

  // Populate a fresh board with a real task population (3 levels, one FS dep).
  if (isNew) {
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
      await call("add_tasks", { operationSetId: opSet, projectId, tasks }); // 3 + 6 + 12 = 21 tasks
    });
    ok(true, "populated board (21 tasks, 3 levels, deps)");
  }

  return { projectId, buckets, sprintName: SPRINT };
}

/** Create a fresh scratch subtree under the board: a parent + 3 leaves in Backlog.
 * Returns their GUIDs. These are mutated by the PM-op scenarios, then deleted. */
async function makeScratch(board: Board): Promise<{ parent: string; leaves: string[]; depId?: string }> {
  let refs: Record<string, string> = {};
  let depIds: string[] = [];
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
    depIds = r.dependencyIds ?? [];
  });
  return { parent: refs.S, leaves: [refs.S1, refs.S2, refs.S3], depId: depIds[0] };
}

async function main(): Promise<void> {
  const cfg = getConfig();
  BEARER = cfg.E2E_ACCESS_TOKEN;
  const port = cfg.PORT;
  console.log(`\n${"=".repeat(70)}\n  PM-Ops + Read-Safety — Live Self-Test (kept board)\n${"=".repeat(70)}`);
  console.log(`  Org   : ${cfg.DATAVERSE_ORG_URL}\n  Token : ${redact(BEARER)}\n`);

  const server = await bootServer(port);
  URL_ = `http://localhost:${port}/mcp`;
  await mcpInitialize(URL_, BEARER);

  let board: Board | null = null;
  let scratchIds: string[] = [];

  try {
    console.log("Setup — persistent board:");
    board = await ensureBoard();
    const { projectId } = board;

    console.log("\nScratch subtree (mutated, then cleaned — board stays intact):");
    const scratch = await makeScratch(board);
    scratchIds = [scratch.parent, ...scratch.leaves];
    ok(scratchIds.every(Boolean), "created scratch subtree", `parent + ${scratch.leaves.length} leaves`);

    console.log("\nPM operations (verified via independent OData):");

    // 1. Re-bucket: move a leaf to 'Done'.
    await inSession(projectId, async (op) =>
      void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[0], bucket: "Done" }] })));
    ok((await verifyTaskField(scratch.leaves[0], "_msdyn_projectbucket_value", BEARER))?.toLowerCase() === board.buckets["Done"].toLowerCase(),
      "re-bucket leaf → Done");

    // 2. Reparent: move leaf 1 under leaf 2 (leaf 2 becomes a summary).
    await inSession(projectId, async (op) =>
      void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[0], parent: scratch.leaves[1] }] })));
    ok((await verifyTaskField(scratch.leaves[0], "_msdyn_parenttask_value", BEARER))?.toLowerCase() === scratch.leaves[1].toLowerCase(),
      "reparent leaf under another task");

    // 3. Re-sprint: place a leaf into the sprint.
    await inSession(projectId, async (op) =>
      void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[2], sprint: board.sprintName }] })));
    ok(!!(await verifyTaskField(scratch.leaves[2], "_msdyn_projectsprint_value", BEARER)),
      "move task into sprint");

    // 4. Reschedule + priority in one batch (TZ-tolerant: midnight-UTC may store as
    //    the prior local day, so accept Sep 14 or 15 — the point is it MOVED to Sep).
    await inSession(projectId, async (op) =>
      void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[2], finish: "2026-09-15T00:00:00Z", priority: 1 }] })));
    {
      const fin = await verifyTaskField(scratch.leaves[2], "msdyn_finish", BEARER);
      ok(typeof fin === "string" && /2026-09-1[45]/.test(fin), "reschedule finish date (moved to Sep)", String(fin).slice(0, 10));
    }

    // 5a. milestone is ignored with a warning; the other field in the same call applies.
    {
      const s = await call("start_change_session", { projectId });
      const r = await call("update_tasks", { operationSetId: s.operationSetId, projectId, tasks: [{ taskId: scratch.leaves[0], priority: 5, milestone: true }] });
      await call("apply_changes", { operationSetId: s.operationSetId });
      ok(Array.isArray(r.warnings) && r.warnings.some((w: string) => /milestone/i.test(w)), "milestone change ignored with warning");
    }
    // 5b. un-parent (move to top level) is blocked — the hierarchy guard holds.
    {
      const s = await call("start_change_session", { projectId });
      const res = await mcpCall(URL_, "update_tasks", { operationSetId: s.operationSetId, projectId, tasks: [{ taskId: scratch.leaves[0], parent: null }] }, BEARER);
      ok(res.isError === true, "un-parent (parent=null) rejected — can't move a task to the top level");
      await mcpCall(URL_, "cancel_change_session", { operationSetId: s.operationSetId }, BEARER).catch(() => {});
      ok((await verifyTaskField(scratch.leaves[0], "_msdyn_parenttask_value", BEARER))?.toLowerCase() === scratch.leaves[1].toLowerCase(),
        "hierarchy unchanged after blocked un-parent");
    }

    // 6. Bulk move: re-bucket the scratch parent + remaining leaf to 'In Progress' in one op-set.
    await inSession(projectId, async (op) =>
      void (await call("update_tasks", { operationSetId: op, projectId, tasks: [
        { taskId: scratch.parent, bucket: "In Progress" },
        { taskId: scratch.leaves[1], bucket: "In Progress" },
      ] })));
    ok((await verifyTaskField(scratch.parent, "_msdyn_projectbucket_value", BEARER))?.toLowerCase() === board.buckets["In Progress"].toLowerCase(),
      "bulk move (2 tasks in one operation set)");

    console.log("\nRead-safety at scale (cursor/offset pagination):");
    // get_plan_tasks_and_buckets: page with a tiny limit; reassemble == OData $count.
    {
      const direct = await verifyTaskCount(projectId, BEARER);
      const seen = new Set<string>();
      let token: string | undefined;
      let pages = 0;
      do {
        const r: any = await call("get_plan_tasks_and_buckets", { projectId, limit: 3, ...(token ? { pageToken: token } : {}) });
        for (const t of r.tasks) seen.add(String(t.taskId).toLowerCase());
        token = r.nextPageToken;
        pages++;
      } while (token && pages < 100);
      ok(seen.size === direct.count, "get_plan_tasks_and_buckets paginated == OData $count (no gaps/dupes)", `${seen.size} tasks over ${pages} pages, $count=${direct.count}`);
    }
    // list_plan_tasks offset paging: reassemble == totalMatched.
    {
      const seen = new Set<string>();
      let token: string | undefined;
      let total = -1;
      let pages = 0;
      do {
        const r: any = await call("list_plan_tasks", { projectId, filter: "all", limit: 3, ...(token ? { pageToken: token } : {}) });
        for (const t of r.tasks) seen.add(String(t.taskId).toLowerCase());
        total = r.totalMatched;
        token = r.nextPageToken;
        pages++;
      } while (token && pages < 100);
      ok(seen.size === total, "list_plan_tasks offset paging reassembles to totalMatched", `${seen.size}/${total} over ${pages} pages`);
    }
  } catch (e) {
    fail++;
    fails.push(`exception: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ❌ exception — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // Clean up ONLY the scratch subtree — leave the board intact.
    if (board && scratchIds.filter(Boolean).length > 0) {
      try {
        const s = await call("start_change_session", { projectId: board.projectId });
        await mcpCall(URL_, "delete_tasks_batch", { operationSetId: s.operationSetId, projectId: board.projectId, taskIds: scratchIds.filter(Boolean), confirmed: true }, BEARER);
        await mcpCall(URL_, "apply_changes", { operationSetId: s.operationSetId }, BEARER);
        const gone = await verifyTaskDeleted(scratchIds[0], BEARER);
        console.log(`  ℹ️  scratch subtree cleaned (${gone ? "verified deleted" : "delete queued"}); board kept.`);
      } catch (e) {
        console.log(`  ℹ️  scratch cleanup best-effort failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Result: ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}  (${pass} pass / ${fail} fail)`);
  if (fail > 0) console.log(`  Failed: ${fails.join("; ")}`);
  console.log(`${"=".repeat(70)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("pmOpsLive crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
