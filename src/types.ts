export const AGENT_IDS = ["pm-home", "app", "assistant", "dba"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

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

export interface BoardMessage {
  id: string;
  from_agent: AgentId;
  to_agent: AgentId;
  type: MessageType;
  subject: string;
  body: string;
  ref_id: string | null;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
}
