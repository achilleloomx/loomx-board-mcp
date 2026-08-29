export const MESSAGE_TYPES = [
  "task",
  "question",
  "blocker",
  "done",
  "alignment_issue",
  "info",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = [
  "pending",
  "acknowledged",
  "in_progress",
  "done",
  "cancelled",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export interface BoardAgent {
  agent_code: string;
  slug: string;
  label: string;
  nickname: string | null;
  active: boolean;
}

export interface BoardMessage {
  id: string;
  from_agent: string;
  to_agent: string;
  type: MessageType;
  subject: string;
  body: string;
  summary: string | null;
  tags: string[];
  ref_id: string | null;
  status: MessageStatus;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRegistry {
  selfCode: string;
  selfSlug: string;
  slugToCode: Map<string, string>;
  codeToSlug: Map<string, string>;
}

// --- GTD (loomx_items) ---

export const GTD_STATUSES = [
  "inbox",
  "next_action",
  "waiting",
  "scheduled",
  "someday",
  "in_progress",
  "done",
  "trash",
] as const;
export type GtdStatus = (typeof GTD_STATUSES)[number];

export const GTD_PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;
export type GtdPriority = (typeof GTD_PRIORITIES)[number];

// --- Home (home_* tables — family data) ---

export const MEAL_TYPES = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const MENU_STATUSES = ["draft", "approved"] as const;
export type MenuStatus = (typeof MENU_STATUSES)[number];

export const SCHOOL_MENU_SOURCES = ["manual", "scraper"] as const;
export type SchoolMenuSource = (typeof SCHOOL_MENU_SOURCES)[number];

// --- Work Items (loomx_work_items — governance-compliance D-024) ---

export const WI_STATUSES = [
  "active",
  "paused",
  "done",
  "emergency",
  "exempt",
  "failed",
  // D-135 (migration 20260828140000): entered by wi_end(status='escalated').
  // escalation_pending is terminal for the operator at the DB level (trigger
  // loomx_wi_escalation_pending_terminal) — the only legitimate write from
  // there is the DB-side promotion to 'escalated' via loomx_wi_promote_to_escalated.
  "escalation_pending",
  "escalated",
] as const;
export type WiStatus = (typeof WI_STATUSES)[number];

export const WI_END_STATUSES = ["done", "failed", "waiting", "escalated"] as const;
export type WiEndStatus = (typeof WI_END_STATUSES)[number];

export const WI_TEMPLATE_LAYERS = ["L1", "L2", "on-the-fly"] as const;
export type WiTemplateLayer = (typeof WI_TEMPLATE_LAYERS)[number];

// --- Agent Runtime (loomx_agent_runtime — control-plane) ---

export const RUNTIME_REQUEST_TYPES = ["continue", "clear", "kill", "model", "none"] as const;
export type RuntimeRequestType = (typeof RUNTIME_REQUEST_TYPES)[number];

// --- Wake priority (board_messages.wake_priority — cross-agent cold-start marker, D-093) ---
// Supersedes the separate-table `loomx_agent_pings` design (dropped, never populated,
// flag-OFF). A "ping" is now just a board_send carrying this marker; NULL = normal
// message, unchanged behavior. See hub/it-manager/design/ping-cold-start.md.

export const WAKE_PRIORITIES = ["normal", "high", "urgent"] as const;
export type WakePriority = (typeof WAKE_PRIORITIES)[number];

export interface WorkItem {
  id: string;
  gtd_item_id: string;
  agent_slug: string;
  template_name: string | null;
  template_version: string | null;
  template_layer: WiTemplateLayer | null;
  intent: string;
  pre_conditions: Record<string, unknown>;
  in_flight_state: {
    files_touched?: string[];
    tool_uses?: number;
    notes?: string[];
    [k: string]: unknown;
  };
  post_conditions_state: Record<string, unknown>;
  side_effects_log: unknown[];
  status: WiStatus;
  emergency_reason: string | null;
  exempt_reason: string | null;
  failure_reason: string | null;
  started_at: string;
  ended_at: string | null;
  last_checkpoint_at: string;
  session_id: string | null;
}
