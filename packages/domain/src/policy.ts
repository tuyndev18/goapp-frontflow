/** Spec §22.2 */
export const PERMISSION_CLASSES = [
  "read_project",
  "write_project",
  "run_project_command",
  "git_mutation",
  "network_access",
  "read_external_design",
  "export_asset",
  "destructive_action",
] as const;
export type PermissionClass = (typeof PERMISSION_CLASSES)[number];

export type PolicyDecision =
  | { effect: "allow"; reason: string }
  | { effect: "deny"; reason: string }
  | { effect: "require_approval"; reason: string };
