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
  "critical",
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
