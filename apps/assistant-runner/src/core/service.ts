import type {
  ConversationPatchRequest,
  RunErrorCode,
  RunEvent,
  RunSummary,
  StartRunResponse,
} from '@civitai/components-chat/runner-protocol';

import type { RunGrant } from './interfaces';
import type { StartRequest } from './protocol';

export type StartOutcome =
  | { ok: true; response: StartRunResponse }
  | { ok: false; error: RunErrorCode; message: string; runId?: string };

export interface JournalEntry {
  id: number;
  event: RunEvent;
}

/**
 * What the HTTP layer asks of the runner, always on behalf of an authenticated user id. A grant
 * handed in here has been verified for that user and the request's conversation (and, for a start,
 * its idempotency key).
 */
export interface RunService {
  start(userId: string, request: StartRequest, grant: RunGrant): Promise<StartOutcome>;
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
  /**
   * `false` when the user has no such conversation. `grant`, when the request carried one, is what the
   * store acts with when no run of the conversation holds a grant.
   */
  patch(
    userId: string,
    conversationId: string,
    patch: ConversationPatchRequest,
    grant?: RunGrant
  ): Promise<boolean>;
  ready(): boolean;
}
