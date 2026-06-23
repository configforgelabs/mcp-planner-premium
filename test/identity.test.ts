import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { resolveResourceIdentities } from "../src/tools/identity.js";

const ORG = "https://org12345.crm4.dynamics.com";
const BASE = ORG + "/api/data/v9.2";
const RES = "00000000-0000-0000-0000-0000000000bb";
const USER = "00000000-0000-0000-0000-0000000000aa";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("resolveResourceIdentities", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("resolves UPN / email / full name via bookableresource → systemuser", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/bookableresources"))
        return jsonRes({ value: [{ bookableresourceid: RES, _userid_value: USER }] });
      if (url.includes("/systemusers"))
        return jsonRes({ value: [{ systemuserid: USER, domainname: "marcin@opsora.io", internalemailaddress: "marcin@opsora.io", fullname: "Marcin Baluta" }] });
      return jsonRes({ value: [] });
    });
    const map = await withBearer(() => resolveResourceIdentities(BASE, [RES]));
    const id = map.get(RES.toLowerCase());
    expect(id?.upn).toBe("marcin@opsora.io");
    expect(id?.email).toBe("marcin@opsora.io");
    expect(id?.fullName).toBe("Marcin Baluta");
    expect(id?.userId).toBe(USER);
  });

  it("degrades to null UPN/email when the systemuser lookup fails (fail-soft, no throw)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/bookableresources"))
        return jsonRes({ value: [{ bookableresourceid: RES, _userid_value: USER }] });
      if (url.includes("/systemusers")) return jsonRes({ error: "boom" }, 403);
      return jsonRes({ value: [] });
    });
    const map = await withBearer(() => resolveResourceIdentities(BASE, [RES]));
    const id = map.get(RES.toLowerCase());
    expect(id?.userId).toBe(USER); // resource→user resolved
    expect(id?.upn).toBeNull();    // user→UPN failed, but no throw
    expect(id?.email).toBeNull();
  });

  it("returns a null identity (not omitted) for a resource with no linked user", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/bookableresources"))
        return jsonRes({ value: [{ bookableresourceid: RES, _userid_value: null }] });
      return jsonRes({ value: [] });
    });
    const map = await withBearer(() => resolveResourceIdentities(BASE, [RES]));
    expect(map.has(RES.toLowerCase())).toBe(true);
    expect(map.get(RES.toLowerCase())?.upn).toBeNull();
  });

  it("returns an empty map for no input", async () => {
    const map = await withBearer(() => resolveResourceIdentities(BASE, []));
    expect(map.size).toBe(0);
  });
});
