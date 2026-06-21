/**
 * Process-lifetime capability cache for extended Dataverse task fields.
 *
 * Both get_task and list_plan_tasks probe for the Project Operations-only
 * extended fields (msdyn_remainingeffort, msdyn_duration, msdyn_actualstart,
 * msdyn_actualfinish). Without a cache, every call on a tenant that lacks them
 * pays a wasted 400 round-trip per invocation.
 *
 * The server is single-tenant per process (DATAVERSE_ORG_URL is fixed in env),
 * so a module-scoped cache is tenant-scoped by construction. A schema capability
 * is stable within a single Dataverse deployment — we document that a process
 * restart is required if the tenant schema changes (extremely rare in practice).
 *
 * Concurrency note: two in-flight first-calls may both probe and write the same
 * value. Last-writer-wins; since the value is identical from both probes, this
 * is benign. No locking is needed.
 */

export type Capability = "present" | "absent" | "unknown";

/**
 * Shared literal — the four Project-Operations-only task fields.
 * All tools that probe these fields must import this constant; never hardcode the
 * string in multiple places. Keeping one authoritative literal ensures the probe
 * url, the select string, and the cache all stay in sync.
 */
export const EXTENDED_TASK_FIELDS =
  "msdyn_remainingeffort,msdyn_duration,msdyn_actualstart,msdyn_actualfinish";

/**
 * Detects the get_task-style "extended field not present" 400.
 * Pure function — no I/O, no side effects. Used to standardise the probe check
 * across getTask.ts, listPlanTasks.ts, and getResourceWorkload.ts so the
 * detection logic is in one place.
 */
export function isMissingPropertyError(status: number, message: string): boolean {
  return status === 400 && /could not find a property named/i.test(message);
}

// Module-scoped cache: unknown until the first probe succeeds or fails.
let _cap: Capability = "unknown";

/** Returns the current cached capability state. Default "unknown". */
export function getExtendedTaskFieldsCapability(): Capability {
  return _cap;
}

/** Records the outcome of a probe. Called by handlers after a network probe. */
export function setExtendedTaskFieldsCapability(c: "present" | "absent"): void {
  _cap = c;
}

/**
 * Resets the cache to "unknown".
 * For unit tests only — mirrors resetEnvCache() from config.ts so tests can
 * restore a clean slate in afterEach without leaking state between test cases.
 * Not part of the public production API.
 */
export function resetCapabilities(): void {
  _cap = "unknown";
}
