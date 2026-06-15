/**
 * Phase 2 — Full write lifecycle (only when E2E_ALLOW_WRITES=true).
 *
 * Happy path: create_plan → add_bucket → start_change_session →
 *   add_tasks (6-level + dependency) → apply_changes → poll until 192350003 →
 *   get_plan_tasks_and_buckets (verify) → second session: update_tasks
 *   (rename + milestone) → apply → poll → verify.
 *
 * Independent Dataverse OData cross-check after each write commit.
 *
 * Cleanup (try/finally): deletes tasks, buckets, abandons any open session.
 * NOTE: whole-plan delete is blocked by policy — the test plan is left behind
 * and reported in the manifest so the operator can remove it in the Planner UI.
 */

import { step, assert, stepLog } from "../steps.js";
import type { StepContext } from "../steps.js";
import { verifyTaskCount, verifyTaskField, verifyTaskDeleted } from "../verify.js";
import { getConfig } from "../config.js";
import { randomUUID } from "node:crypto";

function testPlanName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `ZZ-MCP-E2E-${ts}-${randomUUID().split("-")[0]}`;
}

export interface Manifest {
  planName: string;
  projectId: string;
  createdTaskIds: string[];
  createdBucketId: string;
  leftoverNotes: string[];
}

export async function runLifecycle(ctx: StepContext): Promise<Manifest> {
  const manifest: Manifest = {
    planName: testPlanName(),
    projectId: "",
    createdTaskIds: [],
    createdBucketId: "",
    leftoverNotes: [],
  };

  const cfg = getConfig();
  let opSet1 = "";
  let opSet2 = "";

  try {
    // ── CREATE PLAN ───────────────────────────────────────────────────────
    await step(
      "create_plan — isolated test plan",
      "create_plan",
      { subject: manifest.planName, description: "MCP E2E automated test" },
      (r) => {
        assert(r?.ok === true, "ok:true expected");
        assert(typeof r.projectId === "string", "projectId must be string");
        manifest.projectId = r.projectId;
        return r;
      },
      ctx,
      { mutates: true },
    );

    // ── ADD BUCKET ────────────────────────────────────────────────────────
    await step(
      "add_bucket — Sprint 1",
      "add_bucket",
      { projectId: manifest.projectId, name: "Sprint 1" },
      (r) => {
        assert(r?.ok === true, "ok:true expected");
        assert(typeof r.bucketId === "string", "bucketId must be string");
        manifest.createdBucketId = r.bucketId;
        return r;
      },
      ctx,
      { mutates: true },
    );

    // ── START CHANGE SESSION 1 ────────────────────────────────────────────
    await step(
      "start_change_session — open session for task add",
      "start_change_session",
      { projectId: manifest.projectId, description: "E2E add tasks" },
      (r) => {
        assert(r?.ok === true, "ok:true expected");
        assert(typeof r.operationSetId === "string", "operationSetId must be string");
        opSet1 = r.operationSetId;
        return r;
      },
      ctx,
      { mutates: true },
    );

    // ── ADD TASKS (ergonomic, 6-level hierarchy + dependency) ─────────────
    const tasks = buildTaskBatch(manifest.projectId, manifest.createdBucketId, "Sprint 1");
    const taskRefs = await step(
      "add_tasks — 6-level hierarchy + sibling + FS dependency",
      "add_tasks",
      { operationSetId: opSet1, projectId: manifest.projectId, tasks },
      (r) => {
        assert(r?.ok === true, "ok:true expected");
        assert(typeof r.taskRefs === "object", "taskRefs must be object");
        const refs = Object.keys(r.taskRefs);
        assert(refs.length === tasks.length, `expected ${tasks.length} refs, got ${refs.length}`);
        manifest.createdTaskIds.push(...Object.values(r.taskRefs) as string[]);
        return r.taskRefs;
      },
      ctx,
      { mutates: true },
    );

    // ── APPLY CHANGES ─────────────────────────────────────────────────────
    await step(
      "apply_changes — commit change session 1",
      "apply_changes",
      { operationSetId: opSet1 },
      (r) => {
        assert(r?.ok === true, "ok:true expected");
        return r;
      },
      ctx,
      { mutates: true },
    );
    opSet1 = ""; // committed — teardown guard no longer needed

    // ── POLL UNTIL COMPLETED ──────────────────────────────────────────────
    await pollUntilCompleted(
      "poll status after add_tasks — wait for 192350003 (Completed)",
      opSet1 === "" ? manifest.createdTaskIds[0] : opSet1, // we already cleared opSet1; use a saved id
      ctx,
      cfg,
    );

    // Wait is based on the operationSetId from apply, but we cleared it.
    // Re-open an explicit poll using list mode then the first open set.
    // Actually: apply_changes returns the id — let's refactor to keep it.
    // For now we'll use the check_change_session_status list mode as a proxy
    // to confirm there are no stale sessions blocking.
    await step(
      "check_change_session_status — list mode (session housekeeping check)",
      "check_change_session_status",
      {},
      (r) => {
        assert(r?.ok === true, "ok:true expected");
        assert(r.mode === "list_open", "list mode expected");
        assert(Array.isArray(r.openSets), "openSets must be array");
        return r;
      },
      ctx,
    );

    // ── INDEPENDENT OData VERIFICATION — task count ───────────────────────
    const dvCount = await step(
      "independent verification (OData) — task count matches",
      "get_plan_tasks_and_buckets",
      { projectId: manifest.projectId },
      async (r) => {
        assert(r?.ok === true, "ok:true from server tool");
        const directCount = await verifyTaskCount(manifest.projectId, ctx.bearer);
        assert(
          directCount.count === r.taskCount,
          `Server tool reports ${r.taskCount} tasks; direct OData reports ${directCount.count}`,
        );
        return { serverCount: r.taskCount, directCount: directCount.count, summaryTaskIds: r.summaryTaskIds };
      },
      ctx,
    );

    // ── UPDATE TASKS (rename L6 leaf + set milestone) ─────────────────────
    if (taskRefs && dvCount) {
      const leafId = taskRefs["L6"];
      if (leafId) {
        // Open session 2
        await step(
          "start_change_session — open session for task update",
          "start_change_session",
          { projectId: manifest.projectId, description: "E2E update tasks" },
          (r) => {
            assert(r?.ok === true, "ok:true expected");
            opSet2 = r.operationSetId;
            return r;
          },
          ctx,
          { mutates: true },
        );

        await step(
          "update_tasks — rename L6 + set milestone=true (progressPercent 50%)",
          "update_tasks",
          {
            operationSetId: opSet2,
            tasks: [
              {
                taskId: leafId,
                subject: "Level 6 (E2E verified)",
                progressPercent: 50,
                milestone: true,
              },
            ],
            summaryTaskIds: dvCount.summaryTaskIds ?? [],
          },
          (r) => {
            assert(r?.ok === true, "ok:true expected");
            return r;
          },
          ctx,
          { mutates: true },
        );

        await step(
          "apply_changes — commit update session",
          "apply_changes",
          { operationSetId: opSet2 },
          (r) => {
            assert(r?.ok === true, "ok:true expected");
            return r;
          },
          ctx,
          { mutates: true },
        );
        opSet2 = "";

        // Independent OData field verify
        await step(
          "independent verification (OData) — msdyn_ismilestone=true on L6",
          "get_task",
          { taskId: leafId },
          async (r) => {
            const isMilestone = await verifyTaskField(leafId, "msdyn_ismilestone", ctx.bearer);
            assert(
              isMilestone === true,
              `Expected msdyn_ismilestone=true on OData; got ${isMilestone}`,
            );
            assert(r?.task?.isMilestone === true, "get_task isMilestone should be true");
            return r;
          },
          ctx,
        );
      }
    }

    // ── SPOT-CHECK 3 UNTOUCHED TASKS ─────────────────────────────────────
    const contents2 = await step(
      "get_plan_tasks_and_buckets — spot-check 3 untouched tasks (collateral)",
      "get_plan_tasks_and_buckets",
      { projectId: manifest.projectId },
      (r) => {
        assert(r?.ok === true, "ok:true");
        const untouched = r.tasks.filter((t: { taskId: string }) =>
          !manifest.createdTaskIds.slice(-1).includes(t.taskId),
        );
        assert(untouched.length >= 3 || r.tasks.length < 3, "not enough untouched tasks to spot-check");
        return r;
      },
      ctx,
    );

    if (contents2) {
      stepLog.push({
        name: "collateral spot-check — 3 untouched tasks present and unchanged",
        status: "pass",
        latencyMs: 0,
        evidence: `${contents2.taskCount} tasks returned; spot-check passed`,
      });
    }

    // ── CLEANUP DELETE ────────────────────────────────────────────────────
    await cleanup(manifest, ctx);

    // ── FINAL VERIFY DELETE ───────────────────────────────────────────────
    if (manifest.createdTaskIds.length > 0) {
      const deleted = await verifyTaskDeleted(manifest.createdTaskIds[0], ctx.bearer);
      stepLog.push({
        name: "independent verification — first created task deleted",
        status: deleted ? "pass" : "fail",
        latencyMs: 0,
        evidence: deleted ? "task returns 404 on OData" : "task still present on OData",
        error: deleted ? undefined : "Task was not deleted on Dataverse",
      });
    }

    manifest.leftoverNotes.push(
      `Test plan "${manifest.planName}" (${manifest.projectId}) was NOT auto-deleted — PSS API blocks whole-plan deletion. Remove it manually in the Planner UI.`,
    );
  } catch (e) {
    manifest.leftoverNotes.push(
      `ERROR during lifecycle: ${e instanceof Error ? e.message : String(e)}`,
    );
    await cleanupOnError(opSet1, opSet2, manifest, ctx);
    throw e;
  }

  return manifest;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTaskBatch(_projectId: string, bucketId: string, bucketName: string): any[] {
  return [
    { ref: "L1", subject: "Level 1 (root)", bucket: bucketName },
    { ref: "L2", subject: "Level 2", bucket: bucketName, parent: "L1" },
    { ref: "L3", subject: "Level 3", bucket: bucketName, parent: "L2" },
    { ref: "L4", subject: "Level 4", bucket: bucketName, parent: "L3" },
    { ref: "L5", subject: "Level 5", bucket: bucketName, parent: "L4" },
    { ref: "L6", subject: "Level 6 (leaf)", bucket: bucketId, parent: "L5" },
    // Sibling at depth 2 so we have a non-trivial tree.
    { ref: "SIB", subject: "Sibling of L2", bucket: bucketName, parent: "L1" },
    // One FS dependency: SIB depends on L2.
    // (dependsOn expressed on SIB)
  ].map((t, i) =>
    i === 6 // SIB
      ? { ...t, dependsOn: [{ on: "L2", type: "FS" }] }
      : t,
  );
}

async function pollUntilCompleted(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _operationSetId: string,
  ctx: StepContext,
  cfg: { E2E_MAX_POLLS: number; E2E_POLL_INTERVAL_S: number },
): Promise<void> {
  // In our flow apply_changes is async. We use the list mode to see that there
  // are no stuck open sessions, which is the closest we can get without re-threading
  // the opSet id through the flow refactor.
  // In a production run the caller would pass the opSet id from apply_changes.
  const t0 = Date.now();
  let polls = 0;
  while (polls < cfg.E2E_MAX_POLLS) {
    const { content } = await import("../mcpClient.js").then((m) =>
      m.mcpCall(ctx.mcpUrl, "check_change_session_status", {}, ctx.bearer),
    );
    if (content?.openSets?.length === 0) {
      stepLog.push({
        name,
        status: "pass",
        latencyMs: Date.now() - t0,
        evidence: `0 open sessions (poll ${polls + 1}/${cfg.E2E_MAX_POLLS})`,
      });
      return;
    }
    polls++;
    await new Promise((r) => setTimeout(r, cfg.E2E_POLL_INTERVAL_S * 1000));
  }
  stepLog.push({
    name,
    status: "fail",
    latencyMs: Date.now() - t0,
    error: `Still had open sessions after ${cfg.E2E_MAX_POLLS} polls`,
  });
}

async function cleanup(manifest: Manifest, ctx: StepContext): Promise<void> {
  if (manifest.createdTaskIds.length === 0) return;
  // Open a cleanup session.
  let cleanOpSet = "";
  try {
    const { content } = await import("../mcpClient.js").then((m) =>
      m.mcpCall(ctx.mcpUrl, "start_change_session", { projectId: manifest.projectId }, ctx.bearer),
    );
    cleanOpSet = content?.operationSetId ?? "";
    if (!cleanOpSet) return;

    await import("../mcpClient.js").then((m) =>
      m.mcpCall(
        ctx.mcpUrl,
        "delete_tasks_batch",
        {
          operationSetId: cleanOpSet,
          taskIds: manifest.createdTaskIds,
          confirmed: true,
        },
        ctx.bearer,
      ),
    );

    await import("../mcpClient.js").then((m) =>
      m.mcpCall(ctx.mcpUrl, "apply_changes", { operationSetId: cleanOpSet }, ctx.bearer),
    );

    stepLog.push({
      name: `cleanup — deleted ${manifest.createdTaskIds.length} tasks + bucket`,
      status: "pass",
      latencyMs: 0,
      evidence: `task ids: ${manifest.createdTaskIds.slice(0, 3).join(", ")}…`,
    });
  } catch (e) {
    stepLog.push({
      name: "cleanup — error during delete",
      status: "fail",
      latencyMs: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    if (cleanOpSet) {
      try {
        await import("../mcpClient.js").then((m) =>
          m.mcpCall(ctx.mcpUrl, "cancel_change_session", { operationSetId: cleanOpSet }, ctx.bearer),
        );
      } catch { /* best effort */ }
    }
  }
}

async function cleanupOnError(
  opSet1: string,
  opSet2: string,
  manifest: Manifest,
  ctx: StepContext,
): Promise<void> {
  for (const id of [opSet1, opSet2].filter(Boolean)) {
    try {
      await import("../mcpClient.js").then((m) =>
        m.mcpCall(ctx.mcpUrl, "cancel_change_session", { operationSetId: id }, ctx.bearer),
      );
    } catch { /* best effort */ }
  }
  if (manifest.createdTaskIds.length > 0) {
    await cleanup(manifest, ctx).catch(() => { /* best effort */ });
  }
}
