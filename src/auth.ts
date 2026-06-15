import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

/**
 * Minimal inbound-token validation (the "token control" hardening).
 *
 * The token Langdock forwards is a delegated Dataverse access token (its `aud`
 * is the Dataverse org, NOT this server). We do not turn this server into a full
 * OAuth resource server; we defensively verify the token we are about to relay:
 *   - signature, against Microsoft Entra's published JWKS (proves Entra issued it);
 *   - `exp`/`nbf` (not expired);
 *   - `iss` is our tenant's Entra (v1 sts.windows.net or v2 login.microsoftonline.com);
 *   - `aud` is our Dataverse org;
 *   - optionally `appid`/`azp` equals our Langdock app registration (pins the caller).
 *
 * This rejects forged/expired/foreign-tenant/foreign-app tokens before any
 * Dataverse call. It does NOT fully close the confused-deputy gap (the token's
 * audience is still Dataverse) - that needs the resource-server + On-Behalf-Of
 * design, documented as a future milestone.
 */
export interface VerifyOptions {
  tenantId: string;
  audience: string[];
  /** When set, the token's appid/azp must equal this client id. */
  clientId?: string;
  /** Injectable key resolver (tests pass a local key set). */
  keyResolver?: JWTVerifyGetKey;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(tenantId: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(tenantId);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      ),
    );
    jwksCache.set(tenantId, jwks);
  }
  return jwks;
}

export class TokenValidationError extends Error {}

export async function verifyAccessToken(
  token: string,
  opts: VerifyOptions,
): Promise<JWTPayload> {
  const keyResolver = opts.keyResolver ?? jwksFor(opts.tenantId);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keyResolver, {
      issuer: [
        `https://login.microsoftonline.com/${opts.tenantId}/v2.0`,
        `https://sts.windows.net/${opts.tenantId}/`,
      ],
      audience: opts.audience,
      algorithms: ["RS256"],
    }));
  } catch (e: unknown) {
    throw new TokenValidationError(
      "Token verification failed: " + (e instanceof Error ? e.message : String(e)),
    );
  }

  if (opts.clientId) {
    const appid = (payload.appid ?? (payload as Record<string, unknown>).azp) as
      | string
      | undefined;
    if (appid !== opts.clientId) {
      throw new TokenValidationError(
        "Token was issued to a different application than expected.",
      );
    }
  }

  return payload;
}
