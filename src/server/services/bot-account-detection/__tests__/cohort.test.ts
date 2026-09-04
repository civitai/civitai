import { describe, expect, it, vi } from 'vitest';
import {
  BOT_ACCOUNT_COHORT_WINDOW_HOURS,
  COHORT_PAGE_SIZE,
  MAX_COHORT_ACCOUNTS,
  cohortCutoff,
  collectCohort,
  commentCountArgs,
  commentV2CountArgs,
  createCohortReader,
  imageCountArgs,
  mergePostCounts,
  modelCountArgs,
  newAccountPageArgs,
  selectCohortMembers,
  type CohortDb,
  type CohortReader,
  type NewAccountRow,
  type PostCounts,
  type RawPostCounts,
} from '../cohort';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-09-03T12:00:00.000Z');

const account = (id: number, createdAt = NOW): NewAccountRow => ({
  id,
  username: `user${id}`,
  createdAt,
});

const counts = (entries: Array<[number, Partial<PostCounts>]>): Map<number, PostCounts> =>
  new Map(
    entries.map(([userId, partial]) => {
      const row = { comments: 0, models: 0, images: 0, ...partial };
      return [userId, { ...row, total: row.comments + row.models + row.images }];
    })
  );

const emptyRaw = (): RawPostCounts => ({ comments: [], commentsV2: [], models: [], images: [] });

describe('cohortCutoff', () => {
  // Two points, not one: a single window cannot tell an implementation that subtracts the argument
  // from an implementation that ignores it and hardcodes a day.
  it('opens the window `hours` before the run clock', () => {
    expect(cohortCutoff(NOW, 24).toISOString()).toBe('2026-09-02T12:00:00.000Z');
    expect(cohortCutoff(NOW, 6).toISOString()).toBe('2026-09-03T06:00:00.000Z');
  });

  it('defaults to the brief’s 24h window', () => {
    expect(BOT_ACCOUNT_COHORT_WINDOW_HOURS).toBe(24);
    expect(cohortCutoff(NOW).getTime()).toBe(cohortCutoff(NOW, 24).getTime());
  });
});

describe('the cohort cap is set against the measured signup baseline', () => {
  /** 🔴 The baseline figure itself is NOT in this repository — it is production business data and
   *  this repo is public. It is recorded privately; what is pinned here is the RELATIONSHIP the cap
   *  was chosen for, which is what a maintainer has to preserve. Re-measure before changing the
   *  constant: the number drifts, the reasoning does not. */
  it('leaves room for a registration wave rather than sitting just above an ordinary day', () => {
    // 🔴 An invariant guard, deliberately labelled as one: it pins the reasoning, it is not
    // regression coverage for a bug. The previous ceiling sat only marginally above an ordinary
    // day's volume, which is the worst place for a cap — never trips on an ordinary day, so it
    // looks proven, and trips for the first time on exactly the day a wave lands. Expressed in
    // PAGES so the bound holds without naming the baseline.
    expect(MAX_COHORT_ACCOUNTS / COHORT_PAGE_SIZE).toBeGreaterThanOrEqual(40);
    // Still a bound: the walk is at most this many pages, four content reads each.
    expect(MAX_COHORT_ACCOUNTS / COHORT_PAGE_SIZE).toBeLessThanOrEqual(100);
  });
});

describe('newAccountPageArgs', () => {
  const cutoff = at('2026-09-02T12:00:00.000Z');
  const args = newAccountPageArgs({ createdAfter: cutoff, before: 41, take: 7 });

  it('bounds the window at the cutoff, inclusive and forward-only', () => {
    // `gte` and nothing else: an upper bound would exclude accounts created while the run walks,
    // and `gt` would drop an account created exactly on the boundary.
    expect(args.where.createdAt).toEqual({ gte: cutoff });
    expect(Object.keys(args.where.createdAt)).toEqual(['gte']);
  });

  it('excludes accounts a moderator has already dealt with', () => {
    expect(args.where.bannedAt).toBeNull();
    expect(args.where.deletedAt).toBeNull();
  });

  it('pages by keyset on id, DESCENDING, not by offset', () => {
    // 🔴 The direction is the behaviour, not a style choice. Ascending, a capped run's unread
    // remainder is the HIGHEST ids — the newest signups, i.e. the registration wave this detector
    // exists to notice. Descending, the remainder is the oldest end of the window.
    expect(args.where.id).toEqual({ lt: 41 });
    expect(args.orderBy).toEqual({ id: 'desc' });
    expect(args.take).toBe(7);
    expect(args).not.toHaveProperty('skip');
  });

  it('seeds the walk with no id bound at all', () => {
    // `undefined` rather than a sentinel: Prisma drops an undefined field from the WHERE clause,
    // where any real integer would have to be inside `int4` and would eventually be reachable.
    const seed = newAccountPageArgs({ createdAfter: cutoff, before: undefined, take: 3 });
    expect(seed.where.id).toBeUndefined();
    expect(seed.orderBy).toEqual({ id: 'desc' });
  });

  it('selects only the columns the report cites', () => {
    expect(args.select).toEqual({ id: true, username: true, createdAt: true });
  });
});

describe('content-count arguments count only content a moderator can open', () => {
  // 🔴 Filtering the content side on `userId` alone counted drafts, unattached uploads, blocked
  // uploads, hidden comments and already-removed models as "posted" — and the finding's reason
  // string then told a moderator to go and look at them.
  it('shapes every read as a per-user count over exactly the ids handed in', () => {
    for (const build of [commentCountArgs, commentV2CountArgs, modelCountArgs, imageCountArgs]) {
      const args = build([3, 4]);
      expect(args.by).toEqual(['userId']);
      expect(args._count).toEqual({ _all: true });
      expect(args.where).toMatchObject({ userId: { in: [3, 4] } });
    }
  });

  it('excludes hidden and TOS-flagged comments, in both comment systems', () => {
    // `hidden` is a NULLABLE boolean, so `{ not: true }` and not `false`: `hidden: false` would
    // drop every comment that has never been hidden, which is nearly all of them.
    for (const build of [commentCountArgs, commentV2CountArgs]) {
      expect(build([7]).where).toEqual({
        userId: { in: [7] },
        hidden: { not: true },
        tosViolation: false,
      });
    }
  });

  it('counts only published, undeleted, un-flagged models', () => {
    expect(modelCountArgs([7]).where).toEqual({
      userId: { in: [7] },
      status: 'Published',
      deletedAt: null,
      tosViolation: false,
    });
  });

  it('counts only images attached to a post, and not blocked or missing ones', () => {
    // 🔴 `Pending` is deliberately still counted: a fresh upload is Pending for minutes, so a bot
    // wave's images are Pending at the instant this detector looks at them. Blocked and NotFound
    // are decisions to remove; Pending is a scan that has not finished.
    expect(imageCountArgs([7]).where).toEqual({
      userId: { in: [7] },
      postId: { not: null },
      tosViolation: false,
      ingestion: { notIn: ['Blocked', 'NotFound'] },
    });
  });
});

describe('createCohortReader', () => {
  // The seam, not the builders: a correct argument object that is never handed to the client
  // changes nothing, and that is invisible to a test of the builder alone.
  const makeDb = () => {
    const calls: string[] = [];
    const db = {
      user: {
        findMany: vi.fn(async (args: unknown) => {
          calls.push('user.findMany');
          void args;
          return [account(1)];
        }),
      },
      comment: {
        groupBy: vi.fn(async () => {
          calls.push('comment.groupBy');
          return [{ userId: 1, _count: { _all: 2 } }];
        }),
      },
      commentV2: {
        groupBy: vi.fn(async () => {
          calls.push('commentV2.groupBy');
          return [{ userId: 1, _count: { _all: 3 } }];
        }),
      },
      model: {
        groupBy: vi.fn(async () => {
          calls.push('model.groupBy');
          return [{ userId: 1, _count: { _all: 4 } }];
        }),
      },
      image: {
        groupBy: vi.fn(async () => {
          calls.push('image.groupBy');
          return [{ userId: 1, _count: { _all: 5 } }];
        }),
      },
    } satisfies CohortDb;
    return { db, calls };
  };

  it('hands `newAccountPageArgs` to the client verbatim', async () => {
    const { db } = makeDb();
    const request = { createdAfter: at('2026-09-02T12:00:00.000Z'), before: 9, take: 3 };
    await createCohortReader(db).listNewAccounts(request);
    expect(db.user.findMany).toHaveBeenCalledWith(newAccountPageArgs(request));
  });

  it('hands each content read its OWN visibility filter, not one shared argument', async () => {
    // The seam again, in the axis that changed: four reads that used to take one identical
    // argument now take four different ones, and a refactor that reverts them to a shared
    // `postCountArgs` would be invisible to a test of the builders alone.
    const { db } = makeDb();
    await createCohortReader(db).countPosts([1]);
    expect(db.comment.groupBy).toHaveBeenCalledWith(commentCountArgs([1]));
    expect(db.commentV2.groupBy).toHaveBeenCalledWith(commentV2CountArgs([1]));
    expect(db.model.groupBy).toHaveBeenCalledWith(modelCountArgs([1]));
    expect(db.image.groupBy).toHaveBeenCalledWith(imageCountArgs([1]));
    // And they are genuinely different objects — a shared one would satisfy all four above only if
    // the four builders had collapsed into one, which this catches directly.
    expect(modelCountArgs([1]).where).not.toEqual(imageCountArgs([1]).where);
  });

  it('reads both comment systems, models and images — and nothing else', async () => {
    const { db, calls } = makeDb();
    const raw = await createCohortReader(db).countPosts([1]);
    // An asserted LEDGER, sorted so it is order-independent but not membership-independent: it
    // fails if an operation is added AND if one is removed. Dropping `commentV2` is the realistic
    // regression — it reads as a tidy-up and turns every newer-comment-only account into a
    // false negative.
    expect([...calls].sort()).toEqual([
      'comment.groupBy',
      'commentV2.groupBy',
      'image.groupBy',
      'model.groupBy',
    ]);
    expect(raw.comments).toEqual([{ userId: 1, count: 2 }]);
    expect(raw.commentsV2).toEqual([{ userId: 1, count: 3 }]);
    expect(raw.models).toEqual([{ userId: 1, count: 4 }]);
    expect(raw.images).toEqual([{ userId: 1, count: 5 }]);
  });

  it('asks the database nothing when there are no ids', async () => {
    const { db, calls } = makeDb();
    const raw = await createCohortReader(db).countPosts([]);
    expect(calls).toEqual([]);
    expect(raw).toEqual(emptyRaw());
  });
});

describe('mergePostCounts', () => {
  it('adds both comment systems together and totals the three surfaces', () => {
    const merged = mergePostCounts({
      comments: [{ userId: 1, count: 2 }],
      commentsV2: [{ userId: 1, count: 3 }],
      models: [{ userId: 1, count: 4 }],
      images: [{ userId: 1, count: 5 }],
    });
    // Distinct values per surface, and distinct from the total, so a mutant that reads the wrong
    // field or drops one of the four cannot produce the same number by accident.
    expect(merged.get(1)).toEqual({ comments: 5, models: 4, images: 5, total: 14 });
  });

  it('keeps users apart', () => {
    const merged = mergePostCounts({
      comments: [{ userId: 1, count: 1 }],
      commentsV2: [],
      models: [{ userId: 2, count: 7 }],
      images: [],
    });
    expect(merged.get(1)?.total).toBe(1);
    expect(merged.get(2)?.total).toBe(7);
  });
});

describe('selectCohortMembers', () => {
  it('excludes an account that has not posted', () => {
    const members = selectCohortMembers(
      [account(1), account(2)],
      counts([
        [1, { comments: 1 }],
        [2, { comments: 0, models: 0, images: 0 }],
      ])
    );
    expect(members.map((m) => m.userId)).toEqual([1]);
  });

  it('excludes an account the content read returned nothing at all for', () => {
    // Distinct from the zero-total case above: no map entry, not an entry of zeroes. Prisma's
    // groupBy omits a user with no rows entirely, so this is the shape production actually
    // produces and the one a `counts.get(id)!.total === 0` implementation would crash on.
    expect(selectCohortMembers([account(3)], counts([]))).toEqual([]);
  });

  it.each([
    ['comments only', { comments: 1 }],
    ['models only', { models: 1 }],
    ['images only', { images: 1 }],
  ])('includes an account that posted %s', (_label, posted) => {
    const members = selectCohortMembers([account(4)], counts([[4, posted]]));
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(4);
  });

  it('carries the account identity and its activity through', () => {
    const created = at('2026-09-03T09:30:00.000Z');
    const members = selectCohortMembers(
      [{ id: 5, username: 'spam5', createdAt: created }],
      counts([[5, { comments: 2, models: 1, images: 3 }]])
    );
    expect(members[0]).toEqual({
      userId: 5,
      username: 'spam5',
      createdAt: created,
      posts: { comments: 2, models: 1, images: 3, total: 6 },
    });
  });
});

/** A reader over a fixed account list: pages it by DESCENDING keyset, and reports every account as
 *  having posted exactly one image so membership never masks a paging bug. */
function fakeReader(accounts: NewAccountRow[]): CohortReader & { pageRequests: number[] } {
  const pageRequests: number[] = [];
  return {
    pageRequests,
    listNewAccounts: async ({ before, take }) => {
      pageRequests.push(take);
      return [...accounts]
        .sort((a, b) => b.id - a.id)
        .filter((a) => before === undefined || a.id < before)
        .slice(0, take);
    },
    countPosts: async (ids) => ({
      comments: [],
      commentsV2: [],
      models: [],
      images: ids.map((userId) => ({ userId, count: 1 })),
    }),
  };
}

describe('collectCohort', () => {
  const createdAfter = at('2026-09-02T12:00:00.000Z');
  // 7 accounts at a page size of 3: the last page is SHORT (1), so the walk's terminate-on-short-page
  // branch runs. A multiple of the page size would exit through the empty-page branch instead and
  // leave this one unexercised.
  const seven = Array.from({ length: 7 }, (_, i) => account(i + 1));

  it('walks every page of the window, newest account first', async () => {
    const reader = fakeReader(seven);
    const result = await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 100 });
    expect(result.members.map((m) => m.userId)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(result.scanned).toBe(7);
    expect(result.pages).toBe(3);
    expect(result.capped).toBe(false);
  });

  it('stops at the cap and says so', async () => {
    const reader = fakeReader(seven);
    const result = await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 5 });
    expect(result.scanned).toBe(5);
    expect(result.capped).toBe(true);
    // The final page is clamped to the remaining budget, not the page size — otherwise the cap is
    // only ever approximate and a run reads more than it claims.
    expect(reader.pageRequests).toEqual([3, 2, 1]);
  });

  it('🔴 TRUNCATES THE OLDEST END: a capped run keeps the NEWEST accounts', async () => {
    // The finding this test exists for. 11 accounts against a cap of 7, page size 3 — the fixture
    // OVERSHOOTS the cap (11 > 7), the cap is not a multiple of the page size, and neither is a
    // power-of-two multiple of it, so the budget-clamped final page runs and the surviving set is
    // not producible by landing exactly on a boundary.
    //
    // Ascending, this returns ids 1..7 — the oldest seven — and discards 8..11, the four most
    // recent signups, which is precisely the population a registration wave lives in.
    const eleven = Array.from({ length: 11 }, (_, i) => account(i + 1));
    const reader = fakeReader(eleven);
    const result = await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 7 });

    expect(result.scanned).toBe(7);
    expect(result.capped).toBe(true);
    // WHICH accounts survived, not just how many.
    expect(result.members.map((m) => m.userId)).toEqual([11, 10, 9, 8, 7, 6, 5]);
    // Said the other way round, so a mutant that reverses the direction fails on the identity of
    // the dropped set rather than only on the order of the kept one.
    const kept = new Set(result.members.map((m) => m.userId));
    for (const newest of [11, 10, 9, 8]) expect(kept.has(newest)).toBe(true);
    for (const oldest of [1, 2, 3, 4]) expect(kept.has(oldest)).toBe(false);
  });

  it('walks strictly downwards, page by page', async () => {
    // The keyset itself, independent of the cap: each page asks for ids strictly below the lowest
    // id of the page before it, and the seed page asks with no bound.
    const bounds: Array<number | undefined> = [];
    const base = fakeReader(seven);
    const reader: CohortReader = {
      ...base,
      listNewAccounts: async (args) => {
        bounds.push(args.before);
        return base.listNewAccounts(args);
      },
    };
    await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 100 });
    expect(bounds).toEqual([undefined, 5, 2]);
  });

  it('does not call a complete cohort truncated when its size equals the cap', async () => {
    // 🔴 The case `scanned === maxAccounts` cannot distinguish. Reporting it as truncated sends a
    // moderator looking for accounts that do not exist, which is why the walk probes instead of
    // inferring.
    const reader = fakeReader(seven.slice(0, 5));
    const result = await collectCohort(reader, { createdAfter, pageSize: 5, maxAccounts: 5 });
    expect(result.scanned).toBe(5);
    expect(result.capped).toBe(false);
  });

  it('checks for cancellation once per page, and stops when it throws', async () => {
    // The scheduler cancels by closing the response. A walk that never asks keeps paging — and on
    // this job that overrun is what produces a second, unmergeable run.
    const reader = fakeReader(seven);
    let checks = 0;
    await expect(
      collectCohort(reader, {
        createdAfter,
        pageSize: 3,
        maxAccounts: 100,
        checkCanceled: () => {
          checks += 1;
          if (checks === 2) throw new Error('Job was canceled');
        },
      })
    ).rejects.toThrow('Job was canceled');
    // One page read before the cancellation was seen, and none after.
    expect(reader.pageRequests).toEqual([3]);
  });

  it('reports an empty window without paging', async () => {
    const reader = fakeReader([]);
    const result = await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 100 });
    expect(result).toMatchObject({ members: [], scanned: 0, pages: 1, capped: false });
  });

  it('passes the window cutoff to every page', async () => {
    const seen: Date[] = [];
    const base = fakeReader(seven);
    const reader: CohortReader = {
      ...base,
      listNewAccounts: async (args) => {
        seen.push(args.createdAfter);
        return base.listNewAccounts(args);
      },
    };
    await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 100 });
    expect(seen).toHaveLength(3);
    expect(seen.every((d) => d.getTime() === createdAfter.getTime())).toBe(true);
  });

  it('drops accounts that have not posted from the members but not from `scanned`', async () => {
    const base = fakeReader(seven);
    const reader: CohortReader = {
      ...base,
      // Only odd ids posted.
      countPosts: async (ids) => ({
        ...emptyRaw(),
        images: ids.filter((id) => id % 2 === 1).map((userId) => ({ userId, count: 1 })),
      }),
    };
    const result = await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 100 });
    expect(result.members.map((m) => m.userId)).toEqual([7, 5, 3, 1]);
    // `scanned` is the denominator the counters publish. If the filter were applied to it too, a
    // report could never say "3 of 700", which is the number that says whether the rule is tight.
    expect(result.scanned).toBe(7);
  });
});
