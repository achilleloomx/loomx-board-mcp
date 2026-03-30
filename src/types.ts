export const AGENT_SLUGS = ["pm-home", "app", "assistant", "dba"] as const;
export type AgentSlug = (typeof AGENT_SLUGS)[number];

export const MESSAGE_TYPES = [
  "task",
  "question",
  "blocker",
  "done",
  "alignment_issue",
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
  slug: AgentSlug;
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
  ref_id: string | null;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
}

export interface AgentRegistry {
  selfCode: string;
  selfSlug: AgentSlug;
  slugToCode: Map<string, string>;
  codeToSlug: Map<string, string>;
}
