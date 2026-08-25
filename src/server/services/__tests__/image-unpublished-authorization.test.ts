import { describe, it, expect, vi, beforeEach } from 'vitest';

// Who may ask for unpublished content, and over whose work.
//
// Before this, `notPublished` was honoured for moderators and silently IGNORED for
// everyone else — safe by accident rather than by check, and it meant a creator had
// no way to see their own drafts. The Draft toggle on the profile images/videos tabs
// needs that capability, so the gate moved from `isModerator` to
// `canRequestUnpublished`, which authorizes on the request's own scoping.
//
// The dangerous shape is an UNSCOPED `notPublished` from a non-moderator: without
// the `targetUserId` half of the check that returns every draft on the site. The
// third case below is the one that catches it.
//
// Asserted on the filter string handed to Meili rather than on returned rows: the
// string IS the authorization decision, and rows from a fake cannot tell an enforced
// filter from an absent one.

import type * as MeilisearchClient from '~/server/meilisearch/client';

const { fetchDocumentsAbortableMock } = vi.hoisted(() => ({
  fetchDocumentsAbortableMock: vi.fn(),
}));

vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return {
    ...actual,
    metricsSearchClient: {},
    getMetricsSearchClient: () => ({}),
    fetchDocumentsAbortable: fetchDocumentsAbortableMock,
  };
});

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
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { getImagesFromSearchPreFilter, getImagesFromSearchPostFilter } from '../image.service';

const CREATOR = 3300;
const SOMEONE_ELSE = 4400;
const MODERATOR = 5500;

type SearchArg = Parameters<typeof getImagesFromSearchPreFilter>[0];

const baseInput = {
  limit: 20,
  period: 'AllTime',
  sort: 'Newest',
  browsingLevel: 31,
  include: [] as string[],
  headers: { src: 'test' },
};

const filterFor = async (
  fn: typeof getImagesFromSearchPreFilter | typeof getImagesFromSearchPostFilter,
  input: Record<string, unknown>
) => {
  await expect(fn(input as unknown as SearchArg)).rejects.toThrow('stop here');
  expect(fetchDocumentsAbortableMock).toHaveBeenCalledTimes(1);
  const [, request] = fetchDocumentsAbortableMock.mock.calls[0];
  return String((request as { filter: string }).filter);
};

// `publishedAtUnix NOT EXISTS` is the drafts-only clause. Its PRESENCE is the
// capability being granted, so every case below asserts on it directly rather than
// on a count of returned rows.
const DRAFTS_ONLY = 'publishedAtUnix NOT EXISTS';

beforeEach(() => {
  vi.clearAllMocks();
  fetchDocumentsAbortableMock.mockRejectedValue(new Error('stop here'));
});

describe.each([
  ['getImagesFromSearchPreFilter', getImagesFromSearchPreFilter],
  ['getImagesFromSearchPostFilter', getImagesFromSearchPostFilter],
])('%s — who may ask for unpublished content', (_name, fn) => {
  it('grants a creator their own drafts on their own profile', async () => {
    const filter = await filterFor(fn, {
      ...baseInput,
      currentUserId: CREATOR,
      userId: CREATOR,
      isModerator: false,
      notPublished: true,
    });

    expect(filter).toContain(DRAFTS_ONLY);
  });

  it('grants a moderator any creator’s drafts', async () => {
    const filter = await filterFor(fn, {
      ...baseInput,
      currentUserId: MODERATOR,
      userId: SOMEONE_ELSE,
      isModerator: true,
      notPublished: true,
    });

    expect(filter).toContain(DRAFTS_ONLY);
  });

  it('REFUSES a non-moderator asking for someone else’s drafts', async () => {
    const filter = await filterFor(fn, {
      ...baseInput,
      currentUserId: CREATOR,
      userId: SOMEONE_ELSE,
      isModerator: false,
      notPublished: true,
    });

    expect(filter).not.toContain(DRAFTS_ONLY);
  });

  it('REFUSES a non-moderator asking with no creator scope at all', async () => {
    // 🔴 The one that matters. `canRequestUnpublished` authorizes on the request's
    // own scoping, so dropping its `targetUserId` half leaves a check that reads
    // "am I signed in" — and this input would then return every draft on the site
    // to any logged-in caller who sets one query param. Mutate the helper to
    // `if (isModerator) return true; return !!currentUserId;` and this is the only
    // case here that fails.
    const filter = await filterFor(fn, {
      ...baseInput,
      currentUserId: CREATOR,
      isModerator: false,
      notPublished: true,
    });

    expect(filter).not.toContain(DRAFTS_ONLY);
  });

  it('REFUSES an anonymous caller asking for a creator’s drafts', async () => {
    const filter = await filterFor(fn, {
      ...baseInput,
      userId: CREATOR,
      isModerator: false,
      notPublished: true,
    });

    expect(filter).not.toContain(DRAFTS_ONLY);
  });

  it('does not grant drafts to a creator who did not ask', async () => {
    // The control for the first case. Without it, that assertion passes against a
    // build that emits the drafts clause unconditionally — which would be a far
    // worse bug than the one being fixed.
    const filter = await filterFor(fn, {
      ...baseInput,
      currentUserId: CREATOR,
      userId: CREATOR,
      isModerator: false,
    });

    expect(filter).not.toContain(DRAFTS_ONLY);
  });
});
