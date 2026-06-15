import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { verifyAccessToken, TokenValidationError } from "../src/auth.js";

const TENANT = "00000000-0000-0000-0000-000000000000";
const ORG = "https://org12345.crm4.dynamics.com";
const CLIENT = "11111111-1111-1111-1111-111111111111";
const ISS = `https://sts.windows.net/${TENANT}/`;

let sign: (claims: Record<string, unknown>, opts?: { exp?: string }) => Promise<string>;
let keyResolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  keyResolver = createLocalJWKSet({ keys: [jwk] });
  sign = (claims, opts) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setIssuer(ISS)
      .setAudience(ORG)
      .setExpirationTime(opts?.exp ?? "5m")
      .sign(privateKey);
});

const opts = () => ({
  tenantId: TENANT,
  audience: [ORG, ORG + "/"],
  clientId: CLIENT,
  keyResolver,
});

describe("verifyAccessToken", () => {
  it("accepts a valid, correctly-scoped token", async () => {
    const token = await sign({ appid: CLIENT });
    const payload = await verifyAccessToken(token, opts());
    expect(payload.aud).toBe(ORG);
  });

  it("accepts azp instead of appid", async () => {
    const token = await sign({ azp: CLIENT });
    await expect(verifyAccessToken(token, opts())).resolves.toBeTruthy();
  });

  it("rejects a token from a different client app", async () => {
    const token = await sign({ appid: "99999999-9999-9999-9999-999999999999" });
    await expect(verifyAccessToken(token, opts())).rejects.toBeInstanceOf(
      TokenValidationError,
    );
  });

  it("rejects an expired token", async () => {
    const token = await sign({ appid: CLIENT }, { exp: "-1m" });
    await expect(verifyAccessToken(token, opts())).rejects.toBeInstanceOf(
      TokenValidationError,
    );
  });

  it("rejects a wrong audience", async () => {
    const token = await new SignJWT({ appid: CLIENT })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setIssuer(ISS)
      .setAudience("https://evil.example.com")
      .setExpirationTime("5m")
      .sign((await generateKeyPair("RS256")).privateKey);
    await expect(verifyAccessToken(token, opts())).rejects.toBeInstanceOf(
      TokenValidationError,
    );
  });

  it("rejects garbage", async () => {
    await expect(verifyAccessToken("not.a.jwt", opts())).rejects.toBeInstanceOf(
      TokenValidationError,
    );
  });

  it("passes when clientId pin is omitted", async () => {
    const token = await sign({ appid: "anything" });
    await expect(
      verifyAccessToken(token, { ...opts(), clientId: undefined }),
    ).resolves.toBeTruthy();
  });
});
