/**
 * Toolset group → tool-name map.
 *
 * Every registered tool belongs to ≥1 group. The write group also lists one
 * tool name (assign_task) that is not yet registered but will be added in a
 * later wave — listing it here keeps the integration clean and the map-integrity
 * check flags any gap when it lands. The three analytics tools below were
 * registered in this wave and are no longer forward-references.
 *
 * Groups:
 *   reporting  — read-only reporting / list views
 *   discovery  — read-only lookup / identity
 *   sessions   — change-session lifecycle (write/session)
 *   write      — structural write tools
 *   analytics  — curated "insights" subset (overlaps reporting intentionally)
 */
export const TOOLSETS: Record<string, readonly string[]> = {
  reporting: [
    "list_plans",
    "list_my_tasks",
    "get_plan_summary",
    "get_task",
    "list_plan_tasks",
    "get_bucket_breakdown",
    "list_dependencies",
  ],
  discovery: [
    "find_plan_by_name",
    "find_team_member",
    "get_plan_tasks_and_buckets",
    "list_team_members",
    "whoami",
    "describe_option_set",
  ],
  sessions: [
    "start_change_session",
    "apply_changes",
    "check_change_session_status",
    "cancel_change_session",
  ],
  write: [
    "create_plan",
    "add_bucket",
    "add_sprint",
    "add_tasks",
    "add_tasks_batch",
    "update_tasks",
    "update_tasks_batch",
    "delete_tasks_batch",
    // Forward-references — not yet registered; added here for later-wave integration.
    "assign_task",
  ],
  analytics: [
    "get_plan_summary",
    "get_bucket_breakdown",
    "list_dependencies",
    "list_plan_tasks",
    // Registered in the read/analytics wave.
    "get_critical_path",
    "get_schedule_health",
    "get_resource_workload",
  ],
} as const;
