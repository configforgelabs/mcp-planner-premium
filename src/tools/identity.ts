/**
 * Resolves bookable-resource ids to their underlying user identity (UPN, email,
 * full name) via the proven chain:  bookableresource._userid_value → systemuser.
 *
 * Field names verified live on the CRM4/EU tenant (schema-scout probe):
 *   systemuser.domainname             → UPN  (e.g. user@contoso.onmicrosoft.com)
 *   systemuser.internalemailaddress   → primary email
 *   systemuser.fullname               → display name
 *
 * READ-ONLY and fail-soft: any failure (a generic/non-user bookable resource
 * with no _userid_value, a systemuser the caller can't read, an entity not
 * exposed) degrades to a null UPN/email for that resource — callers still get
 * the team member's display name + resource id. Never throws.
 */
import { dvReq, dvHeaders } from "../dataverse.js";
import { chunkIds } from "./taskAssignments.js";

export interface ResourceIdentity {
  bookableResourceId: string;
  userId: string | null;
  upn: string | null;
  email: string | null;
  fullName: string | null;
}

/** Fail-soft GET: returns the `value` array, or [] on any error/4xx. */
async function safeQuery(url: string): Promise<any[]> {
  try {
    const res = await dvReq({ url, method: "GET", headers: dvHeaders() }, { retry: true });
    if (res.status >= 400) return [];
    return res.json?.value || [];
  } catch {
    return [];
  }
}

/**
 * Maps each bookable-resource id (lowercased key) to its identity. Resources that
 * can't be resolved to a user are returned with null UPN/email rather than omitted,
 * so a caller can always tell "we tried" from "no match".
 */
export async function resolveResourceIdentities(
  base: string,
  resourceIds: string[],
): Promise<Map<string, ResourceIdentity>> {
  const out = new Map<string, ResourceIdentity>();
  const unique = [...new Set(resourceIds.filter(Boolean).map((id) => String(id)))];
  if (unique.length === 0) return out;

  // Seed every requested resource with a null identity (overwritten as resolved).
  for (const id of unique) {
    out.set(id.toLowerCase(), {
      bookableResourceId: id,
      userId: null,
      upn: null,
      email: null,
      fullName: null,
    });
  }

  // Step 1: bookableresource → _userid_value (the systemuser behind the resource).
  const resourceToUser = new Map<string, string>(); // lower(resourceId) → userId
  for (const group of chunkIds(unique)) {
    const filter = group.map((id) => "bookableresourceid eq " + id).join(" or ");
    const rows = await safeQuery(
      base +
        "/bookableresources?$select=bookableresourceid,_userid_value&$filter=" +
        filter +
        "&$top=5000",
    );
    for (const r of rows) {
      const rid = String(r.bookableresourceid).toLowerCase();
      const uid = r._userid_value ?? null;
      if (uid) resourceToUser.set(rid, uid);
    }
  }

  const userIds = [...new Set([...resourceToUser.values()])];
  if (userIds.length === 0) return out;

  // Step 2: systemuser → UPN / email / full name.
  const userInfo = new Map<string, { upn: string | null; email: string | null; fullName: string | null }>();
  for (const group of chunkIds(userIds)) {
    const filter = group.map((id) => "systemuserid eq " + id).join(" or ");
    const rows = await safeQuery(
      base +
        "/systemusers?$select=systemuserid,domainname,internalemailaddress,fullname&$filter=" +
        filter +
        "&$top=5000",
    );
    for (const u of rows) {
      userInfo.set(String(u.systemuserid).toLowerCase(), {
        upn: u.domainname ?? null,
        email: u.internalemailaddress ?? null,
        fullName: u.fullname ?? null,
      });
    }
  }

  // Step 3: join back to each resource.
  for (const [rid, uid] of resourceToUser) {
    const info = userInfo.get(String(uid).toLowerCase());
    const entry = out.get(rid);
    if (entry) {
      entry.userId = uid;
      if (info) {
        entry.upn = info.upn;
        entry.email = info.email;
        entry.fullName = info.fullName;
      }
    }
  }

  return out;
}
