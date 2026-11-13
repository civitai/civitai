import { INBOX_LIMIT } from '$lib/message-as-civitai';
import { callModEndpoint, readModEndpoint, type JsonResult } from './user-actions.service';

// Messaging a user as the shared Civitai Moderation account. Every write goes through the main app's
// `/api/mod/*` endpoints as the acting moderator, which own the grant, the claim, the cap and the audit row.

export type InboxThread = {
  chatId: number;
  userId: number;
  username: string | null;
  lastMessage: string;
  lastMessageAt: string;
  lastMessageFromCivitai: boolean;
  claimedBy: number | null;
  claimedByUsername: string | null;
  claimExpiresAt: string | null;
};

export type ThreadMessage = {
  id: number;
  fromCivitai: boolean;
  content: string;
  createdAt: string;
  sentById: number | null;
  sentByUsername: string | null;
};

export type Thread = {
  chatId: number | null;
  claim: { moderatorId: number; username: string | null; expiresAt: string } | null;
  messages: ThreadMessage[];
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const unwrap = <T>(result: JsonResult, pick: (body: Record<string, unknown>) => T): Result<T> =>
  result.ok ? { ok: true, value: pick(result.body) } : { ok: false, error: result.error };

export async function sendAsCivitai(input: {
  userId: number;
  message: string;
  idempotencyKey: string;
  context?: { reportId?: number };
}): Promise<Result<{ chatId: number; messageId: number; deduped: boolean }>> {
  return unwrap(
    await callModEndpoint('user/message-as-civitai', input, 'Message as Civitai'),
    (body) => body as { chatId: number; messageId: number; deduped: boolean }
  );
}

export async function claimThread(userId: number) {
  return unwrap(
    await callModEndpoint('messages/claim', { userId }, 'Claim thread'),
    (body) => body as { claimed: boolean; moderatorId: number; expiresAt: string }
  );
}

export async function releaseThread(userId: number) {
  return unwrap(await callModEndpoint('messages/release', { userId }, 'Release thread'), (body) =>
    Boolean(body.released)
  );
}

export async function getInbox(awaitingOnly: boolean): Promise<Result<InboxThread[]>> {
  return unwrap(
    await readModEndpoint(
      'messages/inbox',
      { awaitingOnly: String(awaitingOnly), limit: INBOX_LIMIT },
      'Inbox'
    ),
    (body) => (body.threads as InboxThread[]) ?? []
  );
}

export async function getThread(userId: number): Promise<Result<Thread>> {
  return unwrap(
    await readModEndpoint('messages/thread', { userId }, 'Thread'),
    (body) => body as unknown as Thread
  );
}
