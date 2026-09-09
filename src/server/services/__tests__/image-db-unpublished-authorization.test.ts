import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';

// The Postgres half of the drafts authorization.
//
// `image-unpublished-authorization.test.ts` covers the two Meilisearch builders.
// This covers the fourth call site — `getAllImages` — which had NO test at all,
// and which serves the feed whenever the index flag is off. Two
// independent reviewers ranked that gap first, for the same reason: the suite
// read as proof the gate worked while half its call sites were unobserved.
//
// The mutation this exists to kill: passing the VIEWER as both arguments —
// `canRequestUnpublished({ isModerator, currentUserId: userId, targetUserId: userId })`.
// The check then collapses to "am I signed in", the drafts predicate fires, and
// the creator scope does not (it reads the still-undefined `targetUserId`) — so
// any signed-in caller gets every draft on the site. That mutation failed ZERO
// tests before this file.
//
// Asserted on the assembled SQL rather than on rows: the statement IS the
// authorization decision. `q.text` and `q.values` are read separately because
// joining the template strings would erase the bound creator id, which is the
// half that makes the scoping assertion mean anything.
//
// Mock recipe follows image-hide-challenges-exclusion.test.ts.

const { queryWithTimeoutMock } = vi.hoisted(() => ({ queryWithTimeoutMock: vi.fn() }));

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

import { getAllImages } from '../image.service';

const CREATOR = 3300;
const SOMEONE_ELSE = 4400;
const MODERATOR = 5500;

const DRAFTS_ONLY = 'p."publishedAt" IS NULL';

type FeedInput = Record<string, unknown>;

const baseInput = {
  limit: 20,
  period: 'AllTime',
  periodMode: 'published',
  sort: 'Newest',
  browsingLevel: 31,
  include: [] as string[],
};

/**
 * Run the query build and capture the statement handed to Postgres.
 *
 * `queryWithTimeout` is the seam: the predicate has already been assembled by the
 * time it is called, and throwing there stops the test at the thing it is about
 * rather than at real infra.
 */
const sqlFor = async (input: FeedInput) => {
  await getAllImages(input as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(
    queryWithTimeoutMock,
    'queryWithTimeout was never called — the build no longer reaches this seam'
  ).toHaveBeenCalled();
  // `queryWithTimeout(imageDb, timeoutMs, q)` — the statement is the THIRD
  // argument. Reading argument 0 yields the pool and an empty string, which is
  // how the first version of this file "passed" its four `not.toContain` cases
  // while asserting on nothing.
  const stmt = queryWithTimeoutMock.mock.calls[0][2] as {
    text?: string;
    sql?: string;
    values?: unknown[];
  };
  const text = String(stmt?.text ?? stmt?.sql ?? '');
  // 🔴 The guard that makes the negative assertions mean something. Every
  // `not.toContain` below passes for free on an empty string, so a broken seam
  // would report this file as green while testing nothing.
  expect(text, 'no SQL captured — the seam moved, and the negatives below are vacuous').toContain(
    'SELECT'
  );
  return { text, values: stmt?.values ?? [] };
};

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe('getAllImages — who may ask for unpublished content', () => {
  it('grants a creator their own drafts, SCOPED to them', async () => {
    const { text, values } = await sqlFor({
      ...baseInput,
      user: { id: CREATOR, isModerator: false },
      userId: CREATOR,
      notPublished: true,
    });

    expect(text).toContain(DRAFTS_ONLY);
    // 🔴 Both halves. The grant alone is not safe — the creator scope is what
    // keeps it to one profile, and it is a different clause. The same-value-twice
    // mutation leaves the grant intact and drops exactly this.
    expect(text).toContain('i."userId" =');
    expect(values).toContain(CREATOR);
  });

  it('grants a moderator any creator’s drafts, SCOPED to that creator', async () => {
    const { text, values } = await sqlFor({
      ...baseInput,
      user: { id: MODERATOR, isModerator: true },
      userId: SOMEONE_ELSE,
      notPublished: true,
    });

    expect(text).toContain(DRAFTS_ONLY);
    expect(values).toContain(SOMEONE_ELSE);
  });

  it('REFUSES a non-moderator asking for someone else’s drafts', async () => {
    const { text } = await sqlFor({
      ...baseInput,
      user: { id: CREATOR, isModerator: false },
      userId: SOMEONE_ELSE,
      notPublished: true,
    });

    expect(text).not.toContain(DRAFTS_ONLY);
  });

  it('REFUSES a signed-in caller asking with no creator scope', async () => {
    // 🔴 The mutation-killer. `targetUserId: userId` collapses the check to "am I
    // signed in" and this input then returns every draft on the site.
    const { text } = await sqlFor({
      ...baseInput,
      user: { id: CREATOR, isModerator: false },
      notPublished: true,
    });

    expect(text).not.toContain(DRAFTS_ONLY);
  });

  it('REFUSES an anonymous caller entirely', async () => {
    const { text } = await sqlFor({ ...baseInput, userId: CREATOR, notPublished: true });

    expect(text).not.toContain(DRAFTS_ONLY);
  });

  it('does not grant drafts to a creator who did not ask', async () => {
    // Control: without it the first case passes against a build that emits the
    // drafts predicate unconditionally.
    const { text } = await sqlFor({
      ...baseInput,
      user: { id: CREATOR, isModerator: false },
      userId: CREATOR,
    });

    expect(text).not.toContain(DRAFTS_ONLY);
  });

  it('no longer pins a creator’s own unpublished work into an ordinary feed', async () => {
    // The user-facing bug this PR fixes on the DB path, which had no test either:
    // the old predicate was a bare `p."userId" = <viewer>` with no publish clause
    // and no opt-in, so drafts appeared in every feed. Reverting it fails here.
    const { text } = await sqlFor({ ...baseInput, user: { id: CREATOR, isModerator: false } });

    expect(text).toContain('p."publishedAt" < now()');
    // Scoped to the PUBLICATION clause. A bare `OR p."userId" = $n` search also
    // matches the private-content carve-out a few lines below it
    // (`(p."availability" != 'Private' ... OR p."userId" = $n)`), which is
    // unrelated and must stay — the first version of this assertion failed on
    // that and would have had me "fix" a correct clause.
    expect(text).not.toMatch(/p\."publishedAt" < now\(\)\s+OR/);
  });
});
