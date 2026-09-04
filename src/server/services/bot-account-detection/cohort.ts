import { dbRead } from '~/server/db/client';

/**
 * The cohort a bot-account run looks at: accounts created in the last day that have already posted
 * something.
 *
 * Shaped after `apps/moderator/src/lib/server/comment-spam.service.ts` — a read that fetches raw rows
 * and a PURE function that decides which of them belong in the queue. Everything the rule rejects, it
 * rejects in the pure half, which is the half worth testing.
 *
 * 🔴 READ REPLICA ONLY. This module names `dbRead` and nothing else. That is not a performance
 * preference here, it is the property the shadow phase rests on: a detector that cannot reach a write
 * client cannot mute, ban, or file a restriction however wrong its scoring turns out to be. The
 * asserted ledger in `__tests__/no-write-surface.test.ts` fails if this file's database surface grows.
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
 */
export const MAX_COHORT_ACCOUNTS = 10_000;

/** One row of the account read — who the account is, not what it did. */
export type NewAccountRow = {
  id: number;
  username: string | null;
  createdAt: Date;
};

/** Per-user counts from one content table. */
export type CountRow = { userId: number; count: number };

/** The four content reads, unmerged. Kept apart so the merge stays a pure, testable step. */
export type RawPostCounts = {
  comments: CountRow[];
  commentsV2: CountRow[];
  models: CountRow[];
  images: CountRow[];
};

/** What an account posted, per surface. `total` is what decides membership. */
export type PostCounts = {
  comments: number;
  models: number;
  images: number;
  total: number;
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
  /** One keyset page of new accounts, ordered by id ascending, ids strictly greater than `after`. */
  listNewAccounts(args: {
    createdAfter: Date;
    after: number;
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
 * reads build. Keyset on `id` rather than an OFFSET because the cohort's newest end grows while the
 * run walks it, and an OFFSET page would skip rows as it did.
 */
export function newAccountPageArgs(args: { createdAfter: Date; after: number; take: number }) {
  return {
    where: {
      createdAt: { gte: args.createdAfter },
      id: { gt: args.after },
      bannedAt: null,
      deletedAt: null,
    },
    select: { id: true, username: true, createdAt: true },
    orderBy: { id: 'asc' },
    take: args.take,
  } as const;
}

/**
 * The `groupBy` arguments each content read uses.
 *
 * No time predicate, deliberately: every account in the list is younger than the window, so its
 * content is too, and a redundant `createdAt` filter would only cost the planner an extra condition
 * on a column these tables are not being seeked by.
 */
export function postCountArgs(userIds: number[]) {
  // NOT a blanket `as const`, and not a plain literal either — Prisma's generated `groupBy` argument
  // type wants both at once. `by` must be a MUTABLE array of the model's scalar-field enum (a
  // readonly tuple is rejected), while `_count._all` must be the literal `true` (a widened `boolean`
  // is rejected). Getting either wrong produces the same error four times over, once per model,
  // which reads as four unrelated faults.
  return {
    by: ['userId'] as ['userId'],
    where: { userId: { in: userIds } },
    _count: { _all: true as const },
  };
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
type GroupByFn = (args: ReturnType<typeof postCountArgs>) => Promise<unknown>;

export type CohortDb = {
  user: { findMany: (args: ReturnType<typeof newAccountPageArgs>) => Promise<NewAccountRow[]> };
  comment: { groupBy: GroupByFn };
  commentV2: { groupBy: GroupByFn };
  model: { groupBy: GroupByFn };
  image: { groupBy: GroupByFn };
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
      if (!userIds.length) return { comments: [], commentsV2: [], models: [], images: [] };
      const args = postCountArgs(userIds);
      const [comments, commentsV2, models, images] = await Promise.all([
        db.comment.groupBy(args),
        db.commentV2.groupBy(args),
        db.model.groupBy(args),
        db.image.groupBy(args),
      ]);
      return {
        comments: toCountRows(comments as GroupByRow[]),
        commentsV2: toCountRows(commentsV2 as GroupByRow[]),
        models: toCountRows(models as GroupByRow[]),
        images: toCountRows(images as GroupByRow[]),
      };
    },
  };
}

/** The four reads folded into one per-user record. Comments from both systems add together — they
 *  are the same act to a moderator, and splitting them in the report would invite reading a
 *  migration artefact as a signal. */
export function mergePostCounts(raw: RawPostCounts): Map<number, PostCounts> {
  const merged = new Map<number, PostCounts>();
  const get = (userId: number) => {
    let row = merged.get(userId);
    if (!row) merged.set(userId, (row = { comments: 0, models: 0, images: 0, total: 0 }));
    return row;
  };
  for (const r of raw.comments) get(r.userId).comments += r.count;
  for (const r of raw.commentsV2) get(r.userId).comments += r.count;
  for (const r of raw.models) get(r.userId).models += r.count;
  for (const r of raw.images) get(r.userId).images += r.count;
  for (const row of merged.values()) row.total = row.comments + row.models + row.images;
  return merged;
}

/**
 * Which of a page's accounts are in the cohort.
 *
 * Pure, and the only place membership is decided. An account with no content is not a bot-account
 * candidate under this brief — a signup that has done nothing is a signup, and including it would
 * put most of a day's registrations in front of a moderator.
 */
export function selectCohortMembers(
  accounts: NewAccountRow[],
  counts: Map<number, PostCounts>
): BotAccountCohortMember[] {
  const members: BotAccountCohortMember[] = [];
  for (const account of accounts) {
    const posts = counts.get(account.id);
    if (!posts || posts.total === 0) continue;
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
  members: BotAccountCohortMember[];
  /** Accounts read, before the has-posted filter. The denominator the counters report. */
  scanned: number;
  /** Accounts were left unread because the cap was reached. */
  capped: boolean;
  /** Reads the walk performed, including the probe below. Reported so a run that did no paging is
   *  distinguishable from one that paged and found nothing. */
  pages: number;
};

/**
 * Walk the window, page by page, up to the cap.
 *
 * 🔴 `capped` means accounts were LEFT UNREAD, and it is measured rather than inferred from
 * `scanned === maxAccounts`. The two differ on the case a moderator would act on: a cohort whose
 * size is exactly the cap is complete, and reporting that as truncated sends someone looking for
 * accounts that do not exist. So when the budget runs out the walk spends one extra 1-row read to
 * ask whether anything follows. Those rows are not scanned and not scored — the probe answers one
 * question and its result is discarded.
 */
export async function collectCohort(
  reader: CohortReader,
  opts: {
    createdAfter: Date;
    pageSize?: number;
    maxAccounts?: number;
  }
): Promise<CohortResult> {
  const pageSize = opts.pageSize ?? COHORT_PAGE_SIZE;
  const maxAccounts = opts.maxAccounts ?? MAX_COHORT_ACCOUNTS;

  const members: BotAccountCohortMember[] = [];
  let after = 0;
  let scanned = 0;
  let pages = 0;
  let capped = false;

  for (;;) {
    const remaining = maxAccounts - scanned;
    if (remaining <= 0) {
      const probe = await reader.listNewAccounts({
        createdAfter: opts.createdAfter,
        after,
        take: 1,
      });
      pages += 1;
      capped = probe.length > 0;
      break;
    }
    const take = Math.min(pageSize, remaining);
    const accounts = await reader.listNewAccounts({
      createdAfter: opts.createdAfter,
      after,
      take,
    });
    pages += 1;
    if (!accounts.length) break;

    scanned += accounts.length;
    after = accounts[accounts.length - 1].id;

    const counts = mergePostCounts(await reader.countPosts(accounts.map((a) => a.id)));
    members.push(...selectCohortMembers(accounts, counts));

    // A short page is the end of the window: the reader was asked for `take` and had fewer.
    if (accounts.length < take) break;
  }

  return { members, scanned, capped, pages };
}
