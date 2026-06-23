import { z } from "zod";
import { getApiBase } from "../config.js";
import { pageAll, readHeaders } from "./readHelpers.js";
import { queryByIds } from "./taskAssignments.js";
import { resolveResourceIdentities } from "./identity.js";
import type { ToolDef } from "./types.js";

/**
 * find_team_member_across_plans — resolve a person by display name across EVERY
 * plan in one call, instead of looping find_team_member per plan.
 *
 * How it works (all reads, schema verified live on the CRM4 tenant):
 *   1. Query msdyn_projectteams with NO project filter, OData
 *      contains(msdyn_name,'<name>') — one paged scan returns every team row whose
 *      display name matches, across all plans (truncated flag if the scan caps out).
 *   2. Group the rows by bookableResourceId so the SAME person on N plans collapses
 *      to ONE entry carrying the list of plans they're on (each with its
 *      teamMemberId/projectteamid for that plan, needed to assign within it).
 *   3. Resolve each distinct person's UPN / email / full name via the bookable
 *      resource → systemuser chain (resolveResourceIdentities).
 *   4. Resolve plan display names via a batched msdyn_projects lookup.
 *   5. Flag exact display-name matches and emit a disambiguation hint — never pick
 *      silently when several distinct people match.
 */
export const findTeamMemberAcrossPlans: ToolDef = {
  name: "find_team_member_across_plans",
  title: "Find Team Member (all plans)",
  description:
    "Searches EVERY plan for project team members whose display name matches `name` (partial, case-insensitive), in a single call. Groups results by person (bookableResourceId) so someone on several plans appears once, with the list of plans they belong to (each plan carries its own teamMemberId for assignments). Each person includes upn, email and fullName so two people sharing a display name can be told apart. Use this to answer 'which tasks does <name> have?' — take the matched person's bookableResourceId and pass it to list_user_tasks. If several distinct people match, ask the user which one; never guess. truncated=true means the plan scan hit its cap and the result is incomplete.",
  inputSchema: {
    name: z
      .string()
      .describe("Full or partial display name to search for across all plans, e.g. 'Marcin'."),
  },
  handler: async (input: { name: string }) => {
    const BASE = getApiBase();
    const name = (input.name || "").trim();
    if (!name) throw new Error("name is required (full or partial display name).");
    const safe = name.replace(/'/g, "''");

    // 1. One paged scan across all plans' team rows matching the name.
    const url =
      BASE +
      "/msdyn_projectteams?$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value,_msdyn_project_value" +
      "&$filter=contains(msdyn_name,'" +
      encodeURIComponent(safe) +
      "')";
    const paged = await pageAll(url, readHeaders());
    const rows = paged.rows;

    // 2. Group by person (bookableResourceId). Rows without a resource id (rare,
    //    e.g. a generic resource) are keyed by their own team-row id so they are
    //    still surfaced rather than silently merged.
    const target = name.toLowerCase();
    interface PlanRef { projectId: string | null; teamMemberId: string; planName: string | null }
    interface Person {
      name: string;
      bookableResourceId: string | null;
      exactMatch: boolean;
      plans: PlanRef[];
    }
    const byPerson = new Map<string, Person>();
    const projectIds = new Set<string>();
    for (const r of rows) {
      const resourceId: string | null = r._msdyn_bookableresourceid_value ?? null;
      const key = resourceId ? "r:" + String(resourceId).toLowerCase() : "t:" + r.msdyn_projectteamid;
      const projectId: string | null = r._msdyn_project_value ?? null;
      if (projectId) projectIds.add(projectId);
      let person = byPerson.get(key);
      if (!person) {
        person = {
          name: r.msdyn_name,
          bookableResourceId: resourceId,
          exactMatch:
            typeof r.msdyn_name === "string" && r.msdyn_name.trim().toLowerCase() === target,
          plans: [],
        };
        byPerson.set(key, person);
      }
      person.plans.push({ projectId, teamMemberId: r.msdyn_projectteamid, planName: null });
    }

    // 3. Resolve UPN / email / full name per distinct person (fail-soft).
    const resourceIds = [...byPerson.values()]
      .map((p) => p.bookableResourceId)
      .filter((x): x is string => !!x);
    const identities = await resolveResourceIdentities(BASE, resourceIds);

    // 4. Resolve plan display names (batched). Fail-soft → names stay null.
    const planNames = new Map<string, string>();
    if (projectIds.size > 0) {
      try {
        const projectRows = await queryByIds(
          BASE,
          "msdyn_projects",
          "msdyn_projectid",
          [...projectIds],
          "$select=msdyn_projectid,msdyn_subject",
          "find_team_member_across_plans",
        );
        for (const p of projectRows) planNames.set(String(p.msdyn_projectid).toLowerCase(), p.msdyn_subject);
      } catch {
        // leave plan names null
      }
    }

    // 5. Assemble, attach identities + plan names, sort exact matches first.
    const people = [...byPerson.values()].map((p) => {
      const id = p.bookableResourceId
        ? identities.get(String(p.bookableResourceId).toLowerCase())
        : undefined;
      return {
        name: p.name,
        bookableResourceId: p.bookableResourceId,
        upn: id?.upn ?? null,
        email: id?.email ?? null,
        fullName: id?.fullName ?? null,
        exactMatch: p.exactMatch,
        planCount: p.plans.length,
        plans: p.plans.map((pl) => ({
          projectId: pl.projectId,
          planName: pl.projectId ? planNames.get(pl.projectId.toLowerCase()) ?? null : null,
          teamMemberId: pl.teamMemberId,
        })),
      };
    });
    people.sort((a, b) => (a.exactMatch === b.exactMatch ? 0 : a.exactMatch ? -1 : 1));

    const exactCount = people.filter((p) => p.exactMatch).length;
    let hint: string;
    if (people.length === 0)
      hint = "No team member matched across any plan - the person may not be on any plan team yet.";
    else if (people.length === 1) hint = "Unique person - use this bookableResourceId with list_user_tasks.";
    else if (exactCount === 1)
      hint = "One exact display-name match - likely the intended person, but confirm via upn/email if unsure.";
    else hint = "Multiple distinct people match - ask the user which one (compare upn/email); never pick silently.";

    return {
      ok: true,
      query: name,
      count: people.length,
      exactMatchCount: exactCount,
      truncated: paged.truncated,
      people,
      hint,
    };
  },
};
