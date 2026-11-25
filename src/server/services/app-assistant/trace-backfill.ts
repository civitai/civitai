import { chosenAppOf, type ToolResult } from '@civitai/app-assistant';
import type { PrismaClient } from '@prisma/client';

/**
 * The backfill's matcher (`scripts/backfill-app-assistant-traces.ts`): for a publish request that
 * predates session tracing, which of its submitter's App Assistant chats chose the request's app.
 * A chat counts when any call the gate reads as choosing an app (`chosenAppOf`: a `create_app` that
 * made it, a `use_open_app` or `wake_app` that opened it) answered with the slug. Pure.
 */

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object';

/** A saved tool output as the tool returned it (the chat saves `{ type: 'json', value }`). */
function unwrap(output: unknown): { output: unknown; isError: boolean } {
  if (!isRec(output) || typeof output.type !== 'string') return { output, isError: false };
  if (output.type === 'json' || output.type === 'text')
    return {
      output: output.value,
      isError: isRec(output.value) && output.value.error !== undefined,
    };
  return {
    output: output.value,
    isError: output.type.startsWith('error') || output.type === 'execution-denied',
  };
}

/** Every finished tool call a saved chat holds, as the gate reads results. */
export function toolResultsOfChat(chat: unknown): ToolResult[] {
  const results: ToolResult[] = [];
  const turns = isRec(chat) && Array.isArray(chat.turns) ? chat.turns : [];
  for (const turn of turns) {
    const messages =
      isRec(turn) && isRec(turn.assistant) && Array.isArray(turn.assistant.messages)
        ? (turn.assistant.messages as unknown[])
        : [];
    const outputs = new Map<string, ReturnType<typeof unwrap>>();
    for (const message of messages)
      if (isRec(message) && message.role === 'tool' && Array.isArray(message.content))
        for (const part of message.content)
          if (isRec(part) && part.type === 'tool-result' && typeof part.toolCallId === 'string')
            outputs.set(part.toolCallId, unwrap(part.output));
    for (const message of messages)
      if (isRec(message) && message.role === 'assistant' && Array.isArray(message.content))
        for (const part of message.content) {
          if (!isRec(part) || part.type !== 'tool-call' || typeof part.toolName !== 'string')
            continue;
          const done = outputs.get(String(part.toolCallId));
          if (!done) continue;
          results.push({
            name: part.toolName,
            input: part.input,
            output: done.output,
            isError: done.isError,
          } as ToolResult);
        }
  }
  return results;
}

/** Whether a saved chat ever chose `slug`. */
export function chatChoseApp(chat: unknown, slug: string): boolean {
  return toolResultsOfChat(chat).some((result) => chosenAppOf(result) === slug);
}

/** The ids of the chats among `chats` that chose `slug`, in order, once each. */
export function conversationsChoosing(
  chats: ReadonlyArray<{ conversationId: string }>,
  slug: string
): string[] {
  const ids: string[] = [];
  for (const chat of chats)
    if (!ids.includes(chat.conversationId) && chatChoseApp(chat, slug))
      ids.push(chat.conversationId);
  return ids;
}

export interface BackfillRequest {
  id: string;
  slug: string;
  submittedByUserId: number;
  bundleKey: string;
}

export interface BackfillOptions {
  apply: boolean;
  /** The most requests one run looks at. */
  limit: number;
  /** Resume after this request (the previous run's last `next:` line). */
  before?: string;
  /** Also re-trace requests whose trace froze no chat (submitted before the links existed). */
  includeEmpty: boolean;
}

export interface BackfillDeps {
  /**
   * The next page of requests to look at, newest first by (submittedAt, id), strictly after
   * `after` when given: those with no trace, and with `includeEmpty` those whose trace froze no chat.
   */
  page(options: {
    after?: string;
    take: number;
    includeEmpty: boolean;
  }): Promise<BackfillRequest[]>;
  /** The submitter's chats, or why they cannot be read. */
  chatsOf(userId: number): Promise<Array<{ conversationId: string }> | string>;
  /** Freezes the chats and writes (or, for an empty trace, replaces) the trace; null = not written. */
  trace(
    request: BackfillRequest,
    conversationIds: string[]
  ): Promise<{ snapshotError: string | null } | null>;
  log(line: string): void;
}

export const BACKFILL_PAGE = 50;

/**
 * The backfill run (`scripts/backfill-app-assistant-traces.ts`). Pages through requests newest
 * first with a cursor, so a request it skips (its submitter's chats cannot be read) never holds a
 * later run back: each run ends by printing the cursor to resume from. One request that fails is
 * logged and the run goes on. Dry run unless `apply`.
 */
export async function runTraceBackfill(options: BackfillOptions, deps: BackfillDeps) {
  const summary = { seen: 0, traced: 0, skipped: 0, failed: 0, next: null as string | null };
  const chatsByUser = new Map<number, Array<{ conversationId: string }> | string>();
  let after = options.before;
  while (summary.seen < options.limit) {
    const take = Math.min(BACKFILL_PAGE, options.limit - summary.seen);
    const requests = await deps.page({ after, take, includeEmpty: options.includeEmpty });
    if (requests.length === 0) break;
    for (const request of requests) {
      summary.seen++;
      after = request.id;
      summary.next = request.id;
      const where = `${request.id} ${request.slug} user ${request.submittedByUserId}`;
      try {
        let chats = chatsByUser.get(request.submittedByUserId);
        if (chats === undefined) {
          chats = await deps.chatsOf(request.submittedByUserId);
          chatsByUser.set(request.submittedByUserId, chats);
        }
        if (typeof chats === 'string') {
          summary.skipped++;
          deps.log(`${where}: skipped (${chats})`);
          continue;
        }
        const conversationIds = conversationsChoosing(chats, request.slug);
        deps.log(`${where}: ${conversationIds.length} chats`);
        if (!options.apply) continue;
        const result = await deps.trace(request, conversationIds);
        if (result) summary.traced++;
        else summary.failed++;
        deps.log(
          `  ${result ? 'traced' : 'NOT written'}${
            result?.snapshotError ? `: ${result.snapshotError}` : ''
          }`
        );
      } catch (err) {
        summary.failed++;
        deps.log(`${where}: FAILED (${(err as Error)?.message ?? err}), going on`);
      }
    }
    if (requests.length < take) {
      summary.next = null;
      break;
    }
  }
  deps.log(
    `${options.apply ? 'APPLY' : 'DRY RUN'}: seen ${summary.seen}, traced ${
      summary.traced
    }, skipped ${summary.skipped}, failed ${summary.failed}`
  );
  deps.log(
    summary.next ? `next: --before ${summary.next}` : 'next: none (reached the oldest request)'
  );
  return summary;
}

/** The backfill's page of requests (`BackfillDeps.page`), with the run's own filters. */
export function backfillPage(
  db: Pick<PrismaClient, 'appBlockPublishRequest'>,
  {
    after,
    take,
    includeEmpty,
    filters = {},
  }: {
    after?: string;
    take: number;
    includeEmpty: boolean;
    filters?: { id?: string; slug?: string; since?: Date };
  }
): Promise<BackfillRequest[]> {
  return db.appBlockPublishRequest.findMany({
    where: {
      OR: [
        { assistantTrace: null },
        ...(includeEmpty ? [{ assistantTrace: { conversationIds: { isEmpty: true } } }] : []),
      ],
      // A deleted account's traces were deleted with it: the backfill must not bring them back.
      submittedBy: { deletedAt: null },
      ...(filters.id ? { id: filters.id } : {}),
      ...(filters.slug ? { slug: filters.slug } : {}),
      ...(filters.since ? { submittedAt: { gte: filters.since } } : {}),
    },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    take,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    select: { id: true, slug: true, submittedByUserId: true, bundleKey: true },
  });
}

/**
 * A backfilled request's trace row: replaces the request's trace ONLY when that one froze no chat
 * (the guard is in the UPDATE itself, so a trace with chats is never overwritten), else creates it.
 */
export async function writeReplacingEmptyTrace(
  db: Pick<PrismaClient, 'appPublishRequestTrace'>,
  row: {
    publishRequestId: string;
    slug: string;
    userId: number;
    conversationIds: string[];
    snapshots: unknown[];
    signals: unknown;
    signalsVersion: number;
    snapshotError: string | null;
  }
): Promise<'replaced' | 'created'> {
  const data = {
    conversationIds: row.conversationIds,
    snapshots: row.snapshots as object[],
    signals: row.signals as object,
    signalsVersion: row.signalsVersion,
    snapshotError: row.snapshotError,
  };
  const replaced = await db.appPublishRequestTrace.updateMany({
    where: { publishRequestId: row.publishRequestId, conversationIds: { isEmpty: true } },
    data,
  });
  if (replaced.count > 0) return 'replaced';
  await db.appPublishRequestTrace.create({
    data: { ...data, publishRequestId: row.publishRequestId, slug: row.slug, userId: row.userId },
    select: { id: true },
  });
  return 'created';
}
