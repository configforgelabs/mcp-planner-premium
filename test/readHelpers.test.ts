import { describe, it, expect } from "vitest";
import {
  summariseTasks,
  linkTypeLabel,
  decodeDataverseText,
  hasStrippableTagContent,
  fitToBudget,
  pageByOffset,
  type RawTask,
} from "../src/tools/readHelpers.js";

const NOW = "2026-06-15T00:00:00Z";

describe("pageByOffset", () => {
  const decode = (t?: string) => (t ? Buffer.from(t, "base64url").toString("utf8") : undefined);
  const all = Array.from({ length: 5 }, (_, i) => ({ i }));

  it("returns a short numeric-offset cursor (not a long opaque blob) and pages through", () => {
    const p1 = pageByOffset(all, 2);
    expect(p1.items).toEqual([{ i: 0 }, { i: 1 }]);
    expect(p1.hasMore).toBe(true);
    expect(decode(p1.nextPageToken)).toBe("2"); // cursor is just the next offset
    expect(p1.nextPageToken!.length).toBeLessThanOrEqual(8); // short enough for a model to echo

    const p2 = pageByOffset(all, 2, p1.nextPageToken);
    expect(p2.items).toEqual([{ i: 2 }, { i: 3 }]);
    expect(decode(p2.nextPageToken)).toBe("4");

    const p3 = pageByOffset(all, 2, p2.nextPageToken);
    expect(p3.items).toEqual([{ i: 4 }]);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextPageToken).toBeUndefined();
  });

  it("yields an empty page with no token when the offset is past the end (stale cursor)", () => {
    const r = pageByOffset(all, 2, Buffer.from("99", "utf8").toString("base64url"));
    expect(r.items).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(r.nextPageToken).toBeUndefined();
  });

  it("shrinks a page to the char budget but still advances the cursor by what it returned", () => {
    const big = Array.from({ length: 6 }, (_, i) => ({ i, blob: "x".repeat(1000) }));
    const r = pageByOffset(big, 6, undefined, 3200);
    expect(r.fits).toBe(false);
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.items.length).toBeLessThan(6);
    expect(r.hasMore).toBe(true);
    // The cursor equals exactly how many rows we returned — no row is skipped.
    expect(decode(r.nextPageToken)).toBe(String(r.items.length));
  });

  it("rejects a malformed pageToken", () => {
    expect(() => pageByOffset(all, 2, "!!!not-base64!!!")).toThrow(/Invalid pageToken/);
    expect(() => pageByOffset(all, 2, Buffer.from("-1", "utf8").toString("base64url"))).toThrow(
      /Invalid pageToken/,
    );
  });
});

describe("fitToBudget", () => {
  it("returns everything when under budget", () => {
    const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const r = fitToBudget(items, 10_000);
    expect(r.fits).toBe(true);
    expect(r.items).toHaveLength(3);
  });

  it("returns the largest leading slice that fits, with fits=false", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, blob: "x".repeat(1000) }));
    const r = fitToBudget(items, 3200);
    expect(r.fits).toBe(false);
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.items.length).toBeLessThan(10);
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(3200);
    // One more item would have pushed it over budget.
    expect(JSON.stringify(items.slice(0, r.items.length + 1)).length).toBeGreaterThan(3200);
  });

  it("always returns at least one item even if it alone exceeds the budget", () => {
    const items = [{ huge: "x".repeat(5000) }, { b: 2 }];
    const r = fitToBudget(items, 100);
    expect(r.items).toHaveLength(1);
    expect(r.fits).toBe(false);
  });

  it("handles an empty list", () => {
    expect(fitToBudget([], 100)).toEqual({ items: [], fits: true });
  });
});

describe("linkTypeLabel", () => {
  it("maps standard 192350000-range values to FS/SS/FF/SF", () => {
    expect(linkTypeLabel(192350000)).toBe("FS");
    expect(linkTypeLabel(192350001)).toBe("SS");
    expect(linkTypeLabel(192350002)).toBe("FF");
    expect(linkTypeLabel(192350003)).toBe("SF");
  });

  it("maps EU/CRM4 small-integer values (0-3) to FF/FS/SF/SS", () => {
    // EU tenants expose 0=FF, 1=FS, 2=SF, 3=SS (confirmed via describe_option_set).
    expect(linkTypeLabel(0)).toBe("FF");
    expect(linkTypeLabel(1)).toBe("FS");
    expect(linkTypeLabel(2)).toBe("SF");
    expect(linkTypeLabel(3)).toBe("SS");
  });

  it("returns Unknown(N) for unrecognised values and undefined for non-numbers", () => {
    expect(linkTypeLabel(999)).toBe("Unknown(999)");
    expect(linkTypeLabel(undefined)).toBeUndefined();
  });
});

describe("decodeDataverseText", () => {
  it("decodes the standard entities Dataverse stores in descriptions", () => {
    expect(decodeDataverseText("Risks: &quot;vendor lock-in&quot; &amp; data")).toBe(
      'Risks: "vendor lock-in" & data',
    );
    expect(decodeDataverseText("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeDataverseText("it&#39;s &apos;quoted&apos;")).toBe("it's 'quoted'");
  });

  it("decodes &amp; LAST so an escaped entity is not double-decoded", () => {
    // Stored "&amp;lt;" is the literal text "&lt;" — must NOT collapse to "<".
    expect(decodeDataverseText("&amp;lt;")).toBe("&lt;");
    expect(decodeDataverseText("&amp;quot;")).toBe('&quot;');
  });

  it("leaves plain text and unicode untouched", () => {
    expect(decodeDataverseText("Budget €50k — José")).toBe("Budget €50k — José");
    expect(decodeDataverseText("no entities here")).toBe("no entities here");
  });

  it("maps null/undefined to null (matches the read-tool field contract)", () => {
    expect(decodeDataverseText(null)).toBeNull();
    expect(decodeDataverseText(undefined)).toBeNull();
  });
});

describe("hasStrippableTagContent", () => {
  it("flags tag-like <...> spans that Dataverse strips", () => {
    expect(hasStrippableTagContent("follow-up <2 weeks>")).toBe(true);
    expect(hasStrippableTagContent("see <b>bold</b>")).toBe(true);
    // Broad on purpose: a < ... > span counts even if not a real tag.
    expect(hasStrippableTagContent("5 < 10 > 2")).toBe(true);
  });

  it("does NOT flag a lone < or > (those round-trip safely)", () => {
    expect(hasStrippableTagContent("a < b")).toBe(false);
    expect(hasStrippableTagContent("a > b")).toBe(false);
    expect(hasStrippableTagContent("plain text, no brackets")).toBe(false);
  });

  it("is false for null/undefined", () => {
    expect(hasStrippableTagContent(null)).toBe(false);
    expect(hasStrippableTagContent(undefined)).toBe(false);
  });
});

describe("summariseTasks", () => {
  const parentId = "aaaaaaaa-0000-0000-0000-000000000001";
  const child1 = "aaaaaaaa-0000-0000-0000-000000000002";
  const child2 = "aaaaaaaa-0000-0000-0000-000000000003";
  const leaf = "aaaaaaaa-0000-0000-0000-000000000004";

  const tasks: RawTask[] = [
    // parent (summary) - overdue + <100% but must NOT count as overdue (summary)
    { msdyn_projecttaskid: parentId, msdyn_finish: "2026-01-01T00:00:00Z", msdyn_progress: 0.5 },
    // child overdue + incomplete -> counts
    {
      msdyn_projecttaskid: child1,
      _msdyn_parenttask_value: parentId,
      msdyn_finish: "2026-01-02T00:00:00Z",
      msdyn_progress: 0.2,
    },
    // child overdue but 100% -> not overdue
    {
      msdyn_projecttaskid: child2,
      _msdyn_parenttask_value: parentId,
      msdyn_finish: "2026-01-03T00:00:00Z",
      msdyn_progress: 1,
    },
    // leaf milestone, future -> milestone but not overdue
    {
      msdyn_projecttaskid: leaf,
      msdyn_ismilestone: true,
      msdyn_finish: "2026-12-01T00:00:00Z",
      msdyn_progress: 0,
    },
  ];

  it("computes summary-aware counts", () => {
    const r = summariseTasks(tasks, NOW);
    expect(r.totalTasks).toBe(4);
    expect(r.summaryTaskCount).toBe(1); // parentId
    expect(r.leafTaskCount).toBe(3);
    expect(r.milestoneCount).toBe(1);
    // only child1 is overdue (parent excluded as summary; child2 is 100%; leaf is future)
    expect(r.overdueLeafTaskCount).toBe(1);
    expect(r.summaryTaskIds.map((s) => s.toLowerCase())).toContain(parentId);
  });

  it("treats a finish in the future as not overdue", () => {
    const r = summariseTasks(
      [{ msdyn_projecttaskid: leaf, msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0 }],
      NOW,
    );
    expect(r.overdueLeafTaskCount).toBe(0);
  });
});
