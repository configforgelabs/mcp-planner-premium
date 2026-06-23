/**
 * Phase 1 — Read sweep (safe on any environment, no writes).
 * Exercises all 8 read+reporting tools with realistic inputs and verifies
 * shapes, units (progressPercent 0-100, not 0-1), and degrade-to-warning patterns.
 */

import { step, assert, stepLog } from "../steps.js";
import type { StepContext } from "../steps.js";

/** A host (e.g. Langdock) truncates a tool response at ~200k chars; every page
 *  must stay under this. mcpClient returns the parsed object, so its JSON length
 *  closely tracks the bytes the host counts. */
const HOST_CHAR_CAP = 200_000;
const jlen = (o: unknown): number => JSON.stringify(o).length;

export async function runReadSweep(ctx: StepContext): Promise<void> {
  // --- list_plans ---------------------------------------------------------
  const plans = await step(
    "list_plans — returns array with required fields",
    "list_plans",
    { top: 5 },
    (r) => {
      assert(Array.isArray(r?.plans), "plans must be an array");
      if (r.plans.length > 0) {
        const p = r.plans[0];
        assert(typeof p.projectId === "string", "projectId must be a string");
        // progressPercent must be 0-100 (not 0-1 fraction)
        if (p.progressPercent !== null) {
          assert(
            p.progressPercent >= 0 && p.progressPercent <= 100,
            `progressPercent should be 0-100, got ${p.progressPercent}`,
          );
        }
      }
      return r;
    },
    ctx,
  );

  const firstPlan = plans?.plans?.[0];

  if (!firstPlan?.projectId) {
    stepLog.push({
      name: "read sweep (remaining) — skipped (no plans in environment)",
      status: "skip",
      latencyMs: 0,
      skipped: "No plans returned by list_plans; cannot exercise plan-scoped read tools",
    });
    return;
  }

  const projectId = firstPlan.projectId;

  // --- find_plan_by_name (name filter) ------------------------------------
  if (firstPlan.name) {
    await step(
      "find_plan_by_name — partial name match",
      "find_plan_by_name",
      { name: firstPlan.name.slice(0, 3) },
      (r) => {
        assert(Array.isArray(r?.plans), "plans must be an array");
        assert(typeof r.count === "number", "count must be a number");
        // progress in this tool is 0-1 fraction — verify
        if (r.plans.length > 0 && r.plans[0].progress !== null) {
          assert(
            r.plans[0].progress >= 0 && r.plans[0].progress <= 1,
            `find_plan_by_name progress should be 0-1 fraction, got ${r.plans[0].progress}`,
          );
        }
        return r;
      },
      ctx,
    );
  }

  // --- get_plan_summary ---------------------------------------------------
  const summary = await step(
    "get_plan_summary — rollup counts and units",
    "get_plan_summary",
    { projectId },
    (r) => {
      assert(r?.ok === true, "ok:true expected");
      assert(typeof r.totalTasks === "number", "totalTasks must be a number");
      if (r.progressPercent !== null) {
        assert(
          r.progressPercent >= 0 && r.progressPercent <= 100,
          `progressPercent should be 0-100, got ${r.progressPercent}`,
        );
      }
      // warnings[] must be an array (degrade-to-warning for effortRemaining)
      assert(Array.isArray(r.warnings), "warnings must be an array");
      return r;
    },
    ctx,
  );

  // --- get_plan_tasks_and_buckets -----------------------------------------
  const contents = await step(
    "get_plan_tasks_and_buckets — tasks + buckets + summaryTaskIds",
    "get_plan_tasks_and_buckets",
    { projectId },
    (r) => {
      assert(Array.isArray(r?.buckets), "buckets must be an array");
      assert(Array.isArray(r?.tasks), "tasks must be an array");
      assert(Array.isArray(r?.summaryTaskIds), "summaryTaskIds must be an array");
      assert(typeof r.truncated === "boolean", "truncated flag must be boolean");
      // Size safety: capped at 200 rows/page, under the host char cap, with an
      // explicit completeness signal so the caller knows to keep paging.
      assert(typeof r.hasMore === "boolean", "hasMore must be a boolean");
      assert(r.tasks.length <= 200, `page must hold <= 200 tasks, got ${r.tasks.length}`);
      assert(jlen(r) < HOST_CHAR_CAP, `response must stay < ${HOST_CHAR_CAP} chars, got ${jlen(r)}`);
      if (r.hasMore)
        assert(
          typeof r.nextPageToken === "string" && r.nextPageToken.length > 0,
          "hasMore:true must carry a nextPageToken",
        );
      // progress on tasks is 0-1 fraction in this tool
      if (r.tasks.length > 0 && r.tasks[0].progress !== null && r.tasks[0].progress !== undefined) {
        assert(
          r.tasks[0].progress >= 0 && r.tasks[0].progress <= 1,
          `task progress in get_plan_tasks_and_buckets should be 0-1, got ${r.tasks[0].progress}`,
        );
      }
      return r;
    },
    ctx,
  );

  // --- get_task (first task if any) ---------------------------------------
  const firstTask = contents?.tasks?.[0];
  if (firstTask?.taskId) {
    await step(
      "get_task — single task detail with predecessors/successors/assignments",
      "get_task",
      { taskId: firstTask.taskId },
      (r) => {
        assert(r?.ok === true, "ok:true expected");
        assert(r?.task?.taskId === firstTask.taskId, "taskId must match");
        assert(Array.isArray(r.predecessors), "predecessors must be array");
        assert(Array.isArray(r.successors), "successors must be array");
        assert(Array.isArray(r.assignments), "assignments must be array");
        assert(Array.isArray(r.warnings), "warnings must be array (degrade path)");
        if (r.task.progressPercent !== null) {
          assert(
            r.task.progressPercent >= 0 && r.task.progressPercent <= 100,
            `get_task progressPercent should be 0-100, got ${r.task.progressPercent}`,
          );
        }
        return r;
      },
      ctx,
    );
  }

  // --- pagination walk: prove the WHOLE plan is reachable by following
  //     nextPageToken, that every page is bounded (<=200 rows, < host cap) and
  //     that no task appears on two pages (cursor correctness). This is the
  //     end-to-end guarantee that a 200k-truncation never loses data. ---------
  {
    const seen = new Set<string>();
    let token: string | undefined;
    let pages = 0;
    let lastHasMore = false;
    do {
      const page = await step(
        `get_plan_tasks_and_buckets — page ${pages + 1} (<=200 rows, < ${HOST_CHAR_CAP} chars)`,
        "get_plan_tasks_and_buckets",
        token ? { projectId, pageToken: token } : { projectId },
        (r) => {
          assert(typeof r.hasMore === "boolean", "hasMore must be a boolean");
          assert(Array.isArray(r.tasks), "tasks must be an array");
          assert(r.tasks.length <= 200, `page must hold <= 200 tasks, got ${r.tasks.length}`);
          assert(jlen(r) < HOST_CHAR_CAP, `page must be < ${HOST_CHAR_CAP} chars, got ${jlen(r)}`);
          if (r.hasMore) {
            assert(
              typeof r.nextPageToken === "string" && r.nextPageToken.length > 0,
              "hasMore:true must carry a nextPageToken",
            );
            assert(typeof r.note === "string", "hasMore:true must carry a paging note");
          }
          for (const t of r.tasks) {
            assert(!seen.has(t.taskId), `task ${t.taskId} appeared on two pages (cursor bug)`);
            seen.add(t.taskId);
          }
          return r;
        },
        ctx,
      );
      if (!page) break;
      pages++;
      token = page.nextPageToken;
      lastHasMore = page.hasMore;
    } while (token && lastHasMore && pages < 50);

    // Cross-check: a fully-walked plan yields exactly its task count, and a
    // >200-task plan must have spanned multiple pages (proving the cap engaged).
    const walkedAll = !lastHasMore && pages < 50;
    const totalTasks = typeof summary?.totalTasks === "number" ? summary.totalTasks : null;
    const countMismatch = walkedAll && totalTasks !== null && seen.size !== totalTasks;
    const missedMultiPage = totalTasks !== null && totalTasks > 200 && pages < 2;
    stepLog.push({
      name: `pagination — walked ${pages} page(s), ${seen.size} distinct tasks${totalTasks !== null ? ` (plan totalTasks=${totalTasks})` : ""}`,
      status: countMismatch || missedMultiPage ? "fail" : "pass",
      latencyMs: 0,
      tool: "get_plan_tasks_and_buckets",
      evidence: `pages=${pages}, distinctTasks=${seen.size}, totalTasks=${totalTasks}, multiPage=${pages > 1}, walkedAll=${walkedAll}`,
      ...(countMismatch
        ? { error: `walked ${seen.size} distinct tasks but plan reports totalTasks=${totalTasks}` }
        : missedMultiPage
          ? { error: `plan has ${totalTasks} tasks (>200) but the walk took only ${pages} page — cap did not engage` }
          : {}),
    });
  }

  // --- list_plan_tasks all/overdue/milestones ----------------------------
  for (const filter of ["all", "overdue", "milestones"] as const) {
    await step(
      `list_plan_tasks filter=${filter}`,
      "list_plan_tasks",
      { projectId, filter },
      (r) => {
        assert(Array.isArray(r?.tasks), `tasks must be array for filter=${filter}`);
        assert(r.filter === filter, `filter field must echo back "${filter}"`);
        assert(typeof r.truncated === "boolean", "truncated must be boolean");
        // Size safety: capped at 200 rows/page, under the host char cap.
        assert(typeof r.hasMore === "boolean", "hasMore must be a boolean");
        assert(r.tasks.length <= 200, `page must hold <= 200 tasks, got ${r.tasks.length}`);
        assert(
          typeof r.pageLimit === "number" && r.pageLimit <= 200,
          `pageLimit must be <= 200, got ${r.pageLimit}`,
        );
        assert(jlen(r) < HOST_CHAR_CAP, `response must stay < ${HOST_CHAR_CAP} chars, got ${jlen(r)}`);
        return r;
      },
      ctx,
    );
  }

  // --- get_bucket_breakdown ----------------------------------------------
  await step(
    "get_bucket_breakdown — per-bucket counts and avgProgressPercent",
    "get_bucket_breakdown",
    { projectId },
    (r) => {
      assert(Array.isArray(r?.buckets), "buckets must be array");
      assert(typeof r.method === "string", "method must be string (aggregate|client)");
      assert(typeof r.truncated === "boolean", "truncated must be boolean");
      if (r.buckets.length > 0) {
        const b = r.buckets[0];
        assert(typeof b.taskCount === "number", "taskCount must be number");
        if (b.avgProgressPercent !== null) {
          assert(
            b.avgProgressPercent >= 0 && b.avgProgressPercent <= 100,
            `avgProgressPercent should be 0-100, got ${b.avgProgressPercent}`,
          );
        }
      }
      return r;
    },
    ctx,
  );

  // --- list_dependencies -------------------------------------------------
  await step(
    "list_dependencies — predecessor/successor links",
    "list_dependencies",
    { projectId },
    (r) => {
      assert(Array.isArray(r?.dependencies), "dependencies must be array");
      assert(typeof r.count === "number", "count must be number");
      if (r.dependencies.length > 0) {
        const d = r.dependencies[0];
        assert(typeof d.predecessorTaskId === "string", "predecessorTaskId must be string");
        assert(typeof d.successorTaskId === "string", "successorTaskId must be string");
      }
      return r;
    },
    ctx,
  );

  // --- list_team_members -------------------------------------------------
  await step(
    "list_team_members — all plan team members",
    "list_team_members",
    { projectId },
    (r) => {
      assert(Array.isArray(r?.members), "members must be array");
      assert(typeof r.count === "number", "count must be number");
      return r;
    },
    ctx,
  );

  // --- describe_option_set (link types) -----------------------------------
  await step(
    "describe_option_set — msdyn_projecttaskdependencylinktype (FS/SS/FF/SF)",
    "describe_option_set",
    {
      entityLogicalName: "msdyn_projecttaskdependency",
      attributeLogicalName: "msdyn_projecttaskdependencylinktype",
    },
    (r) => {
      assert(r?.ok === true, "ok:true expected");
      assert(Array.isArray(r.options), "options must be array");
      assert(r.options.length >= 4, "expected at least 4 link-type options (FS/SS/FF/SF)");
      const values = r.options.map((o: { value: number }) => o.value);
      // Two value ranges exist across tenants (see LINK_TYPE_LABELS): the global
      // FS=192350000, or the EU/CRM4 small-integer range (0-3). Accept either.
      const hasGlobalFS = values.includes(192350000);
      const hasEuRange = [0, 1, 2, 3].every((v) => values.includes(v));
      assert(
        hasGlobalFS || hasEuRange,
        `expected global FS (192350000) or the EU 0-3 range, got [${values.join(",")}]`,
      );
      return r;
    },
    ctx,
  );
}
