import type {
  ConversationPatchRequest,
  RunErrorCode,
  RunEvent,
  RunSummary,
  StartRunRequest,
  StartRunResponse,
} from '@civitai/components-chat/runner-protocol';

export type StartOutcome =
  | { ok: true; response: StartRunResponse }
  | { ok: false; error: RunErrorCode; message: string; runId?: string };

export interface JournalEntry {
  id: number;
  event: RunEvent;
}

/** What the HTTP layer asks of the runner, always on behalf of an authenticated user id. */
export interface RunService {
  start(userId: string, request: StartRunRequest): Promise<StartOutcome>;
  lookup(userId: string, conversationId: string): Promise<RunSummary | null>;
  /** Whether `runId` is a run this user started. */
  owns(userId: string, runId: string): Promise<boolean>;
  /** The run's journal after `after` (from its start when undefined), then each event as it is written, until `run-ended`. */
  events(
    runId: string,
    after: number | undefined,
    signal: AbortSignal
  ): AsyncIterable<JournalEntry>;
  /** `false` when the user has no such run. */
  stop(userId: string, runId: string): Promise<boolean>;
  stopByKey(userId: string, idempotencyKey: string): Promise<void>;
  /** `false` when the user has no such conversation. */
  patch(userId: string, conversationId: string, patch: ConversationPatchRequest): Promise<boolean>;
  ready(): boolean;
}
