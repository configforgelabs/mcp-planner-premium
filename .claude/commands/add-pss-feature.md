---
description: Add a Planner-Premium / PSS capability the proven way — discover live schema (Opus) → implement + test (Sonnet) → audit. Avoids the documented PSS footguns.
---

Add the capability: **$ARGUMENTS**

This server talks ONLY to Dataverse/PSS, where guessing field names, bind casing,
or what is API-creatable wastes hours. Follow this discover-first flow. Read
`docs/PSS-IMPLEMENTATION-LESSONS.md` before starting.

## 1. Discover + prove (Opus) — REQUIRED before any code

Launch the **pss-schema-scout** subagent for "$ARGUMENTS". It must return:
exact field names, `@odata.bind` nav-property casing, blocked-on-create fields,
any name→id resolution needed, the EU/global link-type note if relevant, and a
**minimal payload it actually persisted live**. If the scout finds the capability
is not API-possible (e.g. label creation, milestone flag, Teams-backed comments),
stop and report that — do not try to force it.

Do not proceed until you have a proven payload. Guessing is what breaks here.

## 2. Implement + test (Sonnet)

Launch the **pss-feature-implementer** subagent with the scout's spec. It edits
the pure builder / adds the tool, mirrors the existing
checklist/sprint/labels/assignees patterns, keeps every guardrail (making any
falsely-triggering guard entity-aware, never weaker), unit-tests the builder,
runs `npm run typecheck && npm test`, and live-verifies with a throwaway script.

For independent capabilities you can run multiple implementer agents in parallel;
serialise anything that edits the same file (`addTasksSimple.ts`).

## 3. Audit + verify

- Launch **guardrail-auditor** on the pending diff.
- Run `/verify` (typecheck + tests). Both green.
- Update `README.md` (tool table / Open TODOs / `add_tasks` description).

## 4. Finish

On a feature branch, summarise: the capability, whether it's full / assign-only /
not-possible, the guardrails preserved, tests added, and the live-verify result.
Let the human review before pushing. If you learned a new PSS gotcha, add it to
`docs/PSS-IMPLEMENTATION-LESSONS.md`.
