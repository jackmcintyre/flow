/**
 * BMad lifecycle vocabulary and its mapping to the plugin's execution
 * state. See `plugins/flow/docs/spikes/bmad-format.md`.
 */
export type BmadStatus =
  | "backlog"
  | "ready-for-dev"
  | "in-progress"
  | "done"
  | "optional"
  | "contexted"
  | "draft"
  | "approved"
  | "review";

export type ExecutionState = "to-do" | "in-progress" | "blocked" | "done";

/**
 * Map a BMad status string to the plugin's execution-state vocabulary.
 * `optional` returns `null` to signal "skip this story".
 */
export function mapBmadStatusToExecution(status: BmadStatus): ExecutionState | null {
  switch (status) {
    case "backlog":
      return "to-do";
    case "ready-for-dev":
      return "to-do";
    case "in-progress":
      return "in-progress";
    case "done":
      return "done";
    case "optional":
      return null;
    case "contexted":
      return "to-do";
    case "draft":
      return "to-do";
    case "approved":
      return "to-do";
    case "review":
      return "in-progress";
  }
}
