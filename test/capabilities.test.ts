import { describe, it, expect, afterEach } from "vitest";
import {
  isMissingPropertyError,
  getExtendedTaskFieldsCapability,
  setExtendedTaskFieldsCapability,
  resetCapabilities,
  EXTENDED_TASK_FIELDS,
} from "../src/tools/capabilities.js";

afterEach(() => {
  // Always reset so cached state never leaks between test cases.
  resetCapabilities();
});

describe("isMissingPropertyError", () => {
  it("returns true for a 400 with the 'could not find a property named' message", () => {
    expect(
      isMissingPropertyError(400, "Could not find a property named 'msdyn_duration'."),
    ).toBe(true);
  });

  it("is case-insensitive on the error message", () => {
    expect(
      isMissingPropertyError(400, "could not find a property named 'msdyn_remainingeffort'"),
    ).toBe(true);
    expect(
      isMissingPropertyError(400, "COULD NOT FIND A PROPERTY NAMED 'x'"),
    ).toBe(true);
  });

  it("returns false for a 400 with a different error message", () => {
    expect(isMissingPropertyError(400, "some other 400 error")).toBe(false);
    expect(isMissingPropertyError(400, "HTTP 400")).toBe(false);
  });

  it("returns false for non-400 status codes, even with the matching message", () => {
    expect(
      isMissingPropertyError(404, "Could not find a property named 'msdyn_duration'."),
    ).toBe(false);
    expect(
      isMissingPropertyError(500, "Could not find a property named 'msdyn_duration'."),
    ).toBe(false);
    expect(
      isMissingPropertyError(200, "Could not find a property named 'msdyn_duration'."),
    ).toBe(false);
  });
});

describe("capability cache lifecycle", () => {
  it("defaults to 'unknown' before any set", () => {
    expect(getExtendedTaskFieldsCapability()).toBe("unknown");
  });

  it("returns 'present' after setExtendedTaskFieldsCapability('present')", () => {
    setExtendedTaskFieldsCapability("present");
    expect(getExtendedTaskFieldsCapability()).toBe("present");
  });

  it("returns 'absent' after setExtendedTaskFieldsCapability('absent')", () => {
    setExtendedTaskFieldsCapability("absent");
    expect(getExtendedTaskFieldsCapability()).toBe("absent");
  });

  it("returns 'unknown' after resetCapabilities()", () => {
    setExtendedTaskFieldsCapability("present");
    expect(getExtendedTaskFieldsCapability()).toBe("present");
    resetCapabilities();
    expect(getExtendedTaskFieldsCapability()).toBe("unknown");
  });

  it("allows overwriting an existing value (last-write-wins, benign under concurrent probes)", () => {
    setExtendedTaskFieldsCapability("present");
    setExtendedTaskFieldsCapability("absent");
    expect(getExtendedTaskFieldsCapability()).toBe("absent");
  });
});

describe("EXTENDED_TASK_FIELDS constant", () => {
  it("contains all four expected extended field names", () => {
    expect(EXTENDED_TASK_FIELDS).toContain("msdyn_remainingeffort");
    expect(EXTENDED_TASK_FIELDS).toContain("msdyn_duration");
    expect(EXTENDED_TASK_FIELDS).toContain("msdyn_actualstart");
    expect(EXTENDED_TASK_FIELDS).toContain("msdyn_actualfinish");
  });
});
