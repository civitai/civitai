import { dbRead, dbWrite } from './db';
import { recordModActivity, recordModActivityBatch } from './mod-activity';
import { FEEDBACK_PAGE_SIZE, type FeedbackStatus } from '$lib/feedback';
import {
  isFeedbackSortState,
  type FeedbackSort,
  type FeedbackSortColumn,
} from '$lib/feedback-sort';
import { MAX_INT4 } from './users.service';

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

// Re-exported so existing importers keep one import site; the value is owned by `$lib/feedback.ts`
// because the browser needs it too (see its docstring).
export { FEEDBACK_PAGE_SIZE };

/** The four columns `20260911120000_feedback_triage` adds — the only ones this page can explain. */
const TRIAGE_COLUMNS = ['triageNote', 'handledById', 'handledAt', 'bugId'];

/**
 * Postgres `undefined_column` naming a column that migration adds, i.e. this database has not had
 * it applied yet. Every migration here is applied by hand per environment, and
 * `moderator:admin` reaches the page through `SUPER_ROLE` on day one without any `/admin` tick, so
 * the window is real rather than theoretical.
 *
 * 🔴 THE CODE ALONE IS NOT ENOUGH, because the page answers with specific advice: apply THIS
 * migration. `42703` is raised by any reference to any column that does not exist — a typo in a
 * later edit, or a different unapplied migration — and matching the code alone would answer all of
 * them with that advice, confidently and wrongly, while the `catch` suppresses the error that would
 * otherwise have said so. Matching the column name keeps the answer as narrow as the question.
 *
 * Matched on the COLUMN NAME rather than on "does not exist": the name is interpolated into the
 * message and survives `lc_messages`, the surrounding English does not. Kysely quotes identifiers,
 * so the camel case is preserved; the real message is `column f.handledById does not exist`,
 * measured against the pre-migration table in `feedback.service.test.ts`.
 */
export const isMissingTriageColumns = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (code !== '42703') return false;
  return typeof message === 'string' && TRIAGE_COLUMNS.some((c) => message.includes(c));
};

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

/**
 * Every sortable column, as the SQL reference it orders by and the `FeedbackRow` field that carries
 * the same value back out for the cursor.
 *
 * 🔴 THE TWO HALVES MUST NAME THE SAME VALUE: the keyset compares the SQL side against a value read
 * off the ROW side, so a pair that disagrees compares against the wrong column — which does not
 * error, it just returns the wrong rows.
 *
 * ⚠️ `satisfies` DOES NOT CHECK THAT. It pins that all six columns are present, that no seventh is,
 * and that `field` is SOME key of `FeedbackRow` — `{ ref: 'f.area', field: 'status' }` type-checks
 * cleanly, which is exactly the defect above. What catches a mismatched pair is behavioural: the
 * order assertions in `feedback-sort.pglite.test.ts` compare against an expectation computed from
 * the fixture, and a swapped `field` reorders the result. Do not read the type as coverage.
 *
 * 🔴 NO SORT KEY IS A TIMESTAMP, AND THAT IS DELIBERATE RATHER THAN INCIDENTAL. The cursor's value
 * half makes a round trip through the URL, so a `timestamp WITHOUT time zone` key would have to be
 * serialised and re-parsed — and the driver's handling of exactly that is asymmetric between
 * production and this app's own test tier (PGlite serialises a `Date` as UTC and reads the column
 * back as local; node-postgres does neither, see `feedback-pglite.harness.ts`). A boundary that shifts
 * by the local offset skips or repeats rows, and the test tier cannot see it. So:
 *   - `age` sorts on `f.id`, which IS arrival order here — the same argument the default ordering
 *     below makes at length, and the reason the Age cell can be ordered by an integer at all.
 *   - `handled` sorts on the HANDLER, not on `handledAt` — the thing that cell is ABOUT, and the
 *     thing an operator clicking that header is asking to group by; ordering by a timestamp the cell
 *     does not show would look arbitrary on screen.
 *     ⚠️ It is not exactly what the cell PRINTS, and the gap is worth knowing: `handledByLabel`
 *     falls back to `#<handledById>` or `deleted account` when the handler's `User.username` is
 *     null, so those rows read as handled and sort into the null block with the untriaged ones. Same
 *     shape on `user`, where a reporter with no username renders `#<userId>` and sorts last.
 *
 * `kind` decides how the URL's value half is coerced before it reaches the comparison: an `int`
 * column compared against a text parameter is a Postgres error, not a miss.
 *
 * `nullable` says whether this column HAS a null block. It is what makes an absent `?cursorValue=`
 * readable: on a nullable column that spelling means "the boundary row's value is null", and on a
 * NOT NULL one it means the URL was edited, because nothing this code writes can produce it. The
 * second reading is the dangerous one to get wrong — searching for a null block that cannot exist
 * returns an EMPTY page, which is indistinguishable on screen from "the queue ends here".
 */
const FEEDBACK_SORT_KEYS = {
  /**
   * 🔴 THE DIRECTION TOKEN IS THE SQL DIRECTION, HERE AND ON EVERY OTHER COLUMN — `asc` means
   * `f.id ASC`, i.e. earliest arrival first, i.e. the OLDEST report first. It reads as DESCENDING on
   * screen, because the Age cell renders `shortAge(createdAt)` — a duration, which grows as the id
   * shrinks. That flip is a statement about the cell, so it lives with the header
   * (`READS_INVERTED` in `$lib/feedback-sort.ts`) and reaches nothing in this file.
   *
   * 🔴 IT USED TO LIVE HERE, AS AN `invert` FLAG THIS MAP CARRIED AND `sqlAscending` CONSULTED, AND
   * THAT WAS THE WRONG LAYER. Two readers needed it — the `ORDER BY` and the keyset's comparison
   * operator — so a flip applied to one and not the other produced an ordering the cursor walks
   * backwards through, every page turn re-serving rows the previous page already showed. Nothing in
   * this module inverts anything now; `ascending` below is the operator's direction, read once.
   *
   * ⚠️ `age` IS ALSO THE ONE COLUMN WITH A SINGLE SORTED STATE. Its other one ordered `f.id DESC`,
   * which IS the default ordering, so it moved no rows — `FEEDBACK_SORT_DIRECTIONS` carries the
   * measurement, and this service refuses the state rather than serving a sort that does nothing.
   */
  age: { ref: 'f.id', field: 'id', kind: 'int', nullable: false },
  area: { ref: 'f.area', field: 'area', kind: 'text', nullable: false },
  // Nullable twice over: `User.username` is itself nullable, and the join is a LEFT one.
  user: { ref: 'u.username', field: 'username', kind: 'text', nullable: true },
  status: { ref: 'f.status', field: 'status', kind: 'text', nullable: false },
  // Every untriaged row has no handler — this column's null block is most of the default view.
  handled: { ref: 'h.username', field: 'handledByUsername', kind: 'text', nullable: true },
  issue: { ref: 'f.bugId', field: 'bugId', kind: 'int', nullable: true },
} as const satisfies Record<
  FeedbackSortColumn,
  { ref: string; field: keyof FeedbackRow; kind: 'int' | 'text'; nullable: boolean }
>;

/**
 * Thrown when a caller hands `getFeedbackList` a sort state this page does not have — an unknown
 * column, an unknown direction, or a direction the column does not offer.
 *
 * 🔴 IT THROWS WHERE `parseFeedbackSort` DEGRADES, AND THE TWO LAYERS ARE DELIBERATELY DIFFERENT.
 * That parser's input is a URL somebody typed, so a hostile `?sort=` must degrade to the default
 * ordering rather than 500 a queue nobody can then open. This function's input is an ARGUMENT, and
 * degrading it would hand the caller A PAGE OF REAL DATA IN AN ORDERING THEY DID NOT ASK FOR, WITH
 * NO SIGNAL — the same silently-wrong shape this page refuses on the client side, where a
 * `.sort()` over one loaded page presents itself as an ordering of the queue. An unreachable state
 * at this layer is a programming error, and the only useful thing to do with one is say so.
 *
 * The one production caller (`routes/feedback/+page.server.ts`) pre-validates through
 * `parseFeedbackSort`, and the parameter is union-typed, so a test has to CAST to reach this at all.
 * The pairing is what has to hold: everything the parser can emit, this accepts — pinned in
 * `feedback-sort.test.ts` and exercised in `feedback-sort.pglite.test.ts`.
 */
export class InvalidFeedbackSort extends Error {
  constructor(readonly sort: unknown) {
    super(`not a feedback sort state: ${JSON.stringify(sort)}`);
    this.name = 'InvalidFeedbackSort';
  }
}

/** The boundary row's value in the sorted column, as it travels through the URL. */
const sortValueOf = (row: FeedbackRow, column: FeedbackSortColumn): string | null => {
  const value = row[FEEDBACK_SORT_KEYS[column].field];
  return value === null || value === undefined ? null : String(value);
};

/**
 * The URL's value half, coerced to what the column can actually be compared against.
 *
 * Returns `undefined` for a value this column CANNOT HOLD, which is three different URLs:
 *   - anything that is not a plain integer on an integer column;
 *   - a value outside the int4 range, which ERRORS the comparison in Postgres rather than missing it;
 *   - an ABSENT param on a NOT NULL column, where "the boundary row's value is null" is not a
 *     position the ordering has. Left as `null` it would send the query looking for a null block
 *     that cannot exist, and an empty page reads as the end of the queue rather than as a bad URL.
 *
 * The caller drops the WHOLE cursor on `undefined` rather than just this half: a keyset with one
 * half missing is not a narrower query, it is a different position in the ordering.
 *
 * 🔴 THE SHAPE IS MATCHED BEFORE `Number()`, NOT AFTER. `Number` is not a parser — it maps `''` and
 * `'  '` to **0**, `'0x10'` to 16, `'1e3'` to 1000 and `' 12 '` to 12, and every one of those passes
 * `Number.isInteger`. A bare `?cursorValue=` on an integer column would therefore become the boundary
 * `0` rather than a refusal: on `issue asc` that admits every row and looks like page one, and on
 * `issue desc` it returns ONLY the trailing null block — a silently wrong page, from a URL that
 * carries no value at all.
 */
const INTEGER = /^-?\d+$/;

const coerceSortValue = (
  raw: string | null,
  { kind, nullable }: { kind: 'int' | 'text'; nullable: boolean }
): string | number | null | undefined => {
  if (raw === null) return nullable ? null : undefined;
  if (kind === 'text') return raw;
  if (!INTEGER.test(raw)) return undefined;
  const n = Number(raw);
  // The real int4 range, which is not symmetric — `-2147483648` is legal and `2147483648` is not.
  return n >= -MAX_INT4 - 1 && n <= MAX_INT4 ? n : undefined;
};

export async function getFeedbackList(input: {
  statuses: readonly FeedbackStatus[];
  area?: string | null;
  cursor?: number | null;
  /**
   * The sorted column's value on the boundary row. `null` means the boundary row's value IS null —
   * a real position, since `handled` and `issue` are nullable and those rows sort last. Only read
   * when `sort` is set.
   */
  cursorValue?: string | null;
  sort?: FeedbackSort | null;
  limit?: number;
}): Promise<{
  items: FeedbackRow[];
  nextCursor: number | null;
  nextCursorValue: string | null;
}> {
  const limit = input.limit ?? FEEDBACK_PAGE_SIZE;
  /**
   * 🔴 REFUSED HERE TOO, not only at the URL parser — and refused by THROWING. The column names a
   * SQL identifier, and this is the last place before the query builder sees it, so a caller that
   * stops validating (a new route, a script, an internal API) must not be able to hand this function
   * an arbitrary string. The lookup is a map read and nothing is ever interpolated, so the WORST
   * case was never an injection — it was a silent fallback, which is why the fallback is gone. See
   * `InvalidFeedbackSort`.
   *
   * ALL THREE facts, not just the column: the column is on the list, the direction is a direction,
   * and the direction is one THAT COLUMN OFFERS. The third is what keeps `age` two-state all the way
   * down — its `desc` is the default ordering wearing a sort's clothes, and serving it would put an
   * arrow over rows that did not move.
   */
  if (input.sort && !isFeedbackSortState(input.sort)) throw new InvalidFeedbackSort(input.sort);
  const sort: FeedbackSort | null = input.sort ?? null;

  /**
   * The direction the SQL orders by — the operator's direction, with no inversion anywhere in this
   * module (`FEEDBACK_SORT_KEYS.age` records where the one display flip went, and why).
   *
   * 🔴 ONE VALUE, BECAUSE TWO PLACES READ IT AND THEY MUST NEVER DISAGREE: the `ORDER BY` and the
   * keyset's comparison operator. Read as two separate expressions they can be changed
   * independently, and a direction applied to one and not the other produces an ordering the cursor
   * walks backwards through — every page turn returning rows the previous page already showed. A
   * single local cannot be flipped at one site only.
   */
  const ascending = sort?.direction === 'asc';

  /**
   * ⚠️ THE REPLICA, DELIBERATELY, AND IT HAS A COST — read this before "fixing" it. Every write
   * here reloads the page, so under replica lag an operator can see their own triage come back
   * unapplied, and their next click then posts the STALE `expectedStatus` and is refused with
   * "someone else already triaged this" over their own write.
   *
   * Left on the replica anyway: it fails CLOSED (a refusal, never a silent overwrite), it is the
   * convention every other queue in this app follows, and a triage queue read by a handful of
   * people is the shape where lag is least likely to be observed. `linkFeedbackToBug`'s Bug lookup
   * goes to the primary instead, and that is not an inconsistency — there the stale answer is a
   * flat "no issue with that number" for an issue the operator is looking at, which reads as a
   * defect rather than as a conflict.
   *
   * Revisit if a moderator reports a conflict they cannot explain; the fix is this one word.
   */
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
    .limit(limit + 1);

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
   *
   * 🔴 THE SAME ARGUMENT IS WHY THE COLUMN SORT BELOW IS COMPOUND. Sorting on any other column
   * produces ties — `area`, `status` and a handler's username all repeat freely — and a keyset on a
   * non-unique key either repeats or skips the rows sharing a boundary value. So the ordering is
   * always `(<column>, f.id)` with the id as the unique tie-break, and the cursor carries BOTH
   * halves. The id half never goes away: it is what makes the pair unique.
   *
   * `NULLS LAST` in both directions, explicitly, rather than Postgres' defaults (last for ASC,
   * FIRST for DESC). The keyset predicate has to know where the null block sits, and a rule that
   * flips with the direction is one the predicate would have to flip with it.
   *
   * ⚠️ A SORTED KEY CAN BE MUTABLE, WHERE THE DEFAULT ONE NEVER WAS — accepted, not overlooked. The
   * triage action writes `status`, `handledById` and `handledAt`, i.e. the keys behind the `status`
   * and `handled` sorts, and every successful write calls `invalidateAll()`, which re-runs `load`
   * against the same `?cursor=`/`?cursorValue=`. Under `id DESC` the key was immutable and a reload
   * was always the same page; under a sort, a row triaged on the current page moves in the ordering,
   * so the next page turn can repeat or skip its neighbours. Clearing paging on a successful triage
   * would fix it by throwing the operator back to page one mid-queue, which is worse than the drift
   * — the queue is drained from the front and a triaged row is usually meant to leave the view.
   */
  if (sort) {
    const { ref } = FEEDBACK_SORT_KEYS[sort.column];
    query = query.orderBy(ref, (ob) => (ascending ? ob.asc().nullsLast() : ob.desc().nullsLast()));
  }
  query = query.orderBy('f.id', 'desc');

  // An empty selection is every status, said by the caller rather than implied here.
  if (input.statuses.length) query = query.where('f.status', 'in', [...input.statuses]);
  if (input.area) query = query.where('f.area', '=', input.area);

  if (input.cursor) {
    if (!sort) {
      query = query.where('f.id', '<', input.cursor);
    } else {
      const key = FEEDBACK_SORT_KEYS[sort.column];
      const ref = key.ref;
      const boundary = coerceSortValue(input.cursorValue ?? null, key);
      /**
       * 🔴 THE WHOLE CURSOR IS DROPPED, not just the half that failed to parse. Keeping the id half
       * alone would compare `f.id` against a boundary from a DIFFERENT ordering and return a page
       * that is neither the first nor the next one — arbitrary rows that look like data. Starting
       * over at page one is visibly wrong instead.
       */
      if (boundary !== undefined) {
        const cursorId = input.cursor;
        const after = ascending ? '>' : '<';
        query = query.where((eb) => {
          const col = eb.ref(ref);
          /**
           * The boundary row is itself in the null block, so everything after it is the rest of
           * that block — ordered by `f.id DESC`, like every tie here.
           */
          if (boundary === null) return eb.and([eb(col, 'is', null), eb('f.id', '<', cursorId)]);
          return eb.or([
            // Strictly past the boundary value…
            eb(col, after, boundary),
            // …its ties, which the id orders…
            eb.and([eb(col, '=', boundary), eb('f.id', '<', cursorId)]),
            /**
             * …and the null block, which `NULLS LAST` puts after every value in both directions.
             *
             * ⚠️ NO ID BOUND HERE, AND THAT IS CORRECT BUT NOT CHEAP. While the boundary is still in
             * the valued part of the ordering, EVERY null row is genuinely still ahead of it, so the
             * arm has to be unbounded. The cost is that each such page re-reads and re-sorts the
             * whole null block, so page N costs about what page 1 does — on `handled`, where most
             * rows are null, that is most of the table. Irrelevant at 26 rows and worth revisiting
             * before it is not, since O(page) paging is the reason the ordering is server-side at
             * all. Once the boundary is ITSELF in the null block the `boundary === null` branch above
             * takes over and is bounded.
             */
            eb(col, 'is', null),
          ]);
        });
      }
    }
  }

  const rows = await query.execute();
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(
    (r): FeedbackRow => ({
      ...r,
      createdAt: new Date(r.createdAt),
      handledAt: r.handledAt ? new Date(r.handledAt) : null,
    })
  );

  const boundaryRow = hasMore && items.length ? items[items.length - 1] : null;
  return {
    items,
    nextCursor: boundaryRow ? boundaryRow.id : null,
    // Null when there is no next page, AND when the boundary row's sort value is genuinely null —
    // the caller only reads it alongside a non-null `nextCursor`, where the second reading is the
    // only one available.
    nextCursorValue: boundaryRow && sort ? sortValueOf(boundaryRow, sort.column) : null,
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
      // 🔴 `bugId` IS DELIBERATELY NOT TOUCHED HERE — not on any status, reopening included.
      //
      // Clearing it on the way back to `new` was tried and reverted. It reads as symmetric with
      // the two columns above, and it is not: those record WHO acted, which a reopen genuinely
      // retracts, while the link records THAT THIS REPORT IS ABOUT THAT ISSUE, which stays true.
      // Clearing destroyed it with no way back — nothing in this app stores the number a second
      // time, `getSiblingFeedback` drops the row from every sibling's list, and `ModActivity` has
      // no column to put it in — and it left a `Bug` with no feedback pointing at it, which is
      // exactly the state `promoteFeedbackToBug` runs a transaction rollback to avoid creating.
      //
      // ⚠️ WHAT THIS LEAVES OPEN, so the next reader sees the whole shape: a linked row can never
      // be re-linked, because `linkInTransaction` requires `bugId IS NULL`. That is a MISSING
      // CAPABILITY — an unlink control — and it is missing at every status, so reopening neither
      // causes it nor is a sensible back door to it. This PR does not add one.
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
 * Set one status across many rows, each scoped on the status ITS OWN row was showing.
 *
 * 🔴 ONE STATEMENT PER DISTINCT `expectedStatus`, NOT ONE PER ROW. The selection spans rows at
 * different statuses, and `FEEDBACK_STATUSES` has four members, so this is at most four UPDATEs
 * however many rows are selected. Each carries the same `WHERE status = ?` guard the single-row path
 * uses, so a row someone else moved is refused individually rather than taking the batch with it.
 *
 * 🔴 `RETURNING id` IS WHAT MAKES PARTIAL SUCCESS HONEST. A bare affected-row COUNT says how many
 * moved but not WHICH, and the audit rows have to name the rows that actually changed — counting
 * and then logging the whole selection would write `ModActivity` entries for reports this moderator
 * did not move. The returned ids are the only set that is true of both.
 *
 * Rows that did not move are not distinguished here between "someone else got there first" and
 * "deleted": the single-row path spends an extra read on that because it has one row and one
 * sentence to write, while here the honest summary is a count either way, and per-row reads would be
 * one query per refusal to produce words nobody can act on individually.
 */
export async function bulkTriageFeedback(input: {
  /**
   * 🔴 IDS MUST BE UNIQUE, AND THIS FUNCTION DOES NOT ENFORCE IT. `parseFeedbackBulkRows` refuses a
   * repeated id before this is reached — two pairs naming one row carry two different expectations —
   * but this is exported and the test tier calls it directly. A duplicate would inflate `actionable`
   * without `changed` following, i.e. report a refusal that never happened.
   */
  rows: readonly { id: number; expectedStatus: FeedbackStatus }[];
  status: FeedbackStatus;
  moderatorId: number;
}): Promise<{ changed: number[]; actionable: number }> {
  const handled = input.status !== 'new';
  const byExpected = new Map<FeedbackStatus, number[]>();
  for (const row of input.rows) {
    const ids = byExpected.get(row.expectedStatus);
    if (ids) ids.push(row.id);
    else byExpected.set(row.expectedStatus, [row.id]);
  }

  /**
   * 🔴 ONE TRANSACTION ACROSS THE (AT MOST FOUR) STATEMENTS. They are issued sequentially, so a
   * throw on the second would otherwise leave the first group's rows MOVED with no audit row for
   * them — `recordModActivityBatch` runs after the loop. Rolling back is the only outcome that
   * leaves the queue and the audit log agreeing. Same argument `promoteFeedbackToBug` makes
   * further down this file.
   *
   * ⚠️ IT PROTECTS THE DATA AND NOTHING ELSE. Nothing here catches, so a throw still reaches the
   * error boundary and still takes an open detail panel's unsaved draft with it — the siblings
   * (`triage`, `promote`) behave the same way, and `CLAUDE.md` bans `throw error()` rather than
   * uncaught throws. An earlier version of this comment claimed the transaction covered that too.
   */
  const { changed, actionable } = await dbWrite.transaction().execute(async (trx) => {
    const changed: number[] = [];
    let actionable = 0;
    for (const [expectedStatus, ids] of byExpected) {
      /**
       * 🔴 A ROW ALREADY AT THE TARGET STATUS IS SKIPPED AND EXCLUDED FROM `actionable`, AND BOTH
       * HALVES MATTER.
       *
       * 🔴 DO NOT READ THIS AS A NO-OP — AN EARLIER VERSION OF THIS COMMENT SAID THE UPDATE "COULD
       * NOT MATCH", WHICH IS MEASURABLY FALSE AND WOULD LICENSE DELETING THE GUARD.
       * `UPDATE … SET status='reviewed' WHERE status='reviewed'` matches perfectly well and writes a
       * new tuple: measured by removing this line, after which `RETURNING id` hands the
       * already-at-target row back. Without the skip, such a row has its `handledById`/`handledAt`
       * RE-STAMPED to whoever clicked, lands in `changed`, and earns a spurious `ModActivity` row
       * asserting a triage that did not happen.
       *
       * The second half: a skipped row left inside the denominator would be reported to the operator
       * as a row that "did not change" — a refusal that did not happen, over a row already in the
       * state they asked for.
       *
       * The filter lives HERE rather than in the action so there is one definition of what this
       * function was asked to move. A caller filtering first, plus this, would be the same predicate
       * in two places.
       */
      if (expectedStatus === input.status) continue;
      actionable += ids.length;
      const rows = await trx
        .updateTable('Feedback')
        .set({
          status: input.status,
          // 🔴 `triageNote` UNTOUCHED. A bulk verdict says what happened to a batch; a note says
          // something about ONE report, and writing one across a selection would overwrite whatever
          // each row already had. The single-row form is where a note belongs.
          handledById: handled ? input.moderatorId : null,
          handledAt: handled ? new Date() : null,
          // 🔴 `bugId` UNTOUCHED, for the reason `triageFeedback` records at length — the link says
          // THIS REPORT IS ABOUT THAT ISSUE, which a status change does not make false.
        })
        .where('id', 'in', ids)
        .where('status', '=', expectedStatus)
        .returning('id')
        .execute();
      changed.push(...rows.map((r) => r.id));
    }
    return { changed, actionable };
  });

  // Outside the transaction, and best-effort by design: the audit row records a write that already
  // committed, so failing the operator's action because the log failed would turn a completed bulk
  // triage into an error message.
  await recordModActivityBatch({
    userId: input.moderatorId,
    entityType: 'feedback',
    entityIds: changed,
    activity: 'triage',
  });

  return { changed, actionable };
}

export type KnownIssueOption = {
  id: number;
  title: string;
  status: string;
  /** Resolved with `isBugClosed`, never by the caller eyeballing `status` — see `getKnownIssues`. */
  closed: boolean;
};

/**
 * The issue picker's options.
 *
 * 🔴 NOT FILTERED TO OPEN ISSUES, and that is measured rather than assumed: of 31 rows, 6 are
 * disabled and exactly ONE has `status = 'Open'`. An open-only picker is a one-item list, and the
 * report in front of the moderator is usually a second sighting of something already triaged —
 * which is the whole reason to attach rather than create. `status` rides along so the operator can
 * see they are attaching to something closed rather than discovering it afterwards.
 *
 * `disabled` IS filtered: that flag is the issue board's own "retired", and offering one is offering
 * a link the board will not show.
 *
 * Bounded because it is a picker, not a report. Ordered by id descending so the newest issues — the
 * ones a fresh duplicate is most likely about — are the ones that survive the bound.
 */
export async function getKnownIssues(limit = 200): Promise<KnownIssueOption[]> {
  const rows = await dbRead
    .selectFrom('Bug')
    .select(['id', 'title', 'status'])
    .where('disabled', '=', false)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  // 🔴 DECIDED HERE, WITH THE PREDICATE THIS MODULE ALREADY OWNS. `Bug.status` is a free-form
  // ClickUp string with no enum — "Complete", "Done", "Resolved" all mean closed — so a picker that
  // rendered the raw value and left the reader to recognise it would make the docstring's claim
  // ("so the operator can see they are attaching to something closed") depend on eyeballing free
  // text. One definition of closed, in one place.
  return rows.map((r) => ({ ...r, closed: isBugClosed(r.status) }));
}

/**
 * 🔴 Takes the client rather than closing over `dbRead`. This decides WHICH REFUSAL the operator
 * reads, so it has to see the same snapshot as the write that just failed: on the replica a row
 * deleted a moment ago is still present, and the answer flips from "that report is gone" to
 * "someone else already triaged it" — the exact confusion the split exists to remove. Callers pass
 * the primary, or the open transaction.
 *
 * ⚠️ NOT COVERED BY A TEST. The PGlite tier binds `dbRead` and `dbWrite` to one client, so a change
 * passing the replica here is invisible to it. Verified by reading the call sites only.
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
  /**
   * The ClickUp task this issue tracks. Omitted or null when no task was linked.
   *
   * 🔴 VALIDATED BY THE CALLER, AND IT HAS TO BE. This column is what the main app's ClickUp
   * webhook matches on to auto-close the entry, so a value it cannot parse a task id out of is an
   * issue that will never close itself — silently. The action gates on `isClickupTaskUrl` before
   * reaching here; this signature only records that null is the "no task" spelling, not ''.
   *
   * Optional rather than required: the overwhelmingly common call is "no task", and making every
   * caller write `clickupUrl: null` to say nothing taxes each one without catching anything — the
   * column is nullable and the default below is the same value they would have passed.
   */
  clickupUrl?: string | null;
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
          clickupUrl: input.clickupUrl ?? null,
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
 *
 * ⚠️ This clause is also what freezes a linked row: it can never be re-linked, at ANY status, and
 * this app ships no unlink control. If you are here because you are adding one, read the note in
 * `triageFeedback` above — it records why clearing `bugId` on a reopen was tried and reverted, and
 * why an unlink belongs in its own action rather than as a side effect of a status change.
 * (Deleting the `Bug` does null the column, via `ON DELETE SET NULL` on `Feedback_bugId_fkey` —
 * that is a cascade, not a control, and it takes the issue with it.)
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
