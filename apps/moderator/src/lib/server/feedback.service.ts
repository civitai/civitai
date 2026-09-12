import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import type { FeedbackStatus } from '$lib/feedback';

/**
 * The `Feedback` table, read and triaged.
 *
 * The table has been written to since 2026-08 and read by nothing — three of the four statuses its
 * CHECK constraint allows were unreachable by any code path that existed. This module is the
 * reader.
 *
 * 🔴 Every write here is scoped on the state the operator was LOOKING AT, not on the id alone, and
 * reports the affected-row count back. Zero rows is a refusal, never a success: a triage that
 * silently overwrites a colleague's verdict is indistinguishable, on screen, from one that worked.
 */

export const FEEDBACK_PAGE_SIZE = 50;

export type FeedbackRow = {
  id: number;
  area: string;
  userId: number;
  username: string | null;
  message: string;
  context: unknown;
  status: string;
  createdAt: Date;
  triageNote: string | null;
  handledById: number | null;
  handledByUsername: string | null;
  handledAt: Date | null;
  bugId: number | null;
  bugTitle: string | null;
  bugStatus: string | null;
};

export async function getFeedbackList(input: {
  statuses: readonly FeedbackStatus[];
  area?: string | null;
  cursor?: number | null;
  limit?: number;
}): Promise<{ items: FeedbackRow[]; nextCursor: number | null }> {
  const limit = input.limit ?? FEEDBACK_PAGE_SIZE;

  let query = dbRead
    .selectFrom('Feedback as f')
    .leftJoin('User as u', 'u.id', 'f.userId')
    .leftJoin('User as h', 'h.id', 'f.handledById')
    .leftJoin('Bug as b', 'b.id', 'f.bugId')
    .select([
      'f.id',
      'f.area',
      'f.userId',
      'u.username',
      'f.message',
      'f.context',
      'f.status',
      'f.createdAt',
      'f.triageNote',
      'f.handledById',
      'h.username as handledByUsername',
      'f.handledAt',
      'f.bugId',
      'b.title as bugTitle',
      'b.status as bugStatus',
    ])
    /**
     * 🔴 `id DESC`, not `createdAt DESC`, and the keyset below compares the same column.
     *
     * The two are the same order here and the id is the better key twice over. `Feedback` is
     * insert-only with `createdAt DEFAULT now()` and nothing backdates or rewrites it, so id order
     * IS arrival order; and the id is UNIQUE where the timestamp is not, so a page boundary cannot
     * repeat or skip rows sharing a millisecond.
     *
     * It also keeps the boundary out of the DRIVER's timestamp handling. `createdAt` is `timestamp
     * WITHOUT time zone`: node-postgres serialises a `Date` parameter as local time with an
     * explicit offset and parses the column back as local, which round-trips — but that symmetry is
     * the driver's, not Postgres', and it does not hold everywhere (PGlite, which this app's own
     * test tier runs on, serialises the same `Date` as UTC and shifts the comparison by the local
     * offset). An integer comparison carries no such question.
     */
    .orderBy('f.id', 'desc')
    .limit(limit + 1);

  // An empty selection is every status, said by the caller rather than implied here.
  if (input.statuses.length) query = query.where('f.status', 'in', [...input.statuses]);
  if (input.area) query = query.where('f.area', '=', input.area);
  if (input.cursor) query = query.where('f.id', '<', input.cursor);

  const rows = await query.execute();
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(
    (r): FeedbackRow => ({
      ...r,
      createdAt: new Date(r.createdAt),
      handledAt: r.handledAt ? new Date(r.handledAt) : null,
    })
  );

  return {
    items,
    nextCursor: hasMore && items.length ? items[items.length - 1].id : null,
  };
}

/**
 * The sidebar badge.
 *
 * Cheap enough to sit in `sidebar-counts.service.ts`' single `Promise.all` without `bounded()`:
 * `Feedback_status_createdAt_idx` serves it as an index-only scan, the producer is rate-limited to
 * five submissions per user per hour, and the whole map is behind a 60-second cache.
 */
export async function countNewFeedback(): Promise<number> {
  const row = await dbRead
    .selectFrom('Feedback')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('status', '=', 'new')
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Areas that actually have rows.
 *
 * 🔴 Unioned with the TS registry at the call site (`feedbackAreaOptions`), never used alone: an
 * area whose producer was retired still owns its history, and this is the only list that knows it.
 */
export async function getFeedbackAreas(): Promise<string[]> {
  const rows = await dbRead
    .selectFrom('Feedback')
    .select('area')
    .distinct()
    .orderBy('area', 'asc')
    .execute();
  return rows.map((r) => r.area);
}

export type FeedbackSibling = {
  id: number;
  area: string;
  message: string;
  createdAt: Date;
  status: string;
};

/** Other reports already attached to the same Bug — what turns duplicated complaints into one issue. */
export async function getSiblingFeedback(input: {
  bugId: number;
  excludeId: number;
}): Promise<FeedbackSibling[]> {
  const rows = await dbRead
    .selectFrom('Feedback')
    .select(['id', 'area', 'message', 'createdAt', 'status'])
    .where('bugId', '=', input.bugId)
    .where('id', '!=', input.excludeId)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .execute();
  return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
}

export type TriageResult =
  | { ok: true; changed: true }
  | { ok: true; changed: false }
  | { ok: false; reason: 'gone' };

/**
 * Set a row's status and triage note in one statement.
 *
 * 🔴 SCOPED ON `expectedStatus` — the status the operator was looking at when they decided. Without
 * it, two moderators reaching opposite verdicts produce one silent overwrite and two screens that
 * both say "saved".
 *
 * Moving a row back to `new` CLEARS the handler rather than stamping it: "handled by" naming a
 * moderator on a row sitting in the unhandled queue is a claim the screen cannot support.
 */
export async function triageFeedback(input: {
  id: number;
  status: FeedbackStatus;
  expectedStatus: FeedbackStatus;
  note: string | null;
  moderatorId: number;
}): Promise<TriageResult> {
  const handled = input.status !== 'new';
  const result = await dbWrite
    .updateTable('Feedback')
    .set({
      status: input.status,
      triageNote: input.note,
      handledById: handled ? input.moderatorId : null,
      handledAt: handled ? new Date() : null,
    })
    .where('id', '=', input.id)
    .where('status', '=', input.expectedStatus)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) > 0) {
    await recordModActivity({
      userId: input.moderatorId,
      entityType: 'feedback',
      entityId: input.id,
      activity: 'triage',
    });
    return { ok: true, changed: true };
  }

  // Zero rows has two causes and they need different words on screen. One extra read, only on the
  // path that already failed.
  return (await feedbackExists(dbWrite, input.id))
    ? { ok: true, changed: false }
    : { ok: false, reason: 'gone' };
}

/**
 * 🔴 Takes the client rather than closing over `dbRead`. This decides WHICH REFUSAL the operator
 * reads, so it has to see the same snapshot as the write that just failed: on the replica a row
 * deleted a moment ago is still present, and the answer flips from "that report is gone" to
 * "someone else already triaged it" — the exact confusion the split exists to remove. Callers pass
 * the primary, or the open transaction.
 */
async function feedbackExists(
  db: Pick<typeof dbWrite, 'selectFrom'>,
  id: number
): Promise<boolean> {
  const row = await db.selectFrom('Feedback').select('id').where('id', '=', id).executeTakeFirst();
  return !!row;
}

export type PromoteResult =
  | { ok: true; bugId: number; created: boolean }
  | { ok: false; reason: 'already-linked' | 'no-such-bug' | 'gone' };

/**
 * Mint a `Bug` from a report and link it, in one transaction.
 *
 * 🔴 `publishedAt` STAYS NULL, and that is what keeps the reporter's words off the public board.
 * `getBugs` filters `publishedAt = { lte: now, not: null }` for anyone without the `bugsEdit`
 * feature flag, so an unpublished Bug is a draft visible only to flag holders. Publishing is a
 * separate deliberate act on `/issues`, not a side effect of triaging feedback.
 *
 * 🔴 `content` is left NULL ON PURPOSE. `createBugInput.content` runs through
 * `getSanitizedStringSchema()` in the main app — the field is stored and rendered as HTML. The
 * feedback `message` is plain text a user typed. Seeding one from the other would put
 * user-authored text into an HTML-rendered field on a public board along a path that never
 * sanitises it, because this app does not go through that zod schema.
 *
 * 🔴 `updatedAt` is supplied EXPLICITLY. It is `@updatedAt` in Prisma, which is a client-side
 * stamp — the column is `NOT NULL` with NO database default, and this app's Kysely client installs
 * no `updatedAtPlugin`. Omitting it is a 23502, not a default.
 */
export async function promoteFeedbackToBug(input: {
  id: number;
  title: string;
  summary: string;
  moderatorId: number;
}): Promise<PromoteResult> {
  try {
    return await dbWrite.transaction().execute(async (trx) => {
      const now = new Date();
      const bug = await trx
        .insertInto('Bug')
        .values({
          title: input.title,
          summary: input.summary,
          status: BUG_INITIAL_STATUS,
          // Derived, not hardcoded null: with a fixed 'Open' this is always null, and a future
          // status control on the form would make that assumption wrong silently.
          resolvedAt: isBugClosed(BUG_INITIAL_STATUS) ? now : null,
          publishedAt: null,
          updatedAt: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const linked = await linkInTransaction(trx, {
        id: input.id,
        bugId: bug.id,
        moderatorId: input.moderatorId,
      });
      // Rolls the Bug insert back with it — a row nobody linked is litter on a table the public
      // board reads.
      if (!linked) throw new NotLinked(await linkRefusalReason(trx, input.id));

      return { ok: true as const, bugId: bug.id, created: true };
    });
  } catch (e) {
    if (e instanceof NotLinked) return { ok: false, reason: e.reason };
    throw e;
  }
}

/** The common case after the first promotion: the second report of the same thing gets attached. */
export async function linkFeedbackToBug(input: {
  id: number;
  bugId: number;
  moderatorId: number;
}): Promise<PromoteResult> {
  // 🔴 `dbWrite`, NOT `dbRead`. The replica is a separate pool, and attaching is BY DESIGN the
  // thing a moderator does seconds after promoting — read the issue number off the screen, paste it
  // into the next report. Any replica lag turns that into "No issue with that number", which is
  // indistinguishable from a typo. A single primary-key read on a path that is about to write.
  const bug = await dbWrite
    .selectFrom('Bug')
    .select('id')
    .where('id', '=', input.bugId)
    .executeTakeFirst();
  if (!bug) return { ok: false, reason: 'no-such-bug' };

  const linked = await linkInTransaction(dbWrite, input);
  return linked
    ? { ok: true, bugId: input.bugId, created: false }
    : { ok: false, reason: await linkRefusalReason(dbWrite, input.id) };
}

/**
 * Zero rows has two causes and they need different words on screen — the same split the triage path
 * makes. Telling a moderator to "reload to see which issue it is linked to" when the row was
 * deleted sends them looking for something that does not exist.
 */
async function linkRefusalReason(
  db: Pick<typeof dbWrite, 'selectFrom'>,
  id: number
): Promise<'already-linked' | 'gone'> {
  return (await feedbackExists(db, id)) ? 'already-linked' : 'gone';
}

class NotLinked extends Error {
  constructor(readonly reason: 'already-linked' | 'gone') {
    super(reason);
  }
}

/**
 * 🔴 `AND "bugId" IS NULL` makes double-promotion impossible. Zero rows means someone beat you to
 * it — or the row is gone — and either way nothing should be linked to the Bug just minted.
 */
async function linkInTransaction(
  db: Pick<typeof dbWrite, 'updateTable'>,
  input: { id: number; bugId: number; moderatorId: number }
): Promise<boolean> {
  const result = await db
    .updateTable('Feedback')
    .set({
      bugId: input.bugId,
      status: 'actioned',
      handledById: input.moderatorId,
      handledAt: new Date(),
    })
    .where('id', '=', input.id)
    .where('bugId', 'is', null)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) return false;
  await recordModActivity({
    userId: input.moderatorId,
    entityType: 'feedback',
    entityId: input.id,
    activity: 'promote',
  });
  return true;
}

const BUG_INITIAL_STATUS = 'Open';

/**
 * Ported from the main app's `~/server/common/constants`, not re-derived.
 *
 * 🔴 `Bug.status` is a free-form string with no enum and no CHECK constraint — the suggestion list
 * is autocomplete over a free-text field, and ClickUp supplies the values. "Is this closed" is a
 * case-insensitive membership test, never a comparison to a literal.
 */
const BUG_CLOSED_STATUSES = ['complete', 'closed', 'done', 'resolved'];
const isBugClosed = (status: string) => BUG_CLOSED_STATUSES.includes(status.trim().toLowerCase());
