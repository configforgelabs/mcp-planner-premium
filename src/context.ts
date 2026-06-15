import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context. The bearer is the delegated Dataverse access token that
 * the MCP client (e.g. Langdock's "Advanced OAuth" connector) sends in the
 * inbound `Authorization` header. We forward it unchanged to Dataverse, exactly
 * as the original Langdock actions used `data.auth.access_token`.
 */
export interface RequestContext {
  bearer: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the delegated Dataverse bearer token for the current request. */
export function getBearer(): string {
  const ctx = requestContext.getStore();
  if (!ctx || !ctx.bearer) {
    throw new Error(
      "No access token on this request. The MCP client must send 'Authorization: Bearer <token>'. " +
        "In Langdock, configure the connection as Advanced OAuth and add the custom header " +
        "'Authorization: Bearer {{ access_token }}'.",
    );
  }
  return ctx.bearer;
}
