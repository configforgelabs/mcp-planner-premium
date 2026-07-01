import { describe, it, expect } from "vitest";
import {
  buildAttachmentEntities,
  deriveAttachmentName,
  ATTACHMENT_ODATA_TYPE,
} from "../src/tools/addTaskAttachment.js";
import { validateAddEntities } from "../src/tools/addTasks.js";
import { buildTaskEntities } from "../src/tools/addTasksSimple.js";

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const TASK_ID = "a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5";
const PROJECT = "11111111-2222-3333-4444-555555555555";
const BUCKET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const resolveBucket = (b: string) => (GUID_RE.test(b) ? b : BUCKET);

describe("deriveAttachmentName", () => {
  it("uses the URL's last path segment, URL-decoded", () => {
    expect(
      deriveAttachmentName("https://contoso.sharepoint.com/sites/p/Shared%20Documents/My%20Spec.pdf"),
    ).toBe("My Spec.pdf");
  });
  it("falls back to the hostname when there is no path", () => {
    expect(deriveAttachmentName("https://example.com")).toBe("example.com");
  });
  it("falls back to the raw value for a non-URL string", () => {
    expect(deriveAttachmentName("just-a-label")).toBe("just-a-label");
  });
});

describe("buildAttachmentEntities", () => {
  it("builds a minimal attachment from a bare URL string", () => {
    const { entities, attached } = buildAttachmentEntities(TASK_ID, [
      "https://contoso.sharepoint.com/sites/p/docs/spec.pdf",
    ]);
    expect(entities).toHaveLength(1);
    const e = entities[0];
    expect(e["@odata.type"]).toBe(ATTACHMENT_ODATA_TYPE);
    expect(GUID_RE.test(e.msdyn_projecttaskattachmentid)).toBe(true);
    expect(e.msdyn_linkuri).toBe("https://contoso.sharepoint.com/sites/p/docs/spec.pdf");
    // PascalCase task bind (the proven gotcha) — to the given task, no project bind.
    expect(e["msdyn_Task@odata.bind"]).toBe("/msdyn_projecttasks(" + TASK_ID + ")");
    expect(e["msdyn_task@odata.bind"]).toBeUndefined();
    // The task is the ONLY lookup — no project bind (PSS infers it from the task).
    const binds = Object.keys(e).filter((k) => k.endsWith("@odata.bind"));
    expect(binds).toEqual(["msdyn_Task@odata.bind"]);
    // name derived from the URL; linktype defaults to "Other".
    expect(e.msdyn_name).toBe("spec.pdf");
    expect(e.msdyn_linktype).toBe("Other");
    expect(attached[0]).toMatchObject({ name: "spec.pdf", linkType: "Other" });
    // The built collection must satisfy the raw guardrails (defense in depth).
    expect(() => validateAddEntities(entities)).not.toThrow();
  });

  it("uses an explicit name and linkType when provided", () => {
    const { entities } = buildAttachmentEntities(TASK_ID, [
      { uri: "https://x/a.docx", name: "Project Brief", linkType: "Word" },
    ]);
    expect(entities[0].msdyn_name).toBe("Project Brief");
    expect(entities[0].msdyn_linktype).toBe("Word");
  });

  it("builds one entity per attachment with unique GUIDs", () => {
    const { entities } = buildAttachmentEntities(TASK_ID, [
      "https://x/1.pdf",
      "https://x/2.pdf",
    ]);
    expect(entities).toHaveLength(2);
    expect(entities[0].msdyn_projecttaskattachmentid).not.toBe(
      entities[1].msdyn_projecttaskattachmentid,
    );
    expect(() => validateAddEntities(entities)).not.toThrow();
  });

  it("throws on an empty attachments array", () => {
    expect(() => buildAttachmentEntities(TASK_ID, [])).toThrow(/non-empty/);
  });

  it("throws when a uri is empty", () => {
    expect(() => buildAttachmentEntities(TASK_ID, [{ uri: "   " }])).toThrow(
      /'uri' is required/,
    );
    expect(() => buildAttachmentEntities(TASK_ID, [""])).toThrow(/'uri' is required/);
  });

  it("rejects more than 200 attachments (per-operation-set cap)", () => {
    const many = Array.from({ length: 201 }, (_, i) => `https://x/${i}.pdf`);
    expect(() => buildAttachmentEntities(TASK_ID, many)).toThrow(/Max 200/);
  });
});

describe("validateAddEntities — attachment entity", () => {
  const valid = () => ({
    "@odata.type": ATTACHMENT_ODATA_TYPE,
    msdyn_projecttaskattachmentid: "0a0a0a0a-1111-2222-3333-444444444444",
    msdyn_name: "Spec",
    msdyn_linkuri: "https://x/spec.pdf",
    msdyn_linktype: "Other",
    "msdyn_Task@odata.bind": "/msdyn_projecttasks(" + TASK_ID + ")",
  });

  it("accepts a well-formed attachment entity", () => {
    expect(() => validateAddEntities([valid()])).not.toThrow();
  });

  it("teaches the PascalCase msdyn_Task bind for the lowercase alias", () => {
    const e: any = valid();
    delete e["msdyn_Task@odata.bind"];
    e["msdyn_task@odata.bind"] = "/msdyn_projecttasks(" + TASK_ID + ")";
    expect(() => validateAddEntities([e])).toThrow(
      /Use 'msdyn_Task@odata.bind' instead/,
    );
  });

  it("rejects a missing required field (linkuri) with a clear message", () => {
    const e: any = valid();
    delete e.msdyn_linkuri;
    expect(() => validateAddEntities([e])).toThrow(/missing required field\(s\): msdyn_linkuri/);
  });

  it("rejects a missing task bind", () => {
    const e: any = valid();
    delete e["msdyn_Task@odata.bind"];
    expect(() => validateAddEntities([e])).toThrow(/msdyn_Task@odata.bind/);
  });
});

describe("buildTaskEntities — attachments on add_tasks", () => {
  it("appends attachment entities bound to the created task and reports attachmentIds", () => {
    const built = buildTaskEntities(
      PROJECT,
      [
        {
          ref: "t1",
          subject: "Design",
          bucket: "Sprint 1",
          attachments: [
            "https://x/y/spec.pdf",
            { uri: "https://x/brief.docx", name: "Brief", linkType: "Word" },
          ],
        },
      ],
      resolveBucket,
    );
    // 1 task + 2 attachments
    expect(built.entities).toHaveLength(3);
    const taskId = built.refToId.t1;
    const atts = built.entities.filter(
      (e) => e["@odata.type"] === ATTACHMENT_ODATA_TYPE,
    );
    expect(atts).toHaveLength(2);
    for (const a of atts) {
      expect(a["msdyn_Task@odata.bind"]).toBe("/msdyn_projecttasks(" + taskId + ")");
    }
    expect(built.attachmentIds).toHaveLength(2);
    // Whole batch still passes the raw guardrails.
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });
});
