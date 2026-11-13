import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as ImageVisibility from '~/server/common/image-visibility';

// The minor exclusion exempts the VIEWER's own images, matched by user id. Every image-feed
// builder has two ids in scope — the viewer and the profile being browsed — and exempting the
// profile owner instead would show a creator's minor-flagged images to everyone on their
// profile. So each case below also browses the owner's profile as a stranger.
//
// Mock recipe follows image-db-unpublished-authorization.test.ts.

const { queryWithTimeoutMock, pendingOthersMock, pendingLevelMock } = vi.hoisted(() => ({
  queryWithTimeoutMock: vi.fn(),
  pendingOthersMock: vi.fn(),
  pendingLevelMock: vi.fn(),
}));

vi.mock('~/server/common/image-visibility', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageVisibility>();
  pendingOthersMock.mockImplementation(actual.pendingOthersImageConditions);
  pendingLevelMock.mockImplementation(actual.pendingLevelImageSql);
  return {
    ...actual,
    pendingOthersImageConditions: pendingOthersMock,
    pendingLevelImageSql: pendingLevelMock,
  };
});

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
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

import { getAllImages, getImagesForModelVersion, getImagesForPosts } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const OWNER = 3300;
const STRANGER = 4400;

type Viewer = { id: number } | undefined;

/** The minor clause and the id bound into it, or `null` when the clause has no owner arm. */
type MinorClause = { clause: string; exemptedId: unknown };

/**
 * Exactly one, because the clauses are ANDed: a leftover bare clause beside the owner arm hides
 * the viewer's rows again while a first-match read still finds the owner arm.
 */
function onlyMinorClause(text: string, pattern: RegExp) {
  const matches = [...text.matchAll(new RegExp(pattern.source, 'g'))];
  expect(
    matches.map((m) => m[0]),
    `expected exactly one minor clause in: ${text}`
  ).toHaveLength(1);
  return matches[0];
}

function minorClauseIn(text: string, values: unknown[], pattern: RegExp): MinorClause {
  const match = onlyMinorClause(text, pattern);
  const placeholder = match[1];
  return {
    clause: match[0],
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

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe.each([['getAllImages', getAllImagesMinor]] as const)(
  '%s minor exclusion',
  (_name, minorFor) => {
    it('exempts the signed-in viewer by id', async () => {
      expect((await minorFor({ id: OWNER })).exemptedId).toBe(OWNER);
    });

    it("exempts the viewer, not the profile owner, on someone else's profile", async () => {
      expect((await minorFor({ id: STRANGER }, OWNER)).exemptedId).toBe(STRANGER);
    });

    it('exempts no one for a signed-out viewer, even on a profile', async () => {
      expect((await minorFor(undefined, OWNER)).exemptedId).toBeNull();
    });
  }
);

describe('getImagesForPosts minor exclusion', () => {
  it('exempts the signed-in viewer by id', async () => {
    expect((await postImagesMinor({ id: OWNER })).exemptedId).toBe(OWNER);
  });

  it('exempts no one for a signed-out viewer', async () => {
    expect((await postImagesMinor(undefined)).exemptedId).toBeNull();
  });
});

// What the conditions keep and drop is run against rows in pending-viewer-image.sql.behavior.test.ts;
// here, only that each read applies them for the viewer.
describe.each([
  [
    'getImagesForPosts',
    (isModerator = false) =>
      getImagesForPosts({
        postIds: [1],
        pending: true,
        browsingLevel: 1,
        user: { id: STRANGER, isModerator } as never,
      }),
  ],
  [
    'getImagesForModelVersion',
    (isModerator = false) =>
      getImagesForModelVersion({
        modelVersionIds: [1],
        pending: true,
        browsingLevel: 1,
        user: { id: STRANGER, isModerator } as never,
      }),
  ],
] as const)('%s pending read', (name, read) => {
  let restoreOthers: ReturnType<typeof pendingOthersMock.getMockImplementation>;
  let restoreLevel: ReturnType<typeof pendingLevelMock.getMockImplementation>;
  beforeEach(() => {
    restoreOthers = pendingOthersMock.getMockImplementation();
    restoreLevel = pendingLevelMock.getMockImplementation();
    pendingOthersMock.mockClear();
    pendingLevelMock.mockClear();
    pendingOthersMock.mockImplementation((userId: number) => [
      Prisma.sql`pending_others_marker(${userId})`,
    ]);
    pendingLevelMock.mockImplementation(
      (userId: number, level: number) => Prisma.sql`pending_level_marker(${userId}, ${level})`
    );
  });
  afterEach(() => {
    pendingOthersMock.mockImplementation(restoreOthers!);
    pendingLevelMock.mockImplementation(restoreLevel!);
  });

  async function pendingStatement(isModerator = false) {
    dbMock.dbRead.$queryRaw.mockClear();
    await read(isModerator);
    const call = dbMock.dbRead.$queryRaw.mock.calls.at(-1);
    expect(call, `${name} no longer reaches dbRead.$queryRaw`).toBeDefined();
    const [first, ...values] = call as unknown as [TemplateStringsArray | Prisma.Sql, ...unknown[]];
    // getImagesForPosts tags the template; getImagesForModelVersion passes a built Prisma.Sql.
    return Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as Prisma.Sql[]))
      : (first as Prisma.Sql);
  }

  it('applies the per-image conditions and the level check for a signed-in non-moderator, bound to the viewer', async () => {
    const stmt = await pendingStatement();
    const others = stmt.text.match(/pending_others_marker\(\$(\d+)\)/);
    expect(others, 'the conditions are not in the read').not.toBeNull();
    expect(stmt.values[Number(others![1]) - 1]).toBe(STRANGER);
    const level = stmt.text.match(/pending_level_marker\(\$(\d+), \$(\d+)\)/);
    expect(level, 'the level check is not in the read').not.toBeNull();
    expect(stmt.values[Number(level![1]) - 1]).toBe(STRANGER);
    expect(stmt.values[Number(level![2]) - 1]).toBe(1);
    expect(pendingOthersMock).toHaveBeenCalledTimes(1);
    expect(pendingLevelMock).toHaveBeenCalledTimes(1);
  });

  it("gives a moderator's pending read the level check but not the per-image conditions", async () => {
    const stmt = await pendingStatement(true);
    expect(stmt.text).not.toContain('pending_others_marker');
    expect(stmt.text).not.toContain('pending_level_marker');
    // A moderator's pending read still checks the level.
    expect(stmt.text).toMatch(/\(\(i\."nsfwLevel" & \$\d+\) != 0 OR i\."nsfwLevel" = 0\)/);
  });
});
