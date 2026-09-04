import { dbRead } from '~/server/db/client';
import { ImageIngestionStatus, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * The cohort a bot-account run looks at: accounts created in the last day that have already posted
 * something visible.
 *
 * Shaped after `apps/moderator/src/lib/server/comment-spam.service.ts` — a read that fetches raw rows
 * and a PURE function that decides which of them belong in the queue. Everything the rule rejects, it
 * rejects in the pure half, which is the half worth testing.
 *
 * 🔴 WHAT ACTUALLY HOLDS THE NO-WRITE PROPERTY, precisely — because the obvious reading is wrong.
 * `dbRead` is NOT a structurally read-only client: `packages/civitai-db/src/client.ts` builds it as
 * `singleClient ? dbWrite : new PrismaClient(replica)`, so wherever `DATABASE_REPLICA_URL` equals
 * `DATABASE_URL` the two are THE SAME OBJECT, `.user.update()` included. Naming `dbRead` therefore
 * buys convention, not reachability, and "a detector that cannot reach a write client" would be a
 * comment stronger than the code.
 *
 * The property is held by two things that ARE checkable:
 *  1. the compile-time `CohortDb` type below — a structural port with five read methods and no write
 *     method, so this module cannot call one on the handle it is given however that handle was built;
 *  2. the asserted source ledger in `__tests__/no-write-surface.test.ts`, which fails if this
 *     module's database-operation set or its import set grows by so much as one member.
 * Both are mechanical. Neither depends on `dbRead` being a different connection from `dbWrite`.
 */

/** The window the detector is defined over. A day, because the operator's brief is "created in the
 *  last 24 hours"; a parameter rather than a literal so a backfill can widen it without editing a
 *  query, and so the tests can name a window without also naming a wall-clock. */
export const BOT_ACCOUNT_COHORT_WINDOW_HOURS = 24;

/**
 * How many accounts one page pulls.
 *
 * Deliberately well under the `userId IN (…)` lists this feeds: each page becomes four `IN` lists
 * against the content tables, so the page size is the width of those lists, not just a round-trip
 * count.
 */
export const COHORT_PAGE_SIZE = 500;

/**
 * The most accounts one run will look at, ever.
 *
 * 🔴 A 24h signup cohort on this site is not a small number and it is not a stable one — a
 * registration wave is exactly the condition this detector exists to notice, and exactly the
 * condition under which an unbounded read is worst. So the run stops here and SAYS it stopped
 * (`cohort_capped` / `cohort_cap` counters, and a sentence in the report summary). A silent cap is
 * indistinguishable from a quiet day, which is the reassuring-zero the abuse board was built to
 * remove.
 *
 * 🔴 THE VALUE IS SET AGAINST A MEASUREMENT, and the previous one was set against nothing. A
 * read-only count on a replica established the current 24h signup baseline; the figure itself is
 * recorded outside this repository. Against the former ceiling of 10,000 that was only ~13%
 * headroom, which is the worst possible place for a cap to sit: it never trips on an ordinary day,
 * so it looks proven, and it trips for the FIRST time on exactly the day a registration wave lands.
 * This ceiling is ~2.8x that baseline, so an ordinary day plus a wave of nearly twice the site's
 * normal daily signups still fits, and the cap goes back to being
 * a ceiling on work rather than a daily filter.
 *
 * It is still a bound and it is still cheap: at `COHORT_PAGE_SIZE` this is at most 50 account pages
 * and 400 `groupBy` reads — eight per page, see `createCohortReader` — all on the replica, all
 * keyset-paged.
 *
 * 🔴 The value is the SECOND line of defence, not the first. The walk below pages DESCENDING, so
 * whatever the cap is set to, the accounts it discards are the OLDEST of the window rather than the
 * newest — see `newAccountPageArgs`. Raising the number reduces how often truncation happens;
 * paging downwards is what makes truncation safe when it does.
 */
export const MAX_COHORT_ACCOUNTS = 25_000;

/** One row of the account read — who the account is, not what it did. */
export type NewAccountRow = {
  id: number;
  username: string | null;
  createdAt: Date;
};

/** Per-user counts from one content table. */
export type CountRow = { userId: number; count: number };

/**
 * The eight content reads, unmerged. Kept apart so the merge stays a pure, testable step.
 *
 * Two counts per surface, not one:
 *  - `comments`/`commentsV2`/`models`/`images` — the subset still on the site, i.e. what the
 *    visibility filters keep. Reported to the moderator.
 *  - `all*` — every row the account owns on that surface, moderation outcome or not. This is what
 *    decides MEMBERSHIP; see `selectCohortMembers`.
 */
export type RawPostCounts = {
  comments: CountRow[];
  commentsV2: CountRow[];
  models: CountRow[];
  images: CountRow[];
  allComments: CountRow[];
  allCommentsV2: CountRow[];
  allModels: CountRow[];
  allImages: CountRow[];
};

/** Three surface counts and their sum. The unit both halves of `PostCounts` are expressed in. */
export type SurfaceCounts = {
  comments: number;
  models: number;
  images: number;
  total: number;
};

/**
 * What an account posted.
 *
 * 🔴 `all.total` DECIDES MEMBERSHIP; `visible` is reported and never gates anything. The two were
 * one number until this split, and that number was the visible one — which made a moderator's own
 * action, or the scanner's, able to remove an account from the cohort entirely. See
 * `selectCohortMembers`.
 */
export type PostCounts = {
  /** Every row the account owns, whatever state it is in. Membership is decided on this. */
  all: SurfaceCounts;
  /** The subset a moderator can still open. Reported, never used for membership. */
  visible: SurfaceCounts;
  /** `all` minus `visible`, per surface. Derived here so the reason string cannot recompute it
   *  differently, and non-negative by construction — every visibility filter is a restriction of
   *  the unfiltered read over the same rows. */
  excluded: SurfaceCounts;
};

/** An account that is in the cohort, with the activity that put it there. */
export type BotAccountCohortMember = {
  userId: number;
  username: string | null;
  createdAt: Date;
  posts: PostCounts;
};

/**
 * The narrow slice of the database this detector is allowed to use.
 *
 * A port rather than a direct `dbRead` call so the run can be exercised end to end against a fake —
 * and so the fake can be a LEDGER: a test asserts the exact set of operations a run performs, which
 * fails if a write ever appears among them. Two read methods, no write method, nothing to widen.
 */
export type CohortReader = {
  /**
   * One keyset page of new accounts, ordered by id DESCENDING — newest first — with ids strictly
   * less than `before`. `before: undefined` seeds the walk at the newest account in the window.
   */
  listNewAccounts(args: {
    createdAfter: Date;
    before: number | undefined;
    take: number;
  }): Promise<NewAccountRow[]>;
  /** Per-user content counts for exactly these ids. */
  countPosts(userIds: number[]): Promise<RawPostCounts>;
};

/** The instant the window opens, given the run's own clock. */
export function cohortCutoff(now: Date, windowHours = BOT_ACCOUNT_COHORT_WINDOW_HOURS): Date {
  return new Date(now.getTime() - windowHours * 3_600_000);
}

/**
 * The `User.findMany` arguments for one page.
 *
 * Exported and built separately from the call that uses it because this — the window, the
 * exclusions, the keyset — is the part with behaviour. Asserting it is how "selects the right
 * window" is testable without a database.
 *
 * `bannedAt`/`deletedAt` are excluded in SQL rather than in the pure selector: unlike "has posted",
 * they are not a judgement, and filtering them here keeps them out of the `IN` lists the content
 * reads build.
 *
 * 🔴 KEYSET, AND IT PAGES DOWNWARDS. Keyset rather than OFFSET because the window's newest end grows
 * while the run walks it and an OFFSET page skips rows as it does. DESCENDING because the walk is
 * capped, and the direction decides WHICH accounts a capped run throws away:
 *
 *  - ascending, the unread remainder is the HIGHEST ids — the most recent signups. That is the
 *    registration wave this detector exists to notice, discarded, while `capped: true` reads as
 *    "we saw the first N". At the measured baseline the old cap did not trip on an ordinary day and
 *    would have tripped first on exactly the day it must not.
 *  - descending, the unread remainder is the LOWEST ids — the oldest accounts of the window, which
 *    have had a full day to be seen by every other surface and are the harmless end to drop.
 *
 * `id` is the primary key, so the order is TOTAL and the keyset is stable: no two rows tie, and
 * `id < before` cannot re-emit or skip a row. Descending is also the stabler walk under concurrent
 * inserts — new signups land ABOVE the seed page and are simply outside this run's window rather
 * than a moving target the walk chases.
 *
 * `before: undefined` means "no lower-than bound yet", i.e. start at the newest. It is spelled as
 * `undefined` rather than a sentinel id because Prisma drops an `undefined` field from the WHERE
 * clause entirely, where a sentinel would have to be a real integer and `User.id` is an `int4` whose
 * maximum a future migration could reach.
 */
export function newAccountPageArgs(args: {
  createdAfter: Date;
  before: number | undefined;
  take: number;
}) {
  return {
    where: {
      createdAt: { gte: args.createdAfter },
      id: args.before === undefined ? undefined : ({ lt: args.before } as const),
      bannedAt: null,
      deletedAt: null,
    },
    select: { id: true, username: true, createdAt: true },
    orderBy: { id: 'desc' },
    take: args.take,
  } as const;
}

/**
 * 🔴 WHAT "STILL ON THE SITE" MEANS — AND WHY IT IS NOT THE MEMBERSHIP RULE.
 *
 * These filters answer one question: of what this account posted, how much can a moderator open
 * right now. That is worth reporting, because the reason string on every finding is read by a human
 * whose next action is to go and look, and "4 images" meaning "four things you can open" is a
 * different sentence from "four rows, some of which we already removed".
 *
 * 🔴 IT IS NOT WHAT DECIDES WHO IS IN THE COHORT, and using it that way was a hole with a name on
 * it. An account registered two hours ago that uploads forty images the scanner then marks
 * `Blocked` is the canonical bot wave — and under a visible-only membership rule it counted zero,
 * produced no `groupBy` row, and was therefore not a member, not scored and not reported, while
 * `scanned` still counted it. The run summary then read "Scanned N account(s); 0 had posted": a
 * reassuring zero produced by the detector working exactly as written. The partial case is worse —
 * 39 of 40 blocked leaves "1 image", so a moderator sorting by volume puts the worst account last.
 * `tosViolation` and `hidden` behave identically, so one moderator action could drop a whole
 * account out of the cohort.
 *
 * So membership is decided on the UNFILTERED counts (`allContentCountArgs`) and these filtered
 * counts are reported alongside them, with the difference stated in the finding. See
 * `selectCohortMembers` and `buildFinding`.
 *
 * The rule, per surface, and what each clause excludes:
 *  - `Comment` / `CommentV2`: `hidden` is not true, `tosViolation` is false. Both are moderation
 *    outcomes: the comment is already gone from the page. `hidden` is a NULLABLE boolean, so
 *    `{ not: true }` and not `false` — the repo's own idiom (`jobs/entity-moderation.ts`), and the
 *    one that keeps the never-hidden rows whose column is NULL.
 *  - `Model`: `status` is `Published`, not soft-deleted, not TOS-flagged. `Draft` and `Training` are
 *    not posted yet; `Unpublished`/`UnpublishedViolation`/`Deleted` are posted and then withdrawn;
 *    `Scheduled` is a promise to publish and has no page to open.
 *  - `Image`: attached to a post (`postId` is not null — a detached image is a leftover with nowhere
 *    to be viewed), not TOS-flagged, and its ingestion is not `Blocked`/`NotFound`.
 *
 * 🔴 `ingestion: Pending` is DELIBERATELY KEPT, and it is the one judgement call here. A fresh
 * upload sits Pending for minutes; a bot wave's images are Pending *by definition* at the moment
 * this detector looks at them. Excluding Pending would be excluding the signal, and unlike Blocked
 * it is a scan that has not finished rather than a decision to remove. Blocked and NotFound are
 * decisions, so they go.
 *
 * 🔴 THAT CLAUSE IS WHY THE REPORTED NUMBER IS NOT CALLED "VISIBLE". A Pending image is counted
 * here and is precisely the case a moderator cannot view yet, so "N visible image(s)" over-claimed
 * against this set's own definition. The set is "not removed, withheld or unpublished" — the
 * finding says "still on the site" and states the Pending carve-out in the same sentence rather
 * than leaving a reader to infer it.
 *
 * No time predicate, deliberately: every account in the list is younger than the window, so its
 * content is too, and a redundant `createdAt` filter would only cost the planner an extra condition
 * on a column these tables are not being seeked by.
 */
// NOT a blanket `as const`, and not a plain literal either — Prisma's generated `groupBy` argument
// type wants both at once. `by` must be a MUTABLE array of the model's scalar-field enum (a
// readonly tuple is rejected), while `_count._all` must be the literal `true` (a widened `boolean`
// is rejected). Getting either wrong produces the same error four times over, once per model,
// which reads as four unrelated faults.
const groupByUser = <W>(where: W) => ({
  by: ['userId'] as ['userId'],
  where,
  _count: { _all: true as const },
});

/** Comments still on the page: not hidden by moderation, not TOS-flagged. */
export function commentCountArgs(userIds: number[]) {
  return groupByUser({
    userId: { in: userIds },
    hidden: { not: true },
    tosViolation: false,
  });
}

/** The newer comment system, same rule. */
export function commentV2CountArgs(userIds: number[]) {
  return groupByUser({
    userId: { in: userIds },
    hidden: { not: true },
    tosViolation: false,
  });
}

/** Models with a live page: published, not soft-deleted, not TOS-flagged. */
export function modelCountArgs(userIds: number[]) {
  return groupByUser({
    userId: { in: userIds },
    status: ModelStatus.Published,
    deletedAt: null,
    tosViolation: false,
  });
}

/** Images a moderator can open: attached to a post, not TOS-flagged, not blocked or missing. */
export function imageCountArgs(userIds: number[]) {
  return groupByUser({
    userId: { in: userIds },
    postId: { not: null },
    tosViolation: false,
    ingestion: { notIn: [ImageIngestionStatus.Blocked, ImageIngestionStatus.NotFound] },
  });
}

/**
 * Everything the account posted on one surface, with no visibility judgement at all.
 *
 * 🔴 ONE BUILDER FOR ALL FOUR SURFACES, deliberately, where the visible reads have four. There is
 * nothing per-surface to express: the question is "does this row belong to this account", and the
 * four filtered builders differ only because each surface spells "removed" in its own columns. A
 * second builder per surface here would be four copies of the same clause and four places for a
 * stray predicate to reappear — which is the exact defect this pair exists to undo.
 *
 * Soft-deleted, blocked, hidden and TOS-flagged rows are all counted. That is the point: a
 * moderation outcome is evidence about the account, not a reason to stop looking at it.
 */
export function allContentCountArgs(userIds: number[]) {
  return groupByUser({ userId: { in: userIds } });
}

type GroupByRow = { userId: number; _count: { _all: number } };

const toCountRows = (rows: GroupByRow[]): CountRow[] =>
  rows.map((r) => ({ userId: r.userId, count: r._count._all }));

/**
 * The five database operations this detector performs, and the only ones it can.
 *
 * 🔴 A READ-ONLY SURFACE BY CONSTRUCTION. Five methods, all reads, no `dbWrite` anywhere in the
 * type — so the adapter below cannot mute, ban or file a restriction even if someone asked it to,
 * and a test can hand it a recorder and assert the exact set of operations a run performed. The
 * asserted ledger in `__tests__/no-write-surface.test.ts` fails if this type grows a method.
 *
 * Written as a structural type rather than `typeof dbRead` so a fake satisfies it, which is what
 * makes the seam between "the arguments we build" and "the call we make" testable at all. A builder
 * that is correct and never passed to the client is the shape of a fix that changes nothing.
 */
/**
 * 🔴 `groupBy`'s RESULT is `unknown`, and that is forced rather than lazy. Prisma's generated
 * `groupBy` is a generic whose argument type depends on the expected RETURN type, so naming a
 * concrete row type here makes the real client fail to satisfy this interface — TS folds the
 * expected result into the parameter constraint and reports the args object as "missing length,
 * pop, push and 35 more" from an array type. Narrowing happens at the call site instead
 * (`toCountRows`), where the shape is asserted once. `findMany` has no such problem and keeps its
 * real row type, which is what pins the `select` in `newAccountPageArgs` to the fields used here.
 */
type GroupByFn<A> = (args: A) => Promise<unknown>;

/** Every `groupBy` argument shape one surface is asked for: its own visibility filter, and the
 *  unfiltered count that decides membership. */
type Grouped<A> = { groupBy: GroupByFn<A | ReturnType<typeof allContentCountArgs>> };

export type CohortDb = {
  user: { findMany: (args: ReturnType<typeof newAccountPageArgs>) => Promise<NewAccountRow[]> };
  comment: Grouped<ReturnType<typeof commentCountArgs>>;
  commentV2: Grouped<ReturnType<typeof commentV2CountArgs>>;
  model: Grouped<ReturnType<typeof modelCountArgs>>;
  image: Grouped<ReturnType<typeof imageCountArgs>>;
};

/**
 * The real reader, over the read replica.
 *
 * `commentsV2` is read alongside `comments` because the two comment systems both still carry
 * traffic and an account that only used the newer one would otherwise read as having posted nothing
 * — a false negative in the one direction a detector must not have.
 */
export function createCohortReader(db: CohortDb = dbRead): CohortReader {
  return {
    listNewAccounts: (args) => db.user.findMany(newAccountPageArgs(args)),
    countPosts: async (userIds) => {
      if (!userIds.length) return emptyRawPostCounts();
      // 🔴 EIGHT READS PER PAGE, NOT FOUR — the visible count and the unfiltered count of each
      // surface. That is the price of deciding membership on everything an account posted while
      // still telling a moderator how much of it is still up, and it is paid on purpose. All eight
      // are per-user counts over the same `userId IN (…)` list on the replica, issued together.
      const [comments, commentsV2, models, images, allC, allC2, allM, allI] = await Promise.all([
        db.comment.groupBy(commentCountArgs(userIds)),
        db.commentV2.groupBy(commentV2CountArgs(userIds)),
        db.model.groupBy(modelCountArgs(userIds)),
        db.image.groupBy(imageCountArgs(userIds)),
        db.comment.groupBy(allContentCountArgs(userIds)),
        db.commentV2.groupBy(allContentCountArgs(userIds)),
        db.model.groupBy(allContentCountArgs(userIds)),
        db.image.groupBy(allContentCountArgs(userIds)),
      ]);
      return {
        comments: toCountRows(comments as GroupByRow[]),
        commentsV2: toCountRows(commentsV2 as GroupByRow[]),
        models: toCountRows(models as GroupByRow[]),
        images: toCountRows(images as GroupByRow[]),
        allComments: toCountRows(allC as GroupByRow[]),
        allCommentsV2: toCountRows(allC2 as GroupByRow[]),
        allModels: toCountRows(allM as GroupByRow[]),
        allImages: toCountRows(allI as GroupByRow[]),
      };
    },
  };
}

/** An empty result for every surface — the shape `countPosts` returns when asked about nobody. */
export function emptyRawPostCounts(): RawPostCounts {
  return {
    comments: [],
    commentsV2: [],
    models: [],
    images: [],
    allComments: [],
    allCommentsV2: [],
    allModels: [],
    allImages: [],
  };
}

const zeroSurface = (): SurfaceCounts => ({ comments: 0, models: 0, images: 0, total: 0 });

/**
 * The eight reads folded into one per-user record.
 *
 * Comments from both systems add together — they are the same act to a moderator, and splitting
 * them in the report would invite reading a migration artefact as a signal.
 *
 * 🔴 `excluded` is SUBTRACTED, not read. There is no eighth query for "how much was taken down":
 * it is `all` minus `visible` on the same rows at the same instant, which is the only definition
 * under which the three numbers in a finding are guaranteed to add up. It is floored at zero so a
 * torn read — the unfiltered and filtered counts of one surface are separate statements against a
 * replica, and a row can be created between them — reports 0 excluded rather than a negative, which
 * would read as corrupt data in the one sentence a moderator acts on.
 */
export function mergePostCounts(raw: RawPostCounts): Map<number, PostCounts> {
  const merged = new Map<number, PostCounts>();
  const get = (userId: number) => {
    let row = merged.get(userId);
    if (!row)
      merged.set(
        userId,
        (row = { all: zeroSurface(), visible: zeroSurface(), excluded: zeroSurface() })
      );
    return row;
  };
  for (const r of raw.comments) get(r.userId).visible.comments += r.count;
  for (const r of raw.commentsV2) get(r.userId).visible.comments += r.count;
  for (const r of raw.models) get(r.userId).visible.models += r.count;
  for (const r of raw.images) get(r.userId).visible.images += r.count;
  for (const r of raw.allComments) get(r.userId).all.comments += r.count;
  for (const r of raw.allCommentsV2) get(r.userId).all.comments += r.count;
  for (const r of raw.allModels) get(r.userId).all.models += r.count;
  for (const r of raw.allImages) get(r.userId).all.images += r.count;
  for (const row of merged.values()) {
    for (const side of [row.all, row.visible])
      side.total = side.comments + side.models + side.images;
    row.excluded = {
      comments: Math.max(0, row.all.comments - row.visible.comments),
      models: Math.max(0, row.all.models - row.visible.models),
      images: Math.max(0, row.all.images - row.visible.images),
      total: Math.max(0, row.all.total - row.visible.total),
    };
  }
  return merged;
}

/**
 * Which of a page's accounts are in the cohort.
 *
 * Pure, and the only place membership is decided. An account with no content is not a bot-account
 * candidate under this brief — a signup that has done nothing is a signup, and including it would
 * put most of a day's registrations in front of a moderator.
 *
 * 🔴 `all.total`, NOT `visible.total`. The test is "did this account post anything at all", so a
 * moderation outcome — the scanner blocking every upload, a moderator hiding a comment, a
 * TOS flag — cannot take the account out of the cohort. It goes into the finding instead, where a
 * human can see it. Reading `visible.total` here restores the hole this split exists to close, and
 * does so silently: the run reports a smaller cohort and nothing anywhere reports an error.
 *
 * Membership is the only thing that changed. `visible` is still what the finding leads with,
 * because it is still what a moderator can go and look at.
 */
export function selectCohortMembers(
  accounts: NewAccountRow[],
  counts: Map<number, PostCounts>
): BotAccountCohortMember[] {
  const members: BotAccountCohortMember[] = [];
  for (const account of accounts) {
    const posts = counts.get(account.id);
    if (!posts || posts.all.total === 0) continue;
    members.push({
      userId: account.id,
      username: account.username,
      createdAt: account.createdAt,
      posts,
    });
  }
  return members;
}

export type CohortResult = {
  /** Newest account first — the walk's own order, see `newAccountPageArgs`. */
  members: BotAccountCohortMember[];
  /** Accounts read, before the has-posted filter. The denominator the counters report. */
  scanned: number;
  /** Accounts were left unread because the cap was reached. They are the OLDEST of the window. */
  capped: boolean;
  /** Reads the walk performed, including the probe below. Reported so a run that did no paging is
   *  distinguishable from one that paged and found nothing. */
  pages: number;
};

/**
 * Walk the window, page by page, up to the cap — newest account first.
 *
 * 🔴 `capped` means accounts were LEFT UNREAD, and it is measured rather than inferred from
 * `scanned === maxAccounts`. The two differ on the case a moderator would act on: a cohort whose
 * size is exactly the cap is complete, and reporting that as truncated sends someone looking for
 * accounts that do not exist. So when the budget runs out the walk spends one extra 1-row read to
 * ask whether anything follows. Those rows are not scanned and not scored — the probe answers one
 * question and its result is discarded.
 *
 * 🔴 WHEN IT IS CAPPED, THE UNREAD REMAINDER IS THE OLDEST END. The walk descends by `id`, so the
 * cursor moves from the newest signup in the window towards the oldest and truncation lands on
 * accounts that have already had a full day of exposure. That is stated in the report summary in
 * those words, because "TRUNCATED at the N-account cap" on its own reads as "we saw the first N"
 * and the natural reading of "first" is the opposite of what happens.
 *
 * `checkCanceled` is called once per page rather than once per run: the scheduler cancels by closing
 * the response, and a walk that never looks keeps reading pages after nobody is listening.
 */
export async function collectCohort(
  reader: CohortReader,
  opts: {
    createdAfter: Date;
    pageSize?: number;
    maxAccounts?: number;
    /** Throws if the job has been canceled. Optional so the core has no job-context dependency. */
    checkCanceled?: () => void;
  }
): Promise<CohortResult> {
  const pageSize = opts.pageSize ?? COHORT_PAGE_SIZE;
  const maxAccounts = opts.maxAccounts ?? MAX_COHORT_ACCOUNTS;
  const checkCanceled = opts.checkCanceled ?? (() => undefined);

  const members: BotAccountCohortMember[] = [];
  // No lower-than bound yet: the first page starts at the newest account in the window.
  let before: number | undefined = undefined;
  let scanned = 0;
  let pages = 0;
  let capped = false;

  for (;;) {
    checkCanceled();
    const remaining = maxAccounts - scanned;
    if (remaining <= 0) {
      const probe = await reader.listNewAccounts({
        createdAfter: opts.createdAfter,
        before,
        take: 1,
      });
      pages += 1;
      capped = probe.length > 0;
      break;
    }
    const take = Math.min(pageSize, remaining);
    const accounts = await reader.listNewAccounts({
      createdAfter: opts.createdAfter,
      before,
      take,
    });
    pages += 1;
    if (!accounts.length) break;

    scanned += accounts.length;
    // Descending, so the LAST row of the page is the lowest id seen and the next page is strictly
    // below it.
    before = accounts[accounts.length - 1].id;

    const counts = mergePostCounts(await reader.countPosts(accounts.map((a) => a.id)));
    members.push(...selectCohortMembers(accounts, counts));

    // A short page is the end of the window: the reader was asked for `take` and had fewer.
    if (accounts.length < take) break;
  }

  return { members, scanned, capped, pages };
}
