import { describe, expect, it, vi } from 'vitest';
import {
  BOT_ACCOUNT_COHORT_WINDOW_HOURS,
  cohortCutoff,
  collectCohort,
  createCohortReader,
  mergePostCounts,
  newAccountPageArgs,
  postCountArgs,
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

describe('newAccountPageArgs', () => {
  const cutoff = at('2026-09-02T12:00:00.000Z');
  const args = newAccountPageArgs({ createdAfter: cutoff, after: 41, take: 7 });

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

  it('pages by keyset on id, ascending, not by offset', () => {
    expect(args.where.id).toEqual({ gt: 41 });
    expect(args.orderBy).toEqual({ id: 'asc' });
    expect(args.take).toBe(7);
    expect(args).not.toHaveProperty('skip');
  });

  it('selects only the columns the report cites', () => {
    expect(args.select).toEqual({ id: true, username: true, createdAt: true });
  });
});

describe('postCountArgs', () => {
  it('counts per user, restricted to the ids handed in', () => {
    const args = postCountArgs([3, 4]);
    expect(args.by).toEqual(['userId']);
    expect(args.where).toEqual({ userId: { in: [3, 4] } });
    expect(args._count).toEqual({ _all: true });
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
    const request = { createdAfter: at('2026-09-02T12:00:00.000Z'), after: 9, take: 3 };
    await createCohortReader(db).listNewAccounts(request);
    expect(db.user.findMany).toHaveBeenCalledWith(newAccountPageArgs(request));
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

/** A reader over a fixed account list: pages it by keyset, and reports every account as having
 *  posted exactly one image so membership never masks a paging bug. */
function fakeReader(accounts: NewAccountRow[]): CohortReader & { pageRequests: number[] } {
  const pageRequests: number[] = [];
  return {
    pageRequests,
    listNewAccounts: async ({ after, take }) => {
      pageRequests.push(take);
      return accounts.filter((a) => a.id > after).slice(0, take);
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

  it('walks every page of the window', async () => {
    const reader = fakeReader(seven);
    const result = await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 100 });
    expect(result.members.map((m) => m.userId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.scanned).toBe(7);
    expect(result.pages).toBe(3);
    expect(result.capped).toBe(false);
  });

  it('stops at the cap and says so', async () => {
    const reader = fakeReader(seven);
    const result = await collectCohort(reader, { createdAfter, pageSize: 3, maxAccounts: 5 });
    expect(result.scanned).toBe(5);
    expect(result.members.map((m) => m.userId)).toEqual([1, 2, 3, 4, 5]);
    expect(result.capped).toBe(true);
    // The final page is clamped to the remaining budget, not the page size — otherwise the cap is
    // only ever approximate and a run reads more than it claims.
    expect(reader.pageRequests).toEqual([3, 2, 1]);
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
    expect(result.members.map((m) => m.userId)).toEqual([1, 3, 5, 7]);
    // `scanned` is the denominator the counters publish. If the filter were applied to it too, a
    // report could never say "3 of 700", which is the number that says whether the rule is tight.
    expect(result.scanned).toBe(7);
  });
});
