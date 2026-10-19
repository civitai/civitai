import type { Generated, Timestamp } from '../moderator-db/types';
import type {
  PlaybookStatus,
  ToolRequestStatus,
  TurnSource,
  TurnStatus,
  TurnToolCall,
} from '$lib/assistant/types';

/**
 * The mod assistant's tables, declared here rather than in the generated `moderator-db/types.ts` for
 * the reason `abuse-detection-tables.ts` gives: that file mirrors the database, and these are
 * hand-designed and hand-applied (`apps/moderator/assistant/schema.sql`). `withTables` adds them to the
 * shared client's type without a second connection.
 */
export type AssistantTables = {
  assistant_chat: {
    id: Generated<number>;
    moderator_id: number;
    title: string;
    seed_user_id: number | null;
    seed_report_id: number | null;
    mask_salt: Generated<string>;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
    archived_at: Timestamp | null;
  };
  assistant_turn: {
    id: Generated<number>;
    chat_id: number;
    moderator_id: number;
    prompt: string;
    playbook_slug: string | null;
    playbook_version: number | null;
    status: Generated<TurnStatus>;
    tool_calls: Generated<TurnToolCall[]>;
    sources: Generated<TurnSource[]>;
    answer: string | null;
    unverified: Generated<string[]>;
    error: string | null;
    model: string;
    prompt_tokens: Generated<number>;
    completion_tokens: Generated<number>;
    total_tokens: Generated<number>;
    created_at: Generated<Timestamp>;
    finished_at: Timestamp | null;
  };
  assistant_playbook: {
    id: Generated<number>;
    slug: string;
    created_at: Generated<Timestamp>;
    archived_at: Timestamp | null;
  };
  assistant_playbook_version: {
    playbook_id: number;
    version: number;
    title: string;
    summary: string;
    body: string;
    status: PlaybookStatus;
    note: string | null;
    author_id: number;
    proposed_by_assistant: Generated<boolean>;
    source_turn_id: number | null;
    created_at: Generated<Timestamp>;
    reviewed_by: number | null;
    reviewed_at: Timestamp | null;
  };
  assistant_tool_request: {
    id: Generated<number>;
    chat_id: number;
    turn_id: number | null;
    moderator_id: number;
    need: string;
    reason: string;
    example: string | null;
    conversation: Generated<{ prompt: string; answer: string | null }[]>;
    status: Generated<ToolRequestStatus>;
    response: string | null;
    created_at: Generated<Timestamp>;
    resolved_at: Timestamp | null;
  };
};
