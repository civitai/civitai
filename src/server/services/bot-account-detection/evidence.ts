import { publicIpOnlySql } from '@civitai/shared/clickhouse-ip-filters';
import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import type { BotAccountCohortMember } from './cohort';
import { FILENAME_FINGERPRINT_PREFIX } from './fingerprint-keys';

/**
 * The COHORT-LEVEL evidence: the things that are only visible by looking at the whole day's signups
 * at once, rather than at one account.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL. Two of the heuristics are ring detectors — "how many OTHER
 * new accounts registered on this IP", "how many OTHER new accounts uploaded a file under this
 * name" — and a per-account scoring function cannot answer either. Scoring one account at a time is
 * exactly what misses a coordinated wave, which is the case the operator named as the reason for the
 * clustering heuristic. So the cohort is indexed ONCE per run, and each heuristic reads its member's
 * entry out of a precomputed index rather than issuing a query of its own.
 *
 * That split is also what keeps the heuristics testable: every scoring function in `heuristics/` is
 * pure over `CohortSignals`, and the only IO lives here.
 *
 * 🔴 THIS MODULE READS, AND THAT IS ALL IT CAN DO. Its Postgres surface is the one-method structural
 * port `EvidenceDb` below — a single `findMany`, no write method — and its ClickHouse surface is a
 * single `$query`. Both are asserted as ledgers in `__tests__/no-write-surface.test.ts`, which also
 * pins that every ClickHouse statement in this module is a bare `SELECT`. The operation ledger there
 * anchors on a `db` handle and therefore CANNOT see a ClickHouse call at all — that is precisely why
 * the ClickHouse ledger is a separate assertion rather than an assumed extension of the first.
 */

/**
 * The most image rows one run will read for the FILENAME source, across every account.
 *
 * 🔴 A BUDGET, NOT A PER-QUERY LIMIT, and the distinction is the whole point. The cohort is bounded
 * only by `MAX_COHORT_ACCOUNTS`, and a wave day is exactly when it approaches that; a per-query cap
 * multiplied by a page count is not a bound on anything. This is decremented as batches are read and
 * the walk stops when it is gone, so the worst case is fixed no matter how large the cohort gets.
 *
 * The cohort arrives NEWEST FIRST (see `cohort.ts`), so a budget that runs out spends itself on the
 * most recent signups and abandons the oldest — the same direction the account walk truncates in,
 * for the same reason. `filename_budget_exhausted` says when that happened; without it a partially
 * sampled run is indistinguishable from a cohort that simply uploaded less.
 *
 * 🔴 ITS OWN BUDGET, NOT A SHARE OF ANY OTHER. Two reads sharing one allowance is one read able to
 * spend the other's, and the direction that fails in is the one that silently blinds whichever read
 * runs second.
 */
export const MAX_FILENAME_SAMPLES = 20_000;

/** How many accounts' ids go into one `IN (…)` list. Matches the cohort's own page size so the two
 *  walks put the same width of list in front of the planner. */
export const EVIDENCE_CHUNK_SIZE = 500;

/**
 * The most filenames one MEMBER contributes to a run.
 *
 * 🔴 A PER-ACCOUNT CAP, NOT A CAP ON THE RESULT, AND THE DIFFERENCE IS THE WHOLE FIX. The filename
 * read used to be one `IN (…)` query per chunk under a single `take`, which is a cap on the RESULT
 * with an `ORDER BY id DESC` under it — so the newest rows in the chunk consumed the entire
 * allowance and EVICTED every other account in it. A ring of low-volume accounts is exactly what a
 * handful of prolific uploaders would push out, silently, in the direction that understates every
 * ring. That is the same defect `MAX_IPS_PER_ACCOUNT` was introduced to fix on the ClickHouse side
 * (`LIMIT n BY targetUserId`); this constant is its Postgres half, and the two now say the same
 * thing about the two sources.
 *
 * 🔴 MEASURED, NOT GUESSED. Over ten consecutive daily cohorts the global cap reached every member
 * on eight of them and collapsed on the other two — on one of those it reached barely half the
 * members that had uploaded anything, on the other about four fifths. The days it collapsed on are
 * the days the cohort uploaded MOST, which is the population this heuristic exists to look at. As
 * with `MAX_COHORT_ACCOUNTS`, the absolute daily figures are recorded outside this repository.
 *
 * 🔴 THE VALUE ITSELF IS A JUDGEMENT, AND THE ARGUMENT BELOW DOES NOT PICK IT. A ring shares ONE
 * filename, and `buildCohortSignals` folds a member's samples into a SET, so the marginal value of a
 * member's fiftieth sample is near zero. That establishes only that SOME N is enough, and it cuts
 * toward a SMALLER number rather than toward this one — nothing here measured where the knee is. 50
 * is chosen, not derived. What WAS measured is the coverage collapse the per-member SHAPE fixes,
 * above; the shape is the fix and this constant is a bound on it.
 *
 * 🔴 AND THE COVERAGE IT BUYS IS CONDITIONAL ON A BUDGET THAT DID NOT MOVE. The worst case is
 * `members × MAX_FILENAMES_PER_MEMBER` rows against `MAX_FILENAME_SAMPLES`, so every member is
 * reached UNCONDITIONALLY only while the cohort is at most
 * `MAX_FILENAME_SAMPLES / MAX_FILENAMES_PER_MEMBER` members — 400 at these values, against a
 * `MAX_COHORT_ACCOUNTS` of 25,000. Past that the walk still stops in member order and the members
 * after the stop contribute nothing, exactly as before. So the honest claim is NOT "every member
 * contributes, by construction": it is that no single member can consume another's allowance, and
 * that `sources.filenameBudgetExhausted` records when the walk stopped short. Raising this constant
 * narrows the unconditional range in direct proportion, which is the trade it should be read as.
 */
export const MAX_FILENAMES_PER_MEMBER = 50;

/**
 * How many members' filename reads are issued together.
 *
 * 🔴 IT IS A CONCURRENCY WINDOW, NOT AN `IN (…)` WIDTH, because the filename read is now one query
 * per account — see `filenameSampleArgs`. It is deliberately far below `EVIDENCE_CHUNK_SIZE`: that
 * number is the width of a list handed to the planner, and reusing it here would put 500 queries in
 * flight at once against a connection pool sized for the whole process.
 *
 * It is also the budget's checking cadence, so a run can overshoot `MAX_FILENAME_SAMPLES` by at
 * most `FILENAME_READ_BATCH_SIZE × MAX_FILENAMES_PER_MEMBER` rows before the walk stops.
 *
 * Sized small on purpose. Each statement is an index seek costing a fraction of a millisecond, so
 * the walk is bounded by round trips rather than by database work and there is little to buy by
 * widening it — while the process shares ONE connection pool with every other job, and a batch wide
 * enough to hold most of that pool would starve them for the length of a cohort walk.
 *
 * 🔴 NAME THE RIGHT POOL OR NAME NO NUMBER — AND THIS REPOSITORY CANNOT TELL YOU THE NUMBER. What
 * these statements queue on is `dbRead`'s own pool: `createEvidenceReader` defaults `db` to
 * `dbRead`, which is a stock `PrismaClient` over `DATABASE_REPLICA_URL` with no driver adapter, so
 * the pool is the Prisma query engine's, sized by `connection_limit` on that URL and otherwise by
 * Prisma's default. Neither value appears anywhere in this tree. `DATABASE_POOL_MAX` is NOT that
 * pool in either its schema-default or its live form — it sizes the `pg` pools on the raw-SQL /
 * Kysely path (`config.poolMax`, `src/server/db/db-helpers.ts`) and never reaches Prisma. This
 * paragraph used to say the read competed for "20 connections by default", which is a correctly
 * read number about a pool this read does not touch; a maintainer sizing a change against it would
 * be reasoning from a bound that does not apply. So the honest statement is: the bound is real, it
 * is set outside this repository, and anyone raising this constant has to read it off the deployed
 * `DATABASE_REPLICA_URL` rather than off anything here.
 */
export const FILENAME_READ_BATCH_SIZE = 10;

/**
 * The most image rows the STAGED-IMAGE read will take, across every account.
 *
 * 🔴 ITS OWN BUDGET, FOR THE REASON `MAX_FILENAME_SAMPLES` IS ITS OWN BUDGET. Two reads sharing one
 * allowance is one read able to spend the other's, and the direction that fails in is the one that
 * silently blinds whichever read runs second. The three sources are now three budgets, three
 * availability flags and three failure flags, and none of them can consume another.
 *
 * Sized the same as the filename budget because the population is the same table and the same
 * cohort. It is a DIFFERENT number that happens to be equal, not a shared one — the filename read
 * takes every image a member uploaded while this one takes only the staged subset, so they do not
 * move together and must not be expressed as one constant.
 */
export const MAX_STAGED_IMAGE_SAMPLES = 20_000;

/**
 * The most staged images one MEMBER contributes to a run.
 *
 * 🔴 PER-ACCOUNT, NOT A CAP ON THE RESULT — the whole point of `MAX_FILENAMES_PER_MEMBER`, applied
 * to the second image read rather than re-derived. A global `take` with an `ORDER BY id DESC` under
 * it lets the chunk's most prolific uploader EVICT every other account in it, silently, in the
 * direction that understates every account this heuristic is looking for.
 *
 * 🔴 IT BOUNDS THE SCORE AS WELL AS THE READ, which the filename cap does not. A filename sample
 * folds into a SET, so the fiftieth sample is worth nearly nothing; here the sample IS the
 * measurement — `asset-staging` scores on how MANY staged images a member has — so this cap is also
 * the largest count the heuristic can ever see. That is harmless only because the ramp saturates an
 * order of magnitude below it (`STAGED_ONE_AT`); it would stop being harmless the moment that
 * boundary approached this number, which is the coupling to check before moving either.
 */
export const MAX_STAGED_IMAGES_PER_MEMBER = 50;

/** One account's registration, as ClickHouse recorded it. */
export type RegistrationIpRow = { userId: number; ip: string };

/**
 * One filename an account uploaded under.
 *
 * 🔴 `name` IS NULLABLE IN THE SCHEMA (`Image.name String?`) and this type says so rather than
 * lying about it. A `null` is not a filename that failed to cluster — it is an upload that carried
 * no name at all — and the fold below drops it before it can become a key. Typing it as `string`
 * and letting a `null` arrive would put the string `"null"` in front of the cluster counter, where
 * it would look exactly like a wildly popular shared filename.
 */
export type FilenameSampleRow = { userId: number; name: string | null };

/**
 * One STAGED image: an upload that carries no generation metadata and was never attached to a post.
 *
 * 🔴 IT DELIBERATELY CARRIES NO IMAGE IDENTITY AND NO `meta`. The predicate ("no metadata, no post")
 * is applied in the QUERY — see `stagedImageSampleArgs` — so every row that arrives is already one
 * of these, and the only thing the heuristic then needs from a row is WHEN it was created. Selecting
 * `meta` to re-test it here would pull a generation-parameter blob per row for a question the index
 * has already answered, on the largest table the detector touches.
 *
 * `createdAt` is a timestamp rather than an id because the signal is a SAME-SECOND burst — an
 * automated batch — and ids are dense enough on this table that consecutive ids say nothing about
 * elapsed time. It is the one place this module reads `createdAt` as a value rather than as a bound.
 */
export type StagedImageRow = { userId: number; createdAt: Date };

/**
 * What one account's staged uploads amount to, as the heuristic reads them.
 *
 * Two numbers rather than a list, for the reason `CohortSignals` gives about sizes rather than
 * lists: nothing downstream needs to know WHICH uploads, and a per-member row list held for a
 * 25,000-member cohort is a different memory profile from two integers.
 */
export type StagedImageFacts = {
  /** How many staged images were sampled for this member. Bounded by `MAX_STAGED_IMAGES_PER_MEMBER`. */
  count: number;
  /**
   * The most of them sharing ONE whole second of creation time.
   *
   * 🔴 A SECOND, NOT A WINDOW, and that is the conservative reading on purpose. A rolling window
   * would also catch a batch straddling a second boundary — which this misses, and which is a stated
   * false NEGATIVE — but a window has a width nobody has measured, while a shared truncated second
   * is a fact about the rows rather than a parameter. `1` is the floor for any member with a staged
   * image (an upload always shares its own second with itself) and it is below the scoring boundary.
   */
  largestSameSecondBurst: number;
};

/**
 * The Postgres slice this module is allowed to use: one read, no write method, nothing to widen.
 *
 * Written structurally rather than as `typeof dbRead` for the reason `cohort.ts` gives at length —
 * naming the read handle buys convention, not reachability, because `dbRead` and `dbWrite` are the
 * same object wherever the replica URL equals the primary's. A type with no write method on it is
 * what actually holds the property.
 */
export type EvidenceDb = {
  /**
   * 🔴 TWO CALL SIGNATURES, ONE OPERATION. The filename read and the staged-image read are different
   * questions about the same table — the first reads every upload's NAME, the second reads only the
   * uploads that carry no metadata and no post — so they take different arguments and return
   * different rows. Written as overloads rather than as a union return type because a union would
   * force every call site to narrow a result whose shape the ARGUMENTS already determine, and the
   * narrowing would be a cast, i.e. a place for the two to silently disagree.
   *
   * It is still ONE member of the operation ledger (`image.findMany`) — see
   * `__tests__/no-write-surface.test.ts`, which records METHODS rather than call sites. That is the
   * honest reading: this widens what an already-permitted read is asked for, it does not grant a new
   * operation.
   */
  image: {
    findMany: {
      (args: ReturnType<typeof filenameSampleArgs>): Promise<FilenameSampleRow[]>;
      (args: ReturnType<typeof stagedImageSampleArgs>): Promise<StagedImageRow[]>;
    };
  };
};

/**
 * The ClickHouse slice: one method, which takes SQL and returns rows.
 *
 * 🔴 IT IS OPTIONAL BECAUSE THE REAL CLIENT IS. `~/server/clickhouse/client` exports
 * `clickhouse: CustomClickHouseClient | undefined` — it is `undefined` whenever `CLICKHOUSE_HOST` or
 * `CLICKHOUSE_USERNAME` is unset, and during a Next build. A detector that assumed it existed would
 * throw on those deployments; one that caught the error and moved on would report a clean run with a
 * silently dead heuristic, which is worse. So absence is a FIRST-CLASS STATE carried on
 * `CohortSignals.sources` and reported as a counter — see `collectCohortSignals`.
 */
/**
 * 🔴 THE `T extends object` CONSTRAINT MIRRORS THE REAL CLIENT AND IS NOT DECORATION. The shipped
 * `$query` is `<T extends object>(query: TemplateStringsArray | string, …values) => Promise<T[]>`;
 * a port declaring plain `<T>` is a DIFFERENT generic signature, so the real client is not assignable
 * to it and the union of the two is not callable at all. Narrowing the parameter to `string` is safe
 * in the other direction — a function accepting more shapes is assignable to one accepting fewer —
 * and it removes the tagged-template form this module deliberately does not use.
 */
export type EvidenceClickhouse = { $query: <T extends object>(sql: string) => Promise<T[]> };

export type EvidenceReader = {
  /**
   * Registration IPs for exactly these accounts. Empty when ClickHouse is unavailable.
   *
   * `createdAfter` is the run's own window opening — see `registrationIpSql`. Optional so a caller
   * that has no window still gets an (unpruned) answer rather than an empty one.
   */
  listRegistrationIps(userIds: number[], createdAfter?: Date): Promise<RegistrationIpRow[]>;
  /**
   * Up to `perMemberTake` recent uploaded filenames FOR EACH of these accounts, uploaded at or
   * before `createdBefore`.
   *
   * 🔴 PER MEMBER, NOT ACROSS THEM — the contract changed, and reading it the old way is the defect
   * it was changed to remove. See `MAX_FILENAMES_PER_MEMBER` for the coverage argument and
   * `filenameSampleArgs` for the plan that forced it. The result is bounded by
   * `userIds.length × perMemberTake`, so a caller sizing a budget must multiply.
   *
   * 🔴 EVERY READ ON THIS PORT IS NOW PER MEMBER, AND THAT IS NO LONGER A CAUTION. This docstring
   * used to name `listContentSamples` — a global-`take` read over `WHERE userId IN (…)
   * ORDER BY id DESC`, in which one prolific commenter's newest rows evicted every other account in
   * the chunk — as unfinished work sitting beside this one. That method is gone: its only consumer
   * was the comment-text fingerprint source, which was deleted, so the defect is closed by
   * deletion rather than by a fix.
   */
  listFilenameSamples(
    userIds: number[],
    perMemberTake: number,
    createdBefore?: Date
  ): Promise<FilenameSampleRow[]>;
  /**
   * Up to `perMemberTake` recent STAGED images FOR EACH of these accounts, uploaded at or before
   * `createdBefore` — the uploads carrying no generation metadata that were never attached to a
   * post.
   *
   * 🔴 PER MEMBER, like `listFilenameSamples` and for the same measured reason. The result is
   * bounded by `userIds.length × perMemberTake`, so a caller sizing a budget must multiply.
   *
   * 🔴 IT IS A SEPARATE READ RATHER THAN A WIDER `listFilenameSamples`, and the alternative was
   * considered rather than skipped. Folding the two would mean one statement selecting `meta` for
   * every upload a member made, because "is this staged" cannot be answered from the columns the
   * filename read wants — so the cost of the combined read is a generation-parameter blob per row
   * on the largest table here, where this read pays a `WHERE` clause instead and returns a strict
   * and usually much smaller subset.
   */
  listStagedImageSamples(
    userIds: number[],
    perMemberTake: number,
    createdBefore?: Date
  ): Promise<StagedImageRow[]>;
  /** Whether a registration-IP read can happen at all. `false` means the source is missing, NOT
   *  that the accounts share no IP. */
  hasRegistrationIps: boolean;
};

/**
 * The `findMany` arguments for ONE account's uploaded filenames.
 *
 * 🔴 ONE ACCOUNT, NOT A CHUNK OF THEM, AND THAT IS A CORRECTION TO A SHIPPED DEFECT WITH TWO
 * INDEPENDENT HALVES. This used to take a `userIds: number[]`, producing
 * `WHERE userId IN (…300 ids…) AND createdAt <= $1 ORDER BY id DESC LIMIT 1000`, and that one
 * statement was broken in two unrelated ways at once:
 *
 *  - **IT DID NOT COMPLETE.** `Image` is one of the largest tables on the site. The planner's
 *    selectivity estimate for a wide `IN (…)` list over it is off by three orders of magnitude — it
 *    expected six figures' worth of matching rows where the cohort owned three, so it chose a BACKWARD
 *    PRIMARY-KEY SCAN on the strength of the `LIMIT`, reasoning that 1000 of a million matches would
 *    turn up immediately. A day's new accounts own FEWER rows than the `LIMIT` asks for, so the
 *    limit was never reached, the early exit never happened, and the scan degenerated into a walk of
 *    the entire table. Measured on a replica: over 150 seconds, against 20 ms for the read below.
 *    In production the connection was closed under it first and the run recorded a source failure.
 *
 *    🔴 CHUNKING THE ID LIST DOES NOT FIX THIS, and it is the obvious thing to reach for. The same
 *    plan was measured at 100, 50 and 25 ids: the planner picks the same backward primary-key scan
 *    every time, because a narrower list lowers the estimate and the `LIMIT` proportionally, leaving
 *    the reasoning that produced the plan untouched. Smaller chunks are strictly worse — the same
 *    full-table walk, once per chunk.
 *
 *  - **IT DID NOT COVER THE COHORT.** See `MAX_FILENAMES_PER_MEMBER`: the `take` was global across
 *    the chunk, so a few prolific uploaders could own the newest rows and evict everyone else.
 *
 * The two halves are mutually exclusive by construction, which is why neither was ever visible: the
 * `LIMIT` is reachable exactly when the cohort is large enough for the coverage defect to bite, and
 * unreachable — hanging — on every other day. There is no day on which the old read was both
 * complete and correct.
 *
 * A single-account read has neither problem. `WHERE userId = $1` is an equality on the leading
 * column of `image_userid_id_idx`, so the index supplies the `ORDER BY id DESC` directly and the
 * `LIMIT` is satisfied or the group is exhausted within a page — measured at 0.1–0.2 ms per account,
 * including for the most prolific recent uploader on the site. The cost is one round trip per
 * member instead of one per chunk, which `FILENAME_READ_BATCH_SIZE` issues concurrently.
 *
 * 🔴 IT DOES NOT FILTER ON `ingestion` OR `needsReview`, AND THAT OMISSION IS THE SIGNAL. There is a
 * partial index on `Image` covering `ingestion = 'Scanned' AND needsReview IS NULL`, and adding
 * either predicate here would make this read use it — at the cost of removing exactly the rows this
 * heuristic depends on. The images a templated ring uploads are the ones the scanner blocks or holds
 * for review; an account that survives while its content is removed is the case the whole detector
 * exists to surface. A filter that reads as routine hygiene would delete the population under study
 * and leave a heuristic that still runs, still reports a number, and can no longer see anything.
 *
 * 🔴 `orderBy: { id: 'desc' }`, NOT `createdAt`. `schema.prisma` declares `(userId, postId)` and
 * `(userId, id)` (`image_userid_id_idx`) on `Image` and no `(userId, createdAt)`, so ordering on
 * `createdAt` would sort a member's whole image history outside any declared index. `id` is a
 * monotonic surrogate on an append-only table, so descending `id` IS descending upload order for
 * every practical purpose, and it is the order `stagedImageSampleArgs` reads its own surface in for
 * the same reason: the `take` bounds the read, so the order decides WHICH rows it keeps, and the
 * newest are the ones a wave is made of.
 *
 * ⚠️ The previous wording here claimed `Image` has no `(userId, createdAt)` index as a fact about
 * the database. It is a fact about `schema.prisma` only — the deployed table also carries an
 * undeclared `(userId, createdAt)` index. That does not change the choice above (`image_userid_id_idx`
 * serves this read directly, ordering included) but a docstring that asserts the live index set from
 * the schema file is asserting more than it checked, and this read's whole defect was a claim about
 * a plan nobody had looked at.
 *
 * `createdBefore` is an upper bound, not a lower one. A lower bound would be free of meaning — every
 * cohort account was created inside the run's window, so none of its images can predate it — while
 * the upper bound is what makes the read a stable snapshot at the run's own clock, so two runs over
 * the same window sample the same rows rather than drifting with whatever was uploaded meanwhile.
 *
 * Only `userId` and `name` are selected. Nothing else identifies a filename cluster, and an image's
 * url, hash and dimensions would only widen what this module holds in memory.
 */
export function filenameSampleArgs(userId: number, take: number, createdBefore?: Date) {
  return {
    where: {
      userId,
      ...(createdBefore ? { createdAt: { lte: createdBefore } } : {}),
    },
    select: { userId: true, name: true },
    orderBy: { id: 'desc' },
    take,
  } as const;
}

/**
 * The `findMany` arguments for ONE account's STAGED images.
 *
 * "Staged" is the conjunction of two facts about an upload, and neither alone is the signal:
 *  - `meta` is NULL — no generation metadata, so the image was not produced on this site. Both
 *    spellings count: a SQL `NULL` and the JSON literal `null`, which is what `Prisma.AnyNull`
 *    means and what `equals: null` on a `Json?` column will not compile to. The two are
 *    indistinguishable to anyone reading the site and differ only in how the row was written, so a
 *    filter matching one of them would score half of an identical population.
 *  - `postId` IS NULL — the upload was never attached to a post, so there is no page it appears on.
 *
 * 🔴 ONE ACCOUNT PER STATEMENT, WHICH IS NOT A STYLE CHOICE — see `filenameSampleArgs` for the
 * measured reason. A `userId IN (…)` list over `Image` with a `LIMIT` under it produced a backward
 * primary-key scan that walked the table for over 150 seconds and, on the days it did complete, let
 * a handful of prolific accounts evict everyone else in the chunk. Narrowing the list does not fix
 * it. `WHERE userId = $1` is an equality on the leading column of an index and neither failure is
 * reachable from it.
 *
 * 🔴 `postId: null` IS THE SELECTIVE PREDICATE AND IT HAS ITS OWN INDEX. `schema.prisma` declares
 * `(userId, postId)` as well as `(userId, id)`, so this read's `WHERE` is an exact prefix of the
 * first — an equality on `userId` and a value (NULL) on `postId`. The `meta` test is a filter on top
 * of whatever the planner chooses; it is not indexed and does not need to be, because the group it
 * filters is one account's unattached uploads.
 *
 * 🔴 `orderBy: { id: 'desc' }`, NOT `createdAt`, EVEN THOUGH THE SELECTED COLUMN IS `createdAt`.
 * There is no declared `(userId, createdAt)` index; ordering on it would sort outside every declared
 * index, and `id` is a monotonic surrogate on an append-only table so descending `id` IS descending
 * upload order for this purpose. The `take` bounds the read, so the order decides WHICH rows survive
 * it, and the newest are the ones a burst is made of. (The deployed table also carries an undeclared
 * `(userId, createdAt)` index — stated because the sibling docstring states it; it does not change
 * the choice, and reasoning from the schema file alone about the live index set is what got a
 * previous version of that docstring wrong.)
 *
 * 🔴 IT DOES NOT FILTER ON `ingestion` OR `needsReview`, for exactly the reason `filenameSampleArgs`
 * does not: the partial index those predicates would reach excludes the rows this heuristic is made
 * of. An upload the scanner blocked is still an upload, and an account whose content is removed
 * while the account survives is the case the detector exists to surface.
 *
 * `createdBefore` is an upper bound, so two runs over the same window sample the same rows rather
 * than drifting with whatever was uploaded meanwhile. There is no lower bound, deliberately: every
 * cohort account was created inside the run's window, so none of its images can predate it.
 */
export function stagedImageSampleArgs(userId: number, take: number, createdBefore?: Date) {
  return {
    where: {
      userId,
      postId: null,
      meta: { equals: Prisma.AnyNull },
      ...(createdBefore ? { createdAt: { lte: createdBefore } } : {}),
    },
    select: { userId: true, createdAt: true },
    orderBy: { id: 'desc' },
    take,
  } as const;
}

/**
 * The registration-IP query.
 *
 * Built as a separate exported function so the SQL is a value a test can assert on, rather than a
 * string buried in a call — the ClickHouse ledger in `__tests__/no-write-surface.test.ts` reads it
 * and pins that it is a bare `SELECT`.
 *
 * 🔴 `targetUserId`, NOT `userId`, AND THE TWO ARE NOT INTERCHANGEABLE. `Tracker.userActivity` writes
 * the account the event is ABOUT into `targetUserId`; a `Registration` event has no signed-in actor,
 * so the `userId` provenance column is not the new account. `apps/moderator/src/lib/server/bulk-ban.service.ts`
 * — the ban-evasion queries this heuristic is adapted from — reads `targetUserId` for exactly this
 * reason. (`csam.service.ts` filters the same table on `userId`; that is a different question about
 * a signed-in user's own activity, and copying its predicate here would silently return nothing.)
 *
 * 🔴 IDS ARE RE-VALIDATED AS INTEGERS AT THE JOIN, not trusted for having come from the database.
 * This is string-interpolated SQL — the ClickHouse client takes no bound parameters here — so the
 * only thing standing between a value and the statement is this filter. It is cheap and it is the
 * kind of guard that is correct until someone routes a different id source into it.
 *
 * 🔴 PRIVATE AND CARRIER-INTERNAL SPACE IS EXCLUDED, and this is the one filter without which the
 * heuristic is worse than absent. `publicIpOnlySql` comes from `@civitai/shared/clickhouse-ip-filters`
 * — the SAME predicate `apps/moderator/src/lib/server/reactor-lookup.service.ts` reads this table
 * with, moved to a shared module rather than copied, because a second hand-written copy is how the
 * two silently stop matching. That file names this heuristic's failure mode exactly: private space
 * "correlates everyone and therefore no one". Without it, six cohort members behind one `10.124/16`
 * address or one proxy reach a reported score, and ten of them top the run's whole distribution from
 * an infrastructure address — a confident finding about nothing, produced by omission rather than by
 * error. The predicate's own `ip != ''` guard is emitted FIRST because `isIPAddressInRange` raises on
 * an empty string; do not reorder the conjunction.
 *
 * 🔴 `time` IS THE PRUNING COLUMN AND THE WINDOW IS SEMANTICALLY FREE. Every cohort account was
 * created inside `createdAfter`, so its registration event cannot predate it; the predicate removes
 * no row this query wants and is the difference between a walk of up to fifty chunks scanning the
 * whole table and one scanning a day. Sibling readers of this table all bound on `time` for the same
 * reason. It is optional so a caller with no window gets a correct — merely unpruned — answer.
 *
 * `GROUP BY` rather than a plain select: an account can have several registration rows, and the
 * heuristic wants distinct (account, ip) pairs, not a row count.
 *
 * 🔴 THE CAP IS PER ACCOUNT, AND `LIMIT n` COULD NOT SAY THAT. `LIMIT ids.length * 4` was a cap on
 * the RESULT with no `ORDER BY` under it, so one account with many distinct registration addresses
 * could consume the whole allowance and EVICT every other account in its chunk — silently, and in
 * the direction that understates every ring. `LIMIT n BY targetUserId` is the per-group form
 * (precedent: `~/server/redis/caches.ts`'s `LIMIT 2000 BY userId`), so the comment and the code now
 * say the same thing: at most `MAX_IPS_PER_ACCOUNT` addresses per account, whatever any other
 * account in the chunk did. The total is still bounded, at `ids.length * MAX_IPS_PER_ACCOUNT`.
 * `ORDER BY` makes which addresses survive that per-account cap deterministic rather than whatever
 * the merge happened to emit.
 */
export const MAX_IPS_PER_ACCOUNT = 4;

/** ClickHouse's `DateTime` literal form — `YYYY-MM-DD hh:mm:ss`, UTC, no zone suffix. The `Z`-suffixed
 *  ISO string is not accepted, and the spelling below is the one every other ClickHouse writer in
 *  this repo uses. */
export const clickhouseDateTime = (d: Date): string =>
  d.toISOString().slice(0, 19).replace('T', ' ');

export function registrationIpSql(userIds: number[], createdAfter?: Date): string {
  const ids = userIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return '';
  const window = createdAfter ? `\n      AND time >= '${clickhouseDateTime(createdAfter)}'` : '';
  return `
    SELECT targetUserId, ip
    FROM default.userActivities
    WHERE targetUserId IN (${ids.join(',')})
      AND type = 'Registration'${window}
      AND ${publicIpOnlySql()}
    GROUP BY targetUserId, ip
    ORDER BY targetUserId, ip
    LIMIT ${MAX_IPS_PER_ACCOUNT} BY targetUserId
  `;
}

/** The real reader: Postgres over the replica, ClickHouse where it exists. */
export function createEvidenceReader(
  deps: { db?: EvidenceDb; ch?: EvidenceClickhouse | null } = {}
): EvidenceReader {
  const db = deps.db ?? dbRead;
  // `deps.ch` may be explicitly `null` to model an unavailable client in a test; `undefined` falls
  // back to the real one, which is itself possibly `undefined`.
  // Annotated rather than inferred: without it the ternary widens to a UNION of the port and the
  // real client's own type, and a union of two generic call signatures is not callable — the error
  // lands on the `$query` call below and names it "not callable", which reads as a defect in the
  // client rather than in this line.
  const ch: EvidenceClickhouse | null = deps.ch === undefined ? clickhouse ?? null : deps.ch;

  return {
    hasRegistrationIps: ch !== null,
    listRegistrationIps: async (userIds, createdAfter) => {
      const sql = registrationIpSql(userIds, createdAfter);
      if (!ch || !sql) return [];
      const rows = await ch.$query<{ targetUserId: string | number; ip: string }>(sql);
      // ClickHouse returns integers as strings over HTTP JSON; `Number` on an already-numeric value
      // is a no-op, so this covers both without asking which one arrived.
      return rows
        .map((r) => ({ userId: Number(r.targetUserId), ip: r.ip }))
        .filter((r) => Number.isFinite(r.userId) && !!r.ip);
    },
    listFilenameSamples: async (userIds, perMemberTake, createdBefore) => {
      if (!userIds.length || perMemberTake <= 0) return [];
      // 🔴 ONE READ PER MEMBER, ISSUED TOGETHER. The caller sizes the batch
      // (`FILENAME_READ_BATCH_SIZE`), so this fans out over exactly what it was handed rather than
      // over the whole cohort. `Promise.all` REJECTS on the first failure, which is the behaviour
      // the walk wants: a batch that partly failed is partial data, and the walk discards partial
      // data rather than scoring it. `collectCohortSignals` then empties the whole run's
      // `filenameSamples` and stops — see its filename loop.
      //
      // 🔴 DO NOT "MAKE THIS RESILIENT" WITH `Promise.allSettled` KEEPING THE FULFILLED HALF. That
      // is the obvious next edit and it inverts the module's central invariant: a fingerprint count
      // built from some of the members UNDERSTATES every ring that straddles the missing ones, and
      // understating is the direction that produces a confident zero. Worse, it would do so while
      // `evidence_source_read_failures` reported 0 — the run would look clean and read low. Pinned
      // by `__tests__/evidence.test.ts`, "ONE per-member read rejecting inside the fan-out REJECTS
      // THE WHOLE BATCH" — quoted verbatim so the pointer is greppable; the paraphrase that used to
      // stand here matched no test name.
      //
      // 🔴 AND THE DISCARD IS NOW APPLIED OVER ~500× MORE STATEMENTS THAN IT WAS SIZED FOR. The old
      // shape issued one statement per `EVIDENCE_CHUNK_SIZE` chunk — about 50 for a full cohort.
      // This one issues one per MEMBER, and `collectCohortSignals` is called once for the whole
      // cohort, so a run can issue up to `MAX_COHORT_ACCOUNTS` (25,000) of them. All-or-nothing over
      // 50 statements and all-or-nothing over 25,000 are different bets: one transient failure
      // anywhere in the walk now zeroes the entire day's filename signal. That is still the right
      // trade — the read it replaced completed NEVER, so the comparison is against no signal at all,
      // not against a partial one — but the policy was chosen at the smaller scale and anyone
      // resizing it should know it was not re-argued at this one.
      const perMember = await Promise.all(
        userIds.map((userId) =>
          db.image.findMany(filenameSampleArgs(userId, perMemberTake, createdBefore))
        )
      );
      return perMember.flat();
    },
    listStagedImageSamples: async (userIds, perMemberTake, createdBefore) => {
      if (!userIds.length || perMemberTake <= 0) return [];
      // 🔴 THE SAME ALL-OR-NOTHING FAN-OUT AS THE FILENAME READ, and deliberately not
      // `Promise.allSettled`. Here the case for it is even plainer than there: this heuristic scores
      // a member on how many staged uploads it HAS, so a batch that partly failed does not produce a
      // vaguer answer, it produces a LOWER one — a member whose rows went missing scores 0 and is
      // indistinguishable from a member with nothing staged. Keeping the fulfilled half would
      // publish that as a finding-free run with `evidence_source_read_failures: 0`.
      const perMember = await Promise.all(
        userIds.map((userId) =>
          db.image.findMany(stagedImageSampleArgs(userId, perMemberTake, createdBefore))
        )
      );
      return perMember.flat();
    },
  };
}

/**
 * How much of one filename is kept. Filenames are short; this exists to bound a pathological one
 * rather than because anything is expected to reach it.
 */
export const MAX_FILENAME_CHARS = 256;

/**
 * A filename reduced to the shape the clustering check compares.
 *
 * 🔴 IT IS NOT PROSE NORMALISATION, AND THE DELETED COMMENT-TEXT SOURCE IS WHY THAT IS WORTH SAYING.
 * This module used to carry a second normaliser for posted text — lowercase, mask links and digit
 * runs, strip punctuation, collapse whitespace, then reject anything under a character and token
 * floor — and the filename source deliberately did NOT reuse it. Two of that function's steps are
 * actively wrong for a filename, and the measurements that established it are the reason this
 * function looks as plain as it does:
 *
 *  - **DIGIT MASKING WOULD DESTROY THE SIGNAL BY OVER-CLUSTERING.** Under prose normalisation,
 *    `1900.jpg.jpeg` and `2749.jpg.jpeg` both become `nummask jpg jpeg` — so every `<digits>.jpg` on
 *    the site collapses into ONE key, and the largest cluster in any cohort becomes an artefact of
 *    camera and export naming rather than a ring. Masking is correct for prose, where the digits are
 *    the swapped payload; in a filename the digits are most of the identity.
 *  - **THE PROSE LENGTH FLOORS WOULD DISCARD ALMOST EVERYTHING.** Measured by executing the shipped
 *    normaliser rather than by reading it: `1900.jpg.jpeg` normalised to `"nummask jpg jpeg"` — 16
 *    characters, 3 tokens — and `logo.jpg` to `"logo jpg"` — 8 characters, 2 tokens. Both failed the
 *    24-character and 4-token floors; so did `IMG_20240103_112233.png` at 23 characters. Those
 *    floors existed because a SHORT PROSE STRING is written independently by unrelated people —
 *    "thanks", "nice work" — which is a fact about sentences and not about filenames. A filename is
 *    an identifier, and a short one is no weaker evidence than a long one.
 *
 * 🔴 SO WHAT DEFENDS AGAINST AN INNOCENT COLLISION HERE, given there is no length floor and no
 * stoplist of generic names: the cluster floor and the cohort itself. `CLUSTER_ZERO_AT` requires at
 * least THREE DISTINCT members before anything scores, and every member is an account less than a
 * day old. Three strangers who all signed up today and all uploaded `logo.jpg` is already the
 * observation worth making — a stoplist of "generic" names would remove precisely the filenames the
 * measured rings actually share, because a ring's whole method is to look unremarkable.
 *
 * LOWERCASING IS LOAD-BEARING rather than cosmetic: in one real cohort `Logo.jpg` and `logo.jpg`
 * were two separate clusters of ten, which is two groups below the scoring floor's interesting range
 * instead of one group of twenty.
 */
export function normalizeFilename(raw: string): string {
  return raw.slice(0, MAX_FILENAME_CHARS).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The cluster key for one uploaded filename, or `null` when there is nothing to key on.
 *
 * `null` for a missing or blank name — an upload with no filename is not a member of the
 * empty-string cluster, and letting it become one would build the largest cluster in every cohort
 * out of accounts that share nothing at all.
 */
export function filenameFingerprint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = normalizeFilename(raw);
  if (!normalized) return null;
  return `${FILENAME_FINGERPRINT_PREFIX}${normalized}`;
}

/**
 * Everything the cohort-level heuristics read, indexed once per run.
 *
 * 🔴 EVERY COUNT HERE IS A COUNT OF DISTINCT ACCOUNTS, never of rows. One account pasting the same
 * text ninety times is one member of that fingerprint's set, not ninety — otherwise a single
 * prolific spammer manufactures a ring out of itself and every other heuristic's independence is
 * lost. The same holds for IPs and domains. The sets are built with `Set`s for that reason and the
 * public shape exposes sizes rather than lists.
 */
export type CohortSignals = {
  /** userId → the registration IPs recorded for it. Absent means no row, or no ClickHouse. */
  ipsByUser: Map<number, string[]>;
  /** ip → how many DISTINCT cohort members registered on it. */
  membersPerIp: Map<string, number>;
  /** emailDomain → how many DISTINCT cohort members carry it. */
  membersPerDomain: Map<string, number>;
  /**
   * userId → the content fingerprints it produced, NAMESPACED.
   *
   * Keys carry `FILENAME_FINGERPRINT_PREFIX`; nothing reads a bare string out of here. See that
   * constant for why the namespace survives a single-source index.
   */
  fingerprintsByUser: Map<number, string[]>;
  /** namespaced fingerprint → how many DISTINCT cohort members produced it. */
  membersPerFingerprint: Map<string, number>;
  /**
   * userId → what its STAGED uploads amount to. Absent means the member had none SAMPLED, which is
   * not the same as having none — see `sources.stagedImages`.
   *
   * 🔴 IT IS A PER-MEMBER FACT, NOT A COHORT-WIDE INDEX, AND IT IS THE FIRST ONE HERE. Every other
   * entry on this type answers "how many OTHER accounts share this", because every other heuristic
   * is a ring detector. `asset-staging` is not: it is a statement about one account's own uploads,
   * and it lives here anyway because the READ is a cohort-level read — one budgeted walk of the
   * whole cohort, with its own availability flag — and splitting where a fact is indexed from where
   * it is fetched would give the heuristics two sources of evidence to reason about instead of one.
   */
  stagedImagesByUser: Map<number, StagedImageFacts>;
  /**
   * 🔴 WHICH SOURCES ACTUALLY ANSWERED. A heuristic reading an empty index cannot tell "these
   * accounts share nothing" from "nobody asked" — and the two call for opposite conclusions. Every
   * consumer of this type is expected to branch on these before reading a zero as a signal.
   */
  sources: {
    /**
     * 🔴 A SOURCE READ THREW. One boolean per source, and every one of them is `false` unless a read
     * actually raised — nothing about an empty cohort, an empty result or an absent client can set
     * one.
     *
     * 🔴 WHY THIS EXISTS ALONGSIDE THE AVAILABILITY FLAGS BELOW, which look like they already say
     * it. They do not, in the one direction that cost a day. An availability flag is `false` for
     * TWO reasons — the source was never there, or its read failed — and `registrationIps` in
     * particular is `false` on every deployment with no ClickHouse configured, which is a normal
     * state and not an incident. So "availability is false" cannot be alerted on, and the only
     * record of a real read failure was a log line. A run whose filename read died produced
     * counters that were, number for number, the counters of a day on which nobody uploaded
     * anything: the flag said 0, the sample counts said 0, the budget said untouched, and the run
     * reported success. These flags are the thing that is NOT zero when that happens.
     *
     * A consumer wanting "did anything break" sums them; a consumer wanting "was this heuristic
     * blind" still reads the availability flag, because a source that was never configured leaves
     * it just as blind.
     */
    readFailures: {
      registrationIps: boolean;
      filenameSamples: boolean;
      stagedImages: boolean;
    };
    /** ClickHouse was reachable and the registration-IP read ran. */
    registrationIps: boolean;
    /**
     * The filename read ran to completion. `false` means it never ran, or a batch THREW and the
     * partial data was discarded — NOT that the cohort uploaded nothing.
     *
     * 🔴 IT IS A SOURCE FLAG FOR THE SAME REASON `registrationIps` IS, and every source here has its
     * own. Reads fail independently — they hit different systems, and one can time out while another
     * returns — so folding two into a single flag would mean a dead read reporting a live one as
     * unavailable too, or, far worse in the direction that matters, a live read vouching for one
     * that never happened.
     */
    filenameSamples: boolean;
    /** The filename budget was spent before the whole cohort was sampled. */
    filenameBudgetExhausted: boolean;
    /** How many members had filenames sampled at all. */
    membersSampledForFilenames: number;
    /**
     * The staged-image read ran to completion. `false` means it never ran, or a batch THREW and the
     * partial data was discarded — NOT that the cohort staged nothing.
     *
     * 🔴 ITS OWN FLAG, AND THE `asset-staging` HEURISTIC IS THE ONE THAT MOST NEEDS IT. The ring
     * heuristics degrade from a dead source into a weaker version of the same claim; this one
     * degrades into a claim about a member's own uploads that is FLATLY WRONG — "this account has
     * staged nothing" said of an account that staged forty. There is no reading of a zero here that
     * is safe without this flag beside it.
     */
    stagedImages: boolean;
    /** The staged-image budget was spent before the whole cohort was sampled. */
    stagedImageBudgetExhausted: boolean;
    /** How many members had staged images sampled at all. */
    membersSampledForStagedImages: number;
  };
};

/** An index over nothing: the shape every map has before a run, and what a zero-member cohort
 *  yields. Sources default to "did not run", which is the safe reading. */
export function emptyCohortSignals(): CohortSignals {
  return {
    ipsByUser: new Map(),
    membersPerIp: new Map(),
    membersPerDomain: new Map(),
    fingerprintsByUser: new Map(),
    membersPerFingerprint: new Map(),
    stagedImagesByUser: new Map(),
    sources: {
      // 🔴 NOT "did not run" — these are the only fields here whose safe default is `false`
      // meaning what it says. An index over nothing is not a failure, and defaulting them to
      // `true` would make every empty cohort look like an outage.
      readFailures: {
        registrationIps: false,
        filenameSamples: false,
        stagedImages: false,
      },
      registrationIps: false,
      filenameSamples: false,
      filenameBudgetExhausted: false,
      membersSampledForFilenames: 0,
      stagedImages: false,
      stagedImageBudgetExhausted: false,
      membersSampledForStagedImages: 0,
    },
  };
}

/** Fixed-size slices of an id list, in order. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Fold the raw reads into the indexes, PURELY.
 *
 * Separated from the IO above because this is the half with the arithmetic in it — the distinct-account
 * counting, the fingerprinting, the domain tally — and it is the half worth testing exhaustively.
 * `collectCohortSignals` is then a loop that fetches and calls this.
 *
 * 🔴 THE DOMAIN TALLY IS BUILT FROM THE MEMBERS, NOT FROM A QUERY. `emailDomain` already rode in on
 * every cohort member, so the domain half of the clustering heuristic costs ZERO additional reads.
 * That is worth saying plainly: of the two signals in that heuristic, one is free and one needs
 * ClickHouse, so the heuristic keeps working — at reduced power, and it says so — when ClickHouse
 * does not.
 */
export function buildCohortSignals(args: {
  members: BotAccountCohortMember[];
  registrationIps: RegistrationIpRow[];
  /** Optional so a caller indexing one source at a time — a source-by-source grading run — does not
   *  have to pass an empty array to mean "did not read this". */
  filenameSamples?: FilenameSampleRow[];
  /** Optional for the same reason `filenameSamples` is. */
  stagedImageSamples?: StagedImageRow[];
  sources: CohortSignals['sources'];
}): CohortSignals {
  const signals = emptyCohortSignals();
  signals.sources = args.sources;

  // Only accounts that are actually IN the cohort may contribute to a cluster count. A registration
  // row for an id outside it — a banned account ClickHouse still remembers, a stale row — would
  // otherwise inflate an IP's tally without ever being scored.
  const inCohort = new Set(args.members.map((m) => m.userId));

  const ipMembers = new Map<string, Set<number>>();
  for (const row of args.registrationIps) {
    if (!inCohort.has(row.userId)) continue;
    const ips = signals.ipsByUser.get(row.userId);
    if (ips) {
      if (!ips.includes(row.ip)) ips.push(row.ip);
    } else signals.ipsByUser.set(row.userId, [row.ip]);
    let members = ipMembers.get(row.ip);
    if (!members) ipMembers.set(row.ip, (members = new Set()));
    members.add(row.userId);
  }
  for (const [ip, members] of ipMembers) signals.membersPerIp.set(ip, members.size);

  const domainMembers = new Map<string, Set<number>>();
  for (const member of args.members) {
    if (!member.emailDomain) continue;
    let members = domainMembers.get(member.emailDomain);
    if (!members) domainMembers.set(member.emailDomain, (members = new Set()));
    members.add(member.userId);
  }
  for (const [domain, members] of domainMembers) signals.membersPerDomain.set(domain, members.size);

  // 🔴 EVERY FINGERPRINT SOURCE FOLDS THROUGH ONE FUNCTION, and that is deliberate even now that
  // there is only one of them: the distinct-account counting is the part that must not differ
  // between sources. A second hand-written loop is how one source quietly starts counting ROWS while
  // another counts members — which is exactly the invariant this file's header calls out, and the
  // direction that lets a single prolific uploader manufacture a ring out of itself.
  const fingerprintMembers = new Map<string, Set<number>>();
  const addFingerprint = (userId: number, fingerprint: string | null) => {
    if (!inCohort.has(userId) || !fingerprint) return;
    const owned = signals.fingerprintsByUser.get(userId);
    if (owned) {
      if (!owned.includes(fingerprint)) owned.push(fingerprint);
    } else signals.fingerprintsByUser.set(userId, [fingerprint]);
    let members = fingerprintMembers.get(fingerprint);
    if (!members) fingerprintMembers.set(fingerprint, (members = new Set()));
    members.add(userId);
  };

  for (const sample of args.filenameSamples ?? [])
    addFingerprint(sample.userId, filenameFingerprint(sample.name));

  for (const [fingerprint, members] of fingerprintMembers)
    signals.membersPerFingerprint.set(fingerprint, members.size);

  // 🔴 THE STAGED-IMAGE FOLD COUNTS ROWS, NOT MEMBERS, AND IT IS THE ONE PLACE THAT IS CORRECT.
  // Every fold above counts DISTINCT ACCOUNTS because every heuristic above asks "how many others
  // share this" — one account pasting a text ninety times must not manufacture a ring out of itself.
  // `asset-staging` asks the opposite question: how much did THIS account stage. Its unit is the
  // upload, and deduplicating to one-per-member would collapse the entire signal to a boolean.
  const secondsByUser = new Map<number, Map<number, number>>();
  for (const row of args.stagedImageSamples ?? []) {
    if (!inCohort.has(row.userId)) continue;
    const facts = signals.stagedImagesByUser.get(row.userId) ?? {
      count: 0,
      largestSameSecondBurst: 0,
    };
    facts.count += 1;
    signals.stagedImagesByUser.set(row.userId, facts);

    // Truncated to a whole second. An UNPARSEABLE timestamp is counted as an upload and left out of
    // the burst tally: `NaN` is a usable Map key (SameValueZero), so admitting it would gather every
    // undated row of one member into a single fake "burst" — a maximal score built out of bad data,
    // which is the one direction this must not fail in.
    const millis = row.createdAt instanceof Date ? row.createdAt.getTime() : Number.NaN;
    if (!Number.isFinite(millis)) continue;
    const second = Math.floor(millis / 1000);
    let seconds = secondsByUser.get(row.userId);
    if (!seconds) secondsByUser.set(row.userId, (seconds = new Map()));
    seconds.set(second, (seconds.get(second) ?? 0) + 1);
  }
  for (const [userId, seconds] of secondsByUser) {
    const facts = signals.stagedImagesByUser.get(userId);
    if (!facts) continue;
    for (const n of seconds.values())
      if (n > facts.largestSameSecondBurst) facts.largestSameSecondBurst = n;
  }

  return signals;
}

/**
 * Read every cohort-level source and index the result.
 *
 * 🔴 A FAILING SOURCE DEGRADES THE RUN, IT DOES NOT FAIL IT — and it is recorded, which is the half
 * that matters. A ClickHouse outage must not lose a day of the cheap heuristics; it must also never
 * look like a day on which no accounts shared an IP. So the read is guarded, the flag on
 * `sources.registrationIps` carries the outcome, and `run.ts` turns it into a counter that a grading
 * pass can filter on. A run whose IP data was missing is not comparable with one whose was there,
 * and this flag is the only thing that says which kind you are looking at.
 *
 * 🔴 EVERY READ, NOT ONE. That paragraph described only the IP read for a while, and the Postgres
 * reads — on a replica that is exactly the thing that times out — had no guard at all, so a failure
 * there propagated out and lost the whole run including the heuristic that needs no source. Each
 * source now carries its own `sources.*` flag, and they exist so this docstring is a description
 * rather than an aspiration.
 *
 * Each walk is a BUDGET, not a per-chunk cap — see `MAX_FILENAME_SAMPLES`.
 *
 * 🔴 DEGRADING IS NOT THE SAME AS BEING LEGIBLE, and for a year it was treated as if it were. Every
 * guard below records an AVAILABILITY flag, and a run that degraded published counters identical to
 * a run that found nothing — so the degradation was visible only in a log line nobody was watching.
 * Each `catch` now also sets `sources.readFailures.*`, which is `false` on a quiet day and cannot be
 * made `true` by any amount of nothing. See that field.
 */
export async function collectCohortSignals(
  reader: EvidenceReader,
  members: BotAccountCohortMember[],
  opts: {
    chunkSize?: number;
    /**
     * How many members' filename reads are issued together. Defaults to `FILENAME_READ_BATCH_SIZE`.
     *
     * 🔴 ITS OWN KNOB BECAUSE IT IS ITS OWN UNIT — AND THE DEFAULT NO LONGER LOOKS AT `chunkSize`.
     * `chunkSize` is the width of an `IN (…)` list; the filename read has no `IN (…)` list any more,
     * so the two measure different things and reusing that number would put 500 concurrent queries
     * in flight. The default used to be `Math.min(chunkSize, FILENAME_READ_BATCH_SIZE)`, which made
     * a caller that narrowed the page size narrow filename concurrency along with it — two unrelated
     * dials moving together, which is the thing this paragraph says must not happen. An operator
     * running an on-demand pass with a small page to limit blast radius would have halved read
     * concurrency without asking to. In production `chunkSize` is `COHORT_PAGE_SIZE` (500) so the
     * `min` was always `FILENAME_READ_BATCH_SIZE` and nothing there changes; the coupling only ever
     * bound small-page callers and the tests, and the tests now pass this knob explicitly.
     *
     * 🔴 IT IS A TEST AFFORDANCE, DELIBERATELY. `run.ts` does not pass it and is not meant to: the
     * production value is the constant, and a second place to set it is a second place for the two
     * to disagree. Stated because "optional with a default" reads as a production dial someone
     * forgot to wire, and the previous round's fix made the DEFAULT honest without saying who calls
     * it. If a caller ever needs it, that caller is the reason to change this sentence.
     */
    filenameBatchSize?: number;
    maxFilenameSamples?: number;
    maxStagedImageSamples?: number;
    /**
     * Per-member cap on staged-image rows. Defaults to `MAX_STAGED_IMAGES_PER_MEMBER`.
     *
     * 🔴 A TEST AFFORDANCE, like `maxFilenamesPerMember`. `run.ts` passes the run-level budget and
     * NOT this one, so the per-member cap is the constant in production, always.
     */
    maxStagedImagesPerMember?: number;
    /**
     * Per-member cap on filename rows. Defaults to `MAX_FILENAMES_PER_MEMBER`.
     *
     * 🔴 ALSO A TEST AFFORDANCE — same reasoning as `filenameBatchSize` above. `run.ts` passes
     * `maxFilenameSamples` (the run-level budget) and NOT this one, so the per-member cap is the
     * constant in production, always.
     */
    maxFilenamesPerMember?: number;
    /** The run's window opening, passed through to the ClickHouse read as its `time` bound. */
    createdAfter?: Date;
    /** The run's own clock, passed to the filename read as its upper bound so the sample is a
     *  snapshot rather than a moving target. */
    createdBefore?: Date;
    checkCanceled?: () => void;
    log?: (name: string, data: Record<string, unknown>) => void;
  } = {}
): Promise<CohortSignals> {
  const chunkSize = opts.chunkSize ?? EVIDENCE_CHUNK_SIZE;
  const filenameBatchSize = opts.filenameBatchSize ?? FILENAME_READ_BATCH_SIZE;
  const filenameBudgetTotal = opts.maxFilenameSamples ?? MAX_FILENAME_SAMPLES;
  const filenamesPerMember = opts.maxFilenamesPerMember ?? MAX_FILENAMES_PER_MEMBER;
  const stagedBudgetTotal = opts.maxStagedImageSamples ?? MAX_STAGED_IMAGE_SAMPLES;
  const stagedPerMember = opts.maxStagedImagesPerMember ?? MAX_STAGED_IMAGES_PER_MEMBER;
  const checkCanceled = opts.checkCanceled ?? (() => undefined);
  const log = opts.log ?? (() => undefined);

  if (!members.length) return emptyCohortSignals();

  const userIds = members.map((m) => m.userId);
  const chunks = chunk(userIds, chunkSize);

  const registrationIps: RegistrationIpRow[] = [];
  let ipsFailed = false;
  let ipsRead = reader.hasRegistrationIps;
  if (ipsRead) {
    for (const ids of chunks) {
      checkCanceled();
      try {
        registrationIps.push(...(await reader.listRegistrationIps(ids, opts.createdAfter)));
      } catch (e) {
        // One failed chunk invalidates the IP signal for the WHOLE run, not just for its own
        // accounts: a cluster count built from a partial read UNDERSTATES every ring that straddles
        // the missing chunk, and understating is the direction that produces a confident zero. So
        // the partial data is discarded rather than scored.
        log('bot-account-detection:registration-ips-failed', {
          chunkIds: ids.length,
          error: e instanceof Error ? e.message : String(e),
        });
        registrationIps.length = 0;
        ipsRead = false;
        // 🔴 SET ONLY HERE, INSIDE THE `catch`. `ipsRead` is also `false` when ClickHouse is simply
        // not configured, which is a normal deployment and not an incident; this one is reachable
        // only by a read that threw.
        ipsFailed = true;
        break;
      }
    }
  }

  // The filename walk. It has its own budget and its own flags — see `MAX_FILENAME_SAMPLES` for why
  // the budgets are separate, and `sources.filenameSamples` for why the availability flags are.
  //
  // 🔴 IT DEGRADES THE RUN INSTEAD OF KILLING IT, for exactly the reason the IP read above does.
  // Without this a timeout on a busy replica propagated out of `runBotAccountDetection` and NO
  // REPORT WAS FILED AT ALL — the velocity heuristic's day lost with it, and the whole thing
  // indistinguishable from a producer that stopped running. Partial data is DISCARDED rather than
  // scored, again for the IP loop's reason: a cluster count built from some of the batches
  // understates every ring that straddles the missing ones, and understating is the direction that
  // produces a confident zero.
  //
  // `checkCanceled()` stays OUTSIDE the try. It throws on purpose, and swallowing that would turn
  // cancellation into a degraded run that keeps going.
  //
  // 🔴 IT WALKS ITS OWN BATCHES, NOT `chunks`, because the read is now one query per MEMBER rather
  // than one per chunk — see `filenameSampleArgs` for the plan that forced that and
  // `FILENAME_READ_BATCH_SIZE` for the width. The batch is also the budget's checking cadence, so a
  // run can overshoot `maxFilenameSamples` by at most `filenameBatchSize × filenamesPerMember` rows
  // before stopping. That overshoot is bounded and stated rather than eliminated: a per-row budget
  // check would mean tearing a member's sample in half, and half a member's filenames is exactly
  // the partial data every other guard here refuses to score.
  const filenameSamples: FilenameSampleRow[] = [];
  const filenameBatches = chunk(userIds, filenameBatchSize);
  let filenameBudget = filenameBudgetTotal;
  let filenameBudgetExhausted = false;
  let filenameMembersSampled = 0;
  let filenameRead = true;
  let filenameFailed = false;
  for (const ids of filenameBatches) {
    checkCanceled();
    if (filenameBudget <= 0) {
      filenameBudgetExhausted = true;
      break;
    }
    let rows: FilenameSampleRow[];
    try {
      // 🔴 PER MEMBER, NOT ACROSS THE BATCH. Passing the remaining budget here — which is what the
      // content read above does with its own — would restore the exact defect this read was changed
      // to remove: a cap shared across accounts is a cap one account can spend.
      rows = await reader.listFilenameSamples(ids, filenamesPerMember, opts.createdBefore);
    } catch (e) {
      log('bot-account-detection:filename-samples-failed', {
        chunkIds: ids.length,
        error: e instanceof Error ? e.message : String(e),
      });
      filenameSamples.length = 0;
      filenameRead = false;
      filenameFailed = true;
      filenameBudgetExhausted = false;
      filenameMembersSampled = 0;
      break;
    }
    filenameMembersSampled += ids.length;
    filenameBudget -= rows.length;
    filenameSamples.push(...rows);
  }
  if (filenameRead && filenameBudget <= 0 && filenameMembersSampled < members.length)
    filenameBudgetExhausted = true;

  // The staged-image walk. The filename walk above with its own budget, its own per-member cap and
  // its own flags — three separate reads, three separate failure modes, and no shared allowance.
  // It reuses `filenameBatches` rather than re-chunking the same id list at the same width: the
  // batch is a CONCURRENCY WINDOW over one connection pool, so two walks slicing one cohort with one
  // number is one decision expressed once, not a coincidence. (They still run one after the other,
  // so the pool sees `filenameBatchSize` statements at a time, not twice that.)
  const stagedImageSamples: StagedImageRow[] = [];
  let stagedBudget = stagedBudgetTotal;
  let stagedBudgetExhausted = false;
  let stagedMembersSampled = 0;
  let stagedRead = true;
  let stagedFailed = false;
  for (const ids of filenameBatches) {
    checkCanceled();
    if (stagedBudget <= 0) {
      stagedBudgetExhausted = true;
      break;
    }
    let rows: StagedImageRow[];
    try {
      rows = await reader.listStagedImageSamples(ids, stagedPerMember, opts.createdBefore);
    } catch (e) {
      log('bot-account-detection:staged-images-failed', {
        chunkIds: ids.length,
        error: e instanceof Error ? e.message : String(e),
      });
      // Partial data is DISCARDED here for a sharper reason than in the loops above: a member whose
      // batch failed has no rows, and no rows is the exact shape of a member with nothing staged. A
      // half-read run would publish "these accounts staged nothing" about accounts nobody looked at.
      stagedImageSamples.length = 0;
      stagedRead = false;
      stagedFailed = true;
      stagedBudgetExhausted = false;
      stagedMembersSampled = 0;
      break;
    }
    stagedMembersSampled += ids.length;
    stagedBudget -= rows.length;
    stagedImageSamples.push(...rows);
  }
  if (stagedRead && stagedBudget <= 0 && stagedMembersSampled < members.length)
    stagedBudgetExhausted = true;

  return buildCohortSignals({
    members,
    registrationIps,
    filenameSamples,
    stagedImageSamples,
    sources: {
      readFailures: {
        registrationIps: ipsFailed,
        filenameSamples: filenameFailed,
        stagedImages: stagedFailed,
      },
      registrationIps: ipsRead,
      filenameSamples: filenameRead,
      filenameBudgetExhausted,
      membersSampledForFilenames: Math.min(filenameMembersSampled, members.length),
      stagedImages: stagedRead,
      stagedImageBudgetExhausted: stagedBudgetExhausted,
      membersSampledForStagedImages: Math.min(stagedMembersSampled, members.length),
    },
  });
}
