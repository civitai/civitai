import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as PromClient from '~/server/prom/client';
import type * as FeedPrimary from '~/server/services/feed-primary.service';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { PostSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * A request on a narrow-scope key reads the post and image feeds as a plain signed-in viewer:
 * no moderator view and no owner view of Private, draft, scheduled or held content. Read from
 * the statement each feed issues; the viewer's id is bound only where it is an owner carve-out.
 */

const { issued, queryWithTimeoutMock, enforceMock } = vi.hoisted(() => ({
  issued: [] as Prisma.Sql[],
  queryWithTimeoutMock: vi.fn(),
  enforceMock: vi.fn(),
}));

class QueryIssued extends Error {}
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  queryCache: () => async (sql: Prisma.Sql) => {
    issued.push(sql);
    throw new QueryIssued();
  },
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('~/server/db/db-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DbHelpers>();
  return { ...actual, queryWithTimeout: queryWithTimeoutMock };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: enforceMock,
}));
// No feed service: the index feed answers from Postgres, as in local development.
vi.mock('~/server/services/feed-primary.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedPrimary>()),
  feedPrimaryAvailable: () => false,
}));

const { getPostsInfinite } = await import('~/server/services/post.service');
const { getAllImages, getAllImagesIndex } = await import('~/server/services/image.service');

const VIEWER = 4242;
const squash = (sql: string) => sql.replace(/\s+/g, ' ');

async function postsSql(input: Partial<Parameters<typeof getPostsInfinite>[0]>) {
  issued.length = 0;
  await getPostsInfinite({
    limit: 10,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    sort: PostSort.Newest,
    browsingLevel: 1,
    username: 'creator',
    ...input,
  } as Parameters<typeof getPostsInfinite>[0]).catch((error) => {
    if (!(error instanceof QueryIssued)) throw error;
  });
  expect(issued, 'the feed never issued its statement').toHaveLength(1);
  return { sql: squash(issued[0].sql), values: issued[0].values };
}

async function imagesSql(input: Record<string, unknown>, feed = getAllImages) {
  queryWithTimeoutMock.mockClear();
  enforceMock.mockClear();
  await feed({
    limit: 20,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Newest',
    browsingLevel: 1,
    include: [],
    ...input,
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
  const query = queryWithTimeoutMock.mock.calls[0][2] as { text: string; values: unknown[] };
  return { sql: squash(query.text), values: query.values };
}

const PRIVATE_HIDDEN = /p\."availability" != 'Private'/;
// The image feed binds the availability as a value.
const PRIVATE_HIDDEN_BOUND = /p\."availability" != \$\d+/;

beforeEach(() => {
  dbMock.dbRead.user.findFirst.mockResolvedValue({ id: VIEWER });
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
  enforceMock.mockResolvedValue({ emptyResult: false });
});

/** The viewer the feed's tag exclusions were resolved for (the last call's second argument). */
const exclusionViewer = () => enforceMock.mock.calls.at(-1)?.[1];

describe('the post feed on a narrow-scope key', () => {
  const owner = { id: VIEWER, isModerator: false } as never;
  const moderator = { id: 1, isModerator: true } as never;

  it("hides the owner's Private posts, scheduled posts and unrated posts", async () => {
    const { sql, values } = await postsSql({
      user: owner,
      asOwner: false,
      scheduled: true,
      pending: true,
    });
    expect(sql).toMatch(PRIVATE_HIDDEN);
    expect(sql).not.toMatch(/p\."publishedAt" > NOW\(\)/);
    expect(values.filter((v) => v === VIEWER)).toHaveLength(1); // the creator filter only
  });

  it('shows them to the owner on a session (control)', async () => {
    const { sql, values } = await postsSql({
      user: owner,
      asOwner: true,
      scheduled: true,
      pending: true,
    });
    expect(sql).not.toMatch(PRIVATE_HIDDEN);
    expect(values.filter((v) => v === VIEWER).length).toBeGreaterThan(1);
  });

  it("refuses a narrow key the owner's drafts (session control: drafts asked for)", async () => {
    const narrow = await postsSql({ user: owner, asOwner: false, draftOnly: true });
    expect(narrow.sql).toContain('p."publishedAt" <= NOW()');
    expect(narrow.sql).not.toMatch(/AND\s+p\."publishedAt" IS NULL/);

    const session = await postsSql({ user: owner, asOwner: true, draftOnly: true });
    expect(session.sql).toMatch(/AND\s+p\."publishedAt" IS NULL/);
  });

  it('gives a moderator no moderator view (session control: Private shown)', async () => {
    expect((await postsSql({ user: moderator, asModerator: false })).sql).toMatch(PRIVATE_HIDDEN);
    expect((await postsSql({ user: moderator, asModerator: true })).sql).not.toMatch(
      PRIVATE_HIDDEN
    );
  });
});

describe('the image feed on a narrow-scope key', () => {
  const owner = { id: VIEWER, isModerator: false };
  const moderator = { id: 1, isModerator: true };

  it("binds no owner carve-out for the owner's key", async () => {
    const narrow = await imagesSql({ user: owner, asOwner: false, scheduled: true });
    expect(narrow.values).not.toContain(VIEWER);
    expect(narrow.sql).toMatch(PRIVATE_HIDDEN_BOUND);

    const session = await imagesSql({ user: owner, asOwner: true, scheduled: true });
    expect(session.values).toContain(VIEWER);
  });

  it('gives a moderator no moderator view (session control: Private shown)', async () => {
    expect((await imagesSql({ user: moderator, asModerator: false })).sql).toMatch(
      PRIVATE_HIDDEN_BOUND
    );
    expect((await imagesSql({ user: moderator, asModerator: true })).sql).not.toMatch(
      PRIVATE_HIDDEN_BOUND
    );
  });
});

describe.each([
  ['the image feed', getAllImages],
  ['the index feed', getAllImagesIndex],
] as const)('%s resolves tag exclusions for a narrow-scope key as a plain viewer', (_, feed) => {
  it('as no moderator and no owner', async () => {
    await imagesSql(
      { user: { id: VIEWER, isModerator: true }, asModerator: false, asOwner: false },
      feed
    );
    expect(exclusionViewer()).toEqual({ id: undefined, username: undefined, isModerator: false });
  });

  it('as the moderator and owner on a session (control)', async () => {
    await imagesSql(
      { user: { id: VIEWER, username: 'v', isModerator: true }, asModerator: true, asOwner: true },
      feed
    );
    expect(exclusionViewer()).toEqual({ id: VIEWER, username: 'v', isModerator: true });
  });
});

describe('the index feed on a narrow-scope key', () => {
  it('hydrates with no moderator view (session control: Private shown)', async () => {
    const moderator = { id: 1, isModerator: true };
    expect(
      (await imagesSql({ user: moderator, asModerator: false }, getAllImagesIndex)).sql
    ).toMatch(PRIVATE_HIDDEN_BOUND);
    expect(
      (await imagesSql({ user: moderator, asModerator: true }, getAllImagesIndex)).sql
    ).not.toMatch(PRIVATE_HIDDEN_BOUND);
  });
});

describe('a caller that names no view (fail closed)', () => {
  const moderatorOwner = { id: VIEWER, isModerator: true };

  it('reads the post feed as a plain viewer', async () => {
    const { sql, values } = await postsSql({ user: moderatorOwner as never, scheduled: true });
    expect(sql).toMatch(PRIVATE_HIDDEN);
    expect(values.filter((v) => v === VIEWER)).toHaveLength(1); // the creator filter only
  });

  it('reads the image feed as a plain viewer', async () => {
    const { sql, values } = await imagesSql({ user: moderatorOwner, scheduled: true });
    expect(sql).toMatch(PRIVATE_HIDDEN_BOUND);
    expect(values).not.toContain(VIEWER);
    expect(exclusionViewer()).toEqual({ id: undefined, username: undefined, isModerator: false });
  });
});
