import type { PrismaClient } from '@prisma/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom, safeError } from '~/server/logging/client';

/**
 * App Assistant session tracing: which chats built which app, and what each of their turns did.
 *
 * Written from one place, `recordAssistantTurn`, which the server runner's per-turn report reaches
 * (`/api/internal/app-assistant/turn`). Two writes, both behind the `app-assistant-tracing` flag:
 *   1. the chat ↔ app link row (`app_assistant_session_links`), when the chat had an app chosen;
 *   2. one ClickHouse row per turn (`appAssistantTurns`), with or without an app, so builds that
 *      are abandoned before any submit are counted too.
 *
 * 🔴 BOTH ARE BEST-EFFORT AND NEVER THROW. The Postgres table and the ClickHouse table are applied
 * by hand, so this code ships before either exists: each write catches its own failure (a missing
 * table included), logs it, and reports `false`. A turn never waits on, or fails for, either.
 */

/** The ClickHouse table each turn's row goes to (DDL: `src/server/clickhouse/migrations`). */
export const APP_ASSISTANT_TURNS_TABLE = 'appAssistantTurns';

/** One finished server-runner turn, as civitai records it: the user and chat from the run grant. */
export interface AssistantTurnReport {
  userId: number;
  conversationId: string;
  /** The app the chat had chosen as the turn ended, or null (no link row is written then). */
  appSlug: string | null;
  seq: number;
  runId: string;
  model: string;
  status: string;
  buzz: number;
  toolCalls: Record<string, number>;
  durationMs: number;
  startedAt: Date;
  endedAt: Date;
}

export interface AssistantTurnOutcome {
  /** The flag was on, so the writes below were attempted. */
  tracing: boolean;
  /** The link row was upserted. */
  linked: boolean;
  /** The ClickHouse row was handed to ClickHouse. */
  event: boolean;
}

/** Whether tracing writes run. A missing key, an unreachable Flipt or an error all read as off. */
export async function isAppAssistantTracingOn(): Promise<boolean> {
  try {
    return await isFlipt(FLIPT_FEATURE_FLAGS.APP_ASSISTANT_TRACING);
  } catch {
    return false;
  }
}

type RawWriter = Pick<PrismaClient, '$executeRaw'>;

/**
 * The identity of one PASS of a run: the run id and when the pass began. A run that DBOS recovers
 * after a crash runs a second pass under the same run id, with its own start and its own charge.
 */
export function passKey(report: Pick<AssistantTurnReport, 'runId' | 'startedAt'>): string {
  return `${report.runId}@${report.startedAt.toISOString()}`;
}

/**
 * Upserts the (user, conversation, app) link for one finished pass: first seen at the earliest
 * pass's start, last seen at the latest pass's end, one more turn and the pass's Buzz, its model.
 *
 * Dedupe, exactly: `last_run_id` holds the last pass written (`passKey`), and a report of THAT SAME
 * pass arriving again right after it moves nothing but the times. A second pass of the same run
 * (recovered after a crash) is a different pass and counts, with its Buzz. A redelivery that arrives
 * after another pass was written is NOT recognised and counts again: the runner sends each report
 * once and never retries, so only a duplicate at the transport can repeat one.
 *
 * Only for a LIVE account: the statement inserts nothing (and so updates nothing) when the user is
 * deleted, so a report arriving after `deleteUser` (a run grant outlives it) cannot bring the row back.
 */
export async function upsertSessionLink(
  db: RawWriter,
  report: AssistantTurnReport & { appSlug: string }
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "app_assistant_session_links" AS l
      ("user_id", "conversation_id", "app_slug", "first_seen_at", "last_seen_at",
       "turn_count", "last_model", "buzz_total", "last_run_id")
    SELECT ${report.userId}::int, ${report.conversationId}::text, ${report.appSlug}::text,
           ${report.startedAt}::timestamptz, ${report.endedAt}::timestamptz, 1,
           ${report.model}::text, ${report.buzz}::double precision, ${passKey(report)}::text
    WHERE EXISTS (
      SELECT 1 FROM "User" u WHERE u."id" = ${report.userId}::int AND u."deletedAt" IS NULL
    )
    ON CONFLICT ("user_id", "conversation_id", "app_slug") DO UPDATE SET
      "turn_count" = l."turn_count"
        + CASE WHEN l."last_run_id" IS NOT DISTINCT FROM EXCLUDED."last_run_id" THEN 0 ELSE 1 END,
      "buzz_total" = l."buzz_total"
        + CASE WHEN l."last_run_id" IS NOT DISTINCT FROM EXCLUDED."last_run_id" THEN 0
               ELSE EXCLUDED."buzz_total" END,
      "first_seen_at" = LEAST(l."first_seen_at", EXCLUDED."first_seen_at"),
      "last_seen_at" = GREATEST(l."last_seen_at", EXCLUDED."last_seen_at"),
      "last_model" = EXCLUDED."last_model",
      "last_run_id" = EXCLUDED."last_run_id"
  `;
}

/**
 * Account deletion's part (`deleteUser`'s `delete-app-assistant-links` step): the user's chat ↔ app
 * link rows. `deleteUser` is a SOFT delete (the User row is scrubbed and kept), so the table's
 * `ON DELETE CASCADE` never fires for it; this is what removes them. A table not applied yet holds
 * nothing to delete: that reads as 0, not as a failure. Any other error is the caller's to log.
 */
export async function deleteSessionLinksOfAccount(
  userId: number,
  {
    db,
    isMissingTable,
  }: {
    db: Pick<PrismaClient, 'appAssistantSessionLink'>;
    isMissingTable: (err: unknown) => boolean;
  }
): Promise<number> {
  try {
    const { count } = await db.appAssistantSessionLink.deleteMany({ where: { userId } });
    return count;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}

/** The ClickHouse row for one turn (`appAssistantTurns`). Ids and counts only: no message text. */
export function turnEventRow(report: AssistantTurnReport) {
  const toolCallCount = Object.values(report.toolCalls).reduce((sum, count) => sum + count, 0);
  return {
    time: formatClickhouseDateTime64(report.endedAt),
    startedAt: formatClickhouseDateTime64(report.startedAt),
    userId: report.userId,
    conversationId: report.conversationId,
    appSlug: report.appSlug ?? '',
    seq: report.seq,
    runId: report.runId,
    model: report.model,
    status: report.status,
    buzz: report.buzz,
    durationMs: report.durationMs,
    toolCallCount,
    toolCalls: report.toolCalls,
  };
}

function logFailure(what: 'link' | 'event', report: AssistantTurnReport, err: unknown) {
  logToAxiom({
    type: 'warning',
    name: `app-assistant.tracing.${what}-failed`,
    message: `App Assistant tracing ${what} write skipped`,
    userId: report.userId,
    error: safeError(err),
    payload: { runId: report.runId },
  });
}

/** Whether the user exists and is not deleted. An error reads as not live: nothing is written. */
async function isLiveAccount(userId: number): Promise<boolean> {
  try {
    const { dbWrite } = await import('~/server/db/client');
    // primary: a deletion moments ago must already stop the write.
    const user = await dbWrite.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    });
    return !!user && user.deletedAt === null;
  } catch {
    return false;
  }
}

/** Records one finished turn: a no-op while the flag is off. Never throws. */
export async function recordAssistantTurn(
  report: AssistantTurnReport
): Promise<AssistantTurnOutcome> {
  if (!(await isAppAssistantTracingOn())) return { tracing: false, linked: false, event: false };
  // A run grant outlives an account deletion: a turn ending after `deleteUser` writes nothing. The
  // link upsert checks again in its own statement, so a deletion landing in between still wins.
  if (!(await isLiveAccount(report.userId))) return { tracing: true, linked: false, event: false };
  const { appSlug } = report;
  const [linked, event] = await Promise.all([
    appSlug
      ? (async () => {
          try {
            const { dbWrite } = await import('~/server/db/client');
            await upsertSessionLink(dbWrite, { ...report, appSlug });
            return true;
          } catch (err) {
            logFailure('link', report, err);
            return false;
          }
        })()
      : Promise.resolve(false),
    (async () => {
      try {
        const { clickhouse } = await import('~/server/clickhouse/client');
        if (!clickhouse) return false;
        await clickhouse.insert({
          table: APP_ASSISTANT_TURNS_TABLE,
          values: [turnEventRow(report)],
          format: 'JSONEachRow',
        });
        return true;
      } catch (err) {
        logFailure('event', report, err);
        return false;
      }
    })(),
  ]);
  return { tracing: true, linked, event };
}
