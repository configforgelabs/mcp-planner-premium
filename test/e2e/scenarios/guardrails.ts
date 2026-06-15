/**
 * Phase 3 — Guardrail tests (negative / must-be-rejected).
 * Each test expects the tool to return isError=true with a specific message.
 * These run without writes (no change session needed for most).
 */

import { guardStep } from "../steps.js";
import type { StepContext } from "../steps.js";

const FAKE_GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FAKE_GUID2 = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const FAKE_PROJ = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa";
const FAKE_BUCKET = "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb";

const TASK = "Microsoft.Dynamics.CRM.msdyn_projecttask";

export async function runGuardrails(ctx: StepContext): Promise<void> {
  // ── GUID VALIDATION ───────────────────────────────────────────────────
  await guardStep(
    "find_plan_by_name — empty name rejected",
    "find_plan_by_name",
    { name: "" },
    "required",
    ctx,
  );

  await guardStep(
    "get_plan_summary — bad projectId rejected",
    "get_plan_summary",
    { projectId: "not-a-guid" },
    "guid",
    ctx,
  );

  // ── BATCH ENTITY GUARDRAILS ─────────────────────────────────────────────
  await guardStep(
    "add_tasks_batch — disallowed @odata.type rejected",
    "add_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      entities: JSON.stringify([{ "@odata.type": "Microsoft.Dynamics.CRM.account" }]),
    },
    "disallowed",
    ctx,
  );

  await guardStep(
    "add_tasks_batch — blocked-on-create field msdyn_ismilestone rejected",
    "add_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      entities: JSON.stringify([
        {
          "@odata.type": TASK,
          msdyn_projecttaskid: FAKE_GUID2,
          msdyn_subject: "T",
          "msdyn_project@odata.bind": `/msdyn_projects(${FAKE_PROJ})`,
          "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${FAKE_BUCKET})`,
          msdyn_ismilestone: true,
        },
      ]),
    },
    "not allowed on pss create",
    ctx,
  );

  await guardStep(
    "add_tasks_batch — wrong bind alias (msdyn_bucket) rejected",
    "add_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      entities: JSON.stringify([
        {
          "@odata.type": TASK,
          msdyn_projecttaskid: FAKE_GUID2,
          msdyn_subject: "T",
          "msdyn_project@odata.bind": `/msdyn_projects(${FAKE_PROJ})`,
          "msdyn_bucket@odata.bind": `/msdyn_projectbuckets(${FAKE_BUCKET})`,
        },
      ]),
    },
    "valid navigation property",
    ctx,
  );

  await guardStep(
    "add_tasks_batch — child before parent (ordering) rejected",
    "add_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      entities: JSON.stringify([
        {
          "@odata.type": TASK,
          msdyn_projecttaskid: FAKE_GUID2,
          msdyn_subject: "Child",
          "msdyn_project@odata.bind": `/msdyn_projects(${FAKE_PROJ})`,
          "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${FAKE_BUCKET})`,
          "msdyn_parenttask@odata.bind": `/msdyn_projecttasks(${FAKE_GUID})`,
        },
        {
          "@odata.type": TASK,
          msdyn_projecttaskid: FAKE_GUID,
          msdyn_subject: "Parent",
          "msdyn_project@odata.bind": `/msdyn_projects(${FAKE_PROJ})`,
          "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${FAKE_BUCKET})`,
        },
      ]),
    },
    "parents must appear before",
    ctx,
  );

  await guardStep(
    "add_tasks_batch — >200 entities rejected",
    "add_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      entities: JSON.stringify(
        Array.from({ length: 201 }, (_, i) => ({
          "@odata.type": TASK,
          msdyn_projecttaskid: FAKE_GUID.replace(/a/g, i.toString(16)[0] ?? "0"),
          msdyn_subject: `T${i}`,
          "msdyn_project@odata.bind": `/msdyn_projects(${FAKE_PROJ})`,
          "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${FAKE_BUCKET})`,
        })),
      ),
    },
    "max 200",
    ctx,
  );

  // ── DELETE GUARDRAILS ──────────────────────────────────────────────────
  await guardStep(
    "delete_tasks_batch — no confirmed=true refused",
    "delete_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      taskIds: [FAKE_GUID2],
      confirmed: false,
    },
    "confirmed",
    ctx,
  );

  await guardStep(
    "delete_tasks_batch — whole-plan delete hard-blocked",
    "delete_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      records: JSON.stringify([{ entityLogicalName: "msdyn_project", recordId: FAKE_GUID2 }]),
      confirmed: true,
    },
    "blocked by policy",
    ctx,
  );

  // ── UPDATE GUARDRAILS ─────────────────────────────────────────────────
  await guardStep(
    "update_tasks_batch — dependency update rejected",
    "update_tasks_batch",
    {
      operationSetId: FAKE_GUID,
      entities: JSON.stringify([
        { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency" },
      ]),
    },
    "cannot be updated",
    ctx,
  );

  await guardStep(
    "update_tasks — progressPercent out of range rejected",
    "update_tasks",
    {
      operationSetId: FAKE_GUID,
      tasks: [{ taskId: FAKE_GUID2, progressPercent: 150 }],
    },
    "between 0 and 100",
    ctx,
  );

  // ── ADD TASKS ERGONOMIC GUARDRAILS ────────────────────────────────────
  await guardStep(
    "add_tasks — duplicate ref rejected",
    "add_tasks",
    {
      operationSetId: FAKE_GUID,
      projectId: FAKE_PROJ,
      tasks: [
        { ref: "t1", subject: "A", bucket: "Sprint 1" },
        { ref: "t1", subject: "B", bucket: "Sprint 1" },
      ],
    },
    "duplicate",
    ctx,
  );

  await guardStep(
    "add_tasks — cycle in parent hierarchy rejected",
    "add_tasks",
    {
      operationSetId: FAKE_GUID,
      projectId: FAKE_PROJ,
      tasks: [
        { ref: "a", subject: "A", bucket: "Sprint 1", parent: "b" },
        { ref: "b", subject: "B", bucket: "Sprint 1", parent: "a" },
      ],
    },
    "cycle",
    ctx,
  );
}
