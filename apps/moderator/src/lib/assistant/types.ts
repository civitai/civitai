// Shapes the assistant's pages and its server share. Client-safe: types and constants only.

export type TurnStatus = 'running' | 'done' | 'error' | 'capped';
export type PlaybookStatus = 'accepted' | 'proposed' | 'rejected';
export const TOOL_REQUEST_STATUSES = ['open', 'planned', 'built', 'declined'] as const;
export type ToolRequestStatus = (typeof TOOL_REQUEST_STATUSES)[number];

/** One tool call as the audit records it. `rows` is what the tool returned, before any size trim. */
export type TurnToolCall = {
  name: string;
  args: unknown;
  rows: number;
  truncated: boolean;
  ms: number;
  error: string | null;
};

/**
 * A record a tool returned that an answer may cite, as `[ref]` — `[user:123]`. `href` is where the
 * moderator verifies it, worked out by the tool that saw the record, so a citation the tools never
 * returned has nowhere to link.
 */
export type TurnSource = { ref: string; href: string; label: string | null };

/** What the turn endpoint streams, one JSON object per line. */
export type TurnEvent =
  | { type: 'started'; turnId: number }
  | { type: 'tool'; name: string; args: unknown }
  | { type: 'tool-done'; name: string; rows: number; error: string | null; ms: number }
  | {
      type: 'done';
      turnId: number;
      status: TurnStatus;
      answer: string | null;
      error: string | null;
    }
  | { type: 'error'; error: string };
