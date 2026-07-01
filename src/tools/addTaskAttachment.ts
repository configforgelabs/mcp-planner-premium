import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getApiBase } from "../config.js";
import {
  dvReq,
  dvHeaders,
  dvErrorMessage,
  asArray,
  assertGuid,
  throwIfPssCreateError,
} from "../dataverse.js";
import { validateAddEntities } from "./addTasks.js";
import type { ToolDef } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const ATTACHMENT_ODATA_TYPE =
  "Microsoft.Dynamics.CRM.msdyn_projecttaskattachment";

/**
 * One attachment to add to a task. Planner-Premium task attachments are
 * LINK/REFERENCE attachments (a URL — the same model as Microsoft Planner
 * references / OneNote-style links), NOT embedded file bytes. To attach a real
 * file you upload it to SharePoint/OneDrive elsewhere and pass its share URL
 * here. A bare string is shorthand for `{ uri }`.
 */
export type AttachmentInput =
  | string
  | { uri: string; name?: string; linkType?: string };

/** Derives a friendly display name from a URL (its last path segment). */
export function deriveAttachmentName(uri: string): string {
  const u = uri.trim();
  try {
    const parsed = new URL(u);
    const segs = parsed.pathname.split("/").filter(Boolean);
    if (segs.length > 0) {
      const last = decodeURIComponent(segs[segs.length - 1]);
      if (last) return last;
    }
    return parsed.hostname || u;
  } catch {
    // Not an absolute URL — fall back to the raw value.
    return u;
  }
}

/**
 * Pure builder: turns a list of attachment inputs into the msdyn_PssCreateV2
 * entity array for msdyn_projecttaskattachment. No network — unit-testable.
 *
 * Proven payload (PSS-IMPLEMENTATION-LESSONS §5):
 *   - @odata.type = Microsoft.Dynamics.CRM.msdyn_projecttaskattachment
 *   - msdyn_name (display name), msdyn_linkuri (the URL), msdyn_linktype (free
 *     string type hint; defaults to "Other") — all ApplicationRequired.
 *   - The ONLY lookup is the task, bound on the PascalCase nav-property
 *     `msdyn_Task@odata.bind`. There is NO project lookup — PSS infers the
 *     project from the task. (Lowercase `msdyn_task@odata.bind` is rejected by
 *     Dataverse as an annotation-only property with no value.)
 *
 * @param taskId  GUID of the task the attachments hang off (already validated).
 */
export function buildAttachmentEntities(
  taskId: string,
  attachments: AttachmentInput[],
): {
  entities: any[];
  attached: { attachmentId: string; name: string; uri: string; linkType: string }[];
} {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    throw new Error("attachments must be a non-empty array.");
  }
  if (attachments.length > 200) {
    throw new Error(
      "Too many attachments (" +
        attachments.length +
        "). Max 200 per change session — split into batches.",
    );
  }

  const entities: any[] = [];
  const attached: { attachmentId: string; name: string; uri: string; linkType: string }[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const raw = attachments[i];
    const item: { uri: string; name?: string; linkType?: string } =
      typeof raw === "string" ? { uri: raw } : raw;

    const uri = (item.uri || "").trim();
    if (!uri) {
      throw new Error(
        "attachments[" + i + "]: 'uri' is required (the link/URL to attach).",
      );
    }
    const name = (item.name || "").trim() || deriveAttachmentName(uri);
    const linkType = (item.linkType || "").trim() || "Other";
    const attachmentId = randomUUID();

    entities.push({
      "@odata.type": ATTACHMENT_ODATA_TYPE,
      msdyn_projecttaskattachmentid: attachmentId,
      msdyn_name: name,
      msdyn_linkuri: uri,
      msdyn_linktype: linkType,
      "msdyn_Task@odata.bind": "/msdyn_projecttasks(" + taskId + ")",
    });
    attached.push({ attachmentId, name, uri, linkType });
  }

  return { entities, attached };
}

const attachmentSchema = z.union([
  z.string(),
  z.object({
    uri: z.string().describe("The link/URL to attach (e.g. a SharePoint or OneDrive share URL)."),
    name: z
      .string()
      .optional()
      .describe("Display name for the attachment. Defaults to the URL's last path segment."),
    linkType: z
      .string()
      .optional()
      .describe('Free-form type hint shown in the UI (e.g. "Other", "Pdf", "Word"). Defaults to "Other".'),
  }),
]);

// add_task_attachment — attach one or more LINK attachments to an EXISTING task.
// Self-contained: opens its own change session, creates via PSS, applies and
// polls to completion (like add_bucket / add_sprint), so the caller gets
// confirmed attachmentIds back in a single call.
export const addTaskAttachment: ToolDef = {
  name: "add_task_attachment",
  title: "Add Attachment to Task",
  description:
    "Attaches one or more LINK attachments (URLs) to an EXISTING task via PSS (msdyn_PssCreateV2). " +
    "Planner-Premium task attachments are link/reference attachments — a URL plus a display name and a free-form type hint — NOT uploaded file bytes. " +
    "To attach a real file, upload it to SharePoint/OneDrive first and pass its share URL here. " +
    "Pass attachments as a URL string, or {uri, name?, linkType?} objects (name defaults to the URL's last segment; linkType defaults to \"Other\"). " +
    "No separate change session is needed — the tool manages its own session, applies, and polls to completion, returning the created attachmentIds. " +
    "Direct Dataverse create of this entity is blocked by the platform; this PSS path is the only API way to add one. Max 200 per call.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan the task belongs to (msdyn_projectid)."),
    taskId: z.string().describe("GUID of the task to attach to (msdyn_projecttaskid)."),
    attachments: z
      .union([z.string(), z.array(attachmentSchema)])
      .describe(
        "Attachment(s) to add: a URL string, or a JSON array of URL strings and/or {uri, name?, linkType?} objects.",
      ),
  },
  handler: async (input: {
    projectId: string;
    taskId: string;
    attachments: unknown;
  }) => {
    const BASE = getApiBase();

    const projectId = assertGuid(input.projectId, "projectId");
    const taskId = assertGuid(input.taskId, "taskId");

    const rawAttachments = asArray<AttachmentInput>(input.attachments, "attachments");
    if (rawAttachments.length === 0)
      throw new Error("attachments must be a non-empty array.");

    const built = buildAttachmentEntities(taskId, rawAttachments);

    // Defense in depth: the built collection must still pass the raw guardrails
    // (allow-list, 200-cap, bind-alias, required-field checks for attachments).
    validateAddEntities(built.entities);

    // 1. Open a dedicated OperationSet for this attach.
    const sessionRes = await dvReq({
      url: BASE + "/msdyn_CreateOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { ProjectId: projectId, Description: "Add task attachment(s)" },
    });
    if (sessionRes.status >= 400) {
      throw new Error(
        "create_operation_set failed (" + sessionRes.status + "): " + dvErrorMessage(sessionRes),
      );
    }
    const operationSetId: string = sessionRes.json?.OperationSetId;
    if (!operationSetId)
      throw new Error("create_operation_set did not return an OperationSetId.");

    // 2. Queue the attachment entities.
    const createRes = await dvReq({
      url: BASE + "/msdyn_PssCreateV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { EntityCollection: built.entities, OperationSetId: operationSetId },
    });
    throwIfPssCreateError(createRes);

    // 3. Apply (async commit).
    const applyRes = await dvReq({
      url: BASE + "/msdyn_ExecuteOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { OperationSetId: operationSetId },
    });
    if (applyRes.status >= 400) {
      throw new Error(
        "execute_operation_set failed (" + applyRes.status + "): " + dvErrorMessage(applyRes),
      );
    }

    // 4. Poll operationset status (up to 15 × 3 s = 45 s).
    let completed = false;
    for (let i = 0; i < 15; i++) {
      await sleep(3000);
      const statusRes = await dvReq(
        {
          url: BASE + "/msdyn_operationsets(" + operationSetId + ")?$select=msdyn_status",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      // 404 means the record was cleaned up after completion — treat as done.
      if (statusRes.status === 404) { completed = true; break; }
      if (statusRes.status >= 400) break;
      const code: number = statusRes.json?.msdyn_status;
      if (code === 192350003) { completed = true; break; }
      if (code === 192350002)
        throw new Error(
          "add_task_attachment PSS operation failed. Check msdyn_psserrorlogs for details (operationSetId: " +
            operationSetId +
            ").",
        );
      if (code === 192350004)
        throw new Error(
          "add_task_attachment PSS operation was abandoned (operationSetId: " + operationSetId + ").",
        );
    }

    return {
      ok: true,
      taskId,
      attachmentIds: built.attached.map((a) => a.attachmentId),
      attached: built.attached,
      note: completed
        ? "Attachment(s) persisted to the task."
        : "Attachment(s) queued but PSS has not confirmed completion yet (operationSetId: " +
          operationSetId +
          "). Poll check_change_session_status until Completed before relying on them.",
    };
  },
};
