import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as MeilisearchClient from '~/server/meilisearch/client';

// The minor exclusion exempts the VIEWER's own images, matched by user id. Every image-feed
// builder has two ids in scope — the viewer and the profile being browsed — and exempting the
// profile owner instead would show a creator's minor-flagged images to everyone on their
// profile. So each case below also browses the owner's profile as a stranger.
//
// Mock recipe follows image-db-unpublished-authorization.test.ts and
// image-search-scheduled-owner.test.ts.

const { queryWithTimeoutMock, fetchDocumentsAbortableMock } = vi.hoisted(() => ({
  queryWithTimeoutMock: vi.fn(),
  fetchDocumentsAbortableMock: vi.fn(),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('~/server/db/db-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DbHelpers>();
  return { ...actual, queryWithTimeout: queryWithTimeoutMock };
});
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return {
    ...actual,
    metricsSearchClient: {},
    getMetricsSearchClient: () => ({}),
    fetchDocumentsAbortable: fetchDocumentsAbortableMock,
  };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

import {
  getAllImages,
  getImagesForPosts,
  getImagesFromSearchPostFilter,
  getImagesFromSearchPreFilter,
} from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const OWNER = 3300;
const STRANGER = 4400;

type Viewer = { id: number } | undefined;

/** The minor clause and the id bound into it, or `null` when the clause has no owner arm. */
type MinorClause = { clause: string; exemptedId: unknown };

function minorClauseIn(text: string, values: unknown[], pattern: RegExp): MinorClause {
  const match = text.match(pattern);
  expect(match, `no minor clause in: ${text}`).not.toBeNull();
  const placeholder = match![1];
  return {
    clause: match![0],
    exemptedId: placeholder ? values[Number(placeholder) - 1] : null,
  };
}

const ALL_IMAGES_MINOR = /\(i\."minor" != TRUE(?: OR i\."userId" = \$(\d+))?\)/;
const POSTS_MINOR = /\(i\."minor" = false OR i\."minor" IS NULL(?: OR i\."userId" = \$(\d+))?\)/;

async function getAllImagesMinor(viewer: Viewer, profileUserId?: number) {
  await getAllImages({
    limit: 20,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Newest',
    browsingLevel: 31,
    include: [],
    disableMinor: true,
    user: viewer ? { ...viewer, isModerator: false } : undefined,
    userId: profileUserId,
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
  const stmt = queryWithTimeoutMock.mock.calls[0][2] as { text: string; values: unknown[] };
  return minorClauseIn(stmt.text, stmt.values, ALL_IMAGES_MINOR);
}

async function postImagesMinor(viewer: Viewer) {
  await getImagesForPosts({
    postIds: [1],
    disableMinor: true,
    user: viewer ? ({ ...viewer, isModerator: false } as never) : undefined,
  });
  const call = dbMock.dbRead.$queryRaw.mock.calls.at(-1);
  expect(call, 'getImagesForPosts no longer reaches dbRead.$queryRaw').toBeDefined();
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  const stmt = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  return minorClauseIn(stmt.text, stmt.values, POSTS_MINOR);
}

async function meiliMinor(
  fn: typeof getImagesFromSearchPreFilter,
  viewer: Viewer,
  profileUserId?: number
) {
  await expect(
    fn({
      currentUserId: viewer?.id,
      isModerator: false,
      limit: 20,
      period: 'AllTime',
      sort: 'Newest',
      browsingLevel: 31,
      include: [],
      headers: { src: 'test' },
      disableMinor: true,
      userId: profileUserId,
    } as unknown as Parameters<typeof getImagesFromSearchPreFilter>[0])
  ).rejects.toThrow('stop here');
  const [, request] = fetchDocumentsAbortableMock.mock.calls[0];
  const filter = String((request as { filter: string }).filter);
  const match = filter.match(/\(NOT minor = true(?: OR "userId" = (\d+))?\)/);
  expect(match, `no minor clause in: ${filter}`).not.toBeNull();
  return { clause: match![0], exemptedId: match![1] ? Number(match![1]) : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
  fetchDocumentsAbortableMock.mockRejectedValue(new Error('stop here'));
});

describe.each([
  ['getAllImages', getAllImagesMinor],
  ['getImagesFromSearchPreFilter', meiliMinor.bind(null, getImagesFromSearchPreFilter)],
  ['getImagesFromSearchPostFilter', meiliMinor.bind(null, getImagesFromSearchPostFilter)],
] as const)('%s minor exclusion', (_name, minorFor) => {
  it('exempts the signed-in viewer by id', async () => {
    expect((await minorFor({ id: OWNER })).exemptedId).toBe(OWNER);
  });

  it("exempts the viewer, not the profile owner, on someone else's profile", async () => {
    expect((await minorFor({ id: STRANGER }, OWNER)).exemptedId).toBe(STRANGER);
  });

  it('exempts no one for a signed-out viewer, even on a profile', async () => {
    expect((await minorFor(undefined, OWNER)).exemptedId).toBeNull();
  });
});

describe('getImagesForPosts minor exclusion', () => {
  it('exempts the signed-in viewer by id', async () => {
    expect((await postImagesMinor({ id: OWNER })).exemptedId).toBe(OWNER);
  });

  it('exempts no one for a signed-out viewer', async () => {
    expect((await postImagesMinor(undefined)).exemptedId).toBeNull();
  });
});
