import { describe, it, expect, vi, beforeEach } from 'vitest';

// Type-only namespace imports rather than `typeof import('…')` inside the
// factories: @typescript-eslint/consistent-type-imports forbids `import()` type
// annotations, and this is the spelling the repo's own no-wholesale-module-mock
// rule documents as the alternative.
import type * as FliptClient from '../../flipt/client';
import type * as PromClient from '~/server/prom/client';

/**
 * Sibling of `hot-path-select-narrowing.test.ts`, which pins the two
 * `entity-collaborator.service` projections and the reaction selector.
 *
 * This one pins the third narrowed path: the `hasSystemPosts` existence check
 * inside `getAllImages`. It lives in its own file because importing
 * `image.service` requires a whole env / redis / clickhouse / submodule mock
 * block, and `vi.mock` is file-scoped — dropping that block into the sibling
 * would change what the collaborator tests import.
 *
 * The guarded defect: the check reads its result ONLY as a boolean
 * (`if (prioritizseIsSystemUser && !hasSystemPosts)`), so a bare
 * `findFirst({ where })` decodes an entire `Post` row — three DateTimes and the
 * `metadata` Json — to answer yes/no. `select: { id: true }` is what keeps it
 * from doing that, and nothing else in the suite would notice it regrowing.
 *
 * 🔴 The shape is pinned by an exact-key-set `toEqual`, never by "does not
 * contain <column>". An unnarrowed call has no `select` key at all, and every
 * absence assertion over `Object.keys(undefined ?? {})` passes on precisely
 * the shape being rejected; `toEqual` fails on `undefined` by itself. An
 * earlier revision followed the `toEqual` with a loop asserting each tagged
 * `Post` column was absent, and it has been removed. Given a FIXED `expected`
 * that loop was redundant — any select containing one of those columns had
 * already failed the line above — but it also went red when `expected` was
 * widened ALONGSIDE the source, which a `toEqual` against the widened
 * `expected` cannot catch, so removing it accepts the loss of that narrow
 * ratchet against a test-file edit. The `toBeDefined` that remains is for its
 * failure message, not for coverage.
 *
 * The mock block mirrors the established recipe from
 * `getAllImages-prioritized-guards.test.ts`, with one difference: `isFlipt`
 * resolves FALSE here, because `hasSystemPosts` sits in the
 * `prioritizeUser && !useModelVersionCache` branch — the opposite side of the
 * flag from the branch that file exercises.
 */

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

// event-engine-common is a git submodule — stub the value imports image.service
// pulls from it so this suite does not depend on it being checked out.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Importing the real `~/env/server` validates ALL prod env vars and throws in
// test. A Proxy returns safe values for anything read at module load.
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

// A sentinel thrown from the mocked `post.findFirst` so the test stops exactly
// at the call under inspection. Everything after it in `getAllImages` is a raw
// SQL feed query whose mocking would add nothing to what is being pinned.
const STOP = new Error('__stop_after_hasSystemPosts__');
const postFindFirst = dbMock.dbRead.post.findFirst;

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
// The branch under test sits after this — stub it so `getAllImages` proceeds.
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

// FALSE, so `useModelVersionCache` is false and the `prioritizeUser &&
// !useModelVersionCache` branch (the one holding `hasSystemPosts`) is taken.
vi.mock('../../flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(false) };
});

import { getAllImages } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const SYSTEM_USER_ID = -1;
const MODEL_VERSION_ID = 456;

const systemUserInput = {
  browsingLevel: 1,
  // Exactly one prioritized id, and it is the system user — that is what makes
  // `prioritizseIsSystemUser` true and issues the existence check.
  prioritizedUserIds: [SYSTEM_USER_ID],
  modelVersionId: MODEL_VERSION_ID,
  include: [],
} as unknown as Parameters<typeof getAllImages>[0];

/** Drives `getAllImages` to the existence check and returns that call's args. */
async function captureHasSystemPostsCall() {
  postFindFirst.mockImplementation(() => {
    throw STOP;
  });

  let caught: unknown;
  try {
    await getAllImages(systemUserInput);
  } catch (e) {
    caught = e;
  }

  // Positive control on the harness itself: if `getAllImages` returned early or
  // threw somewhere else, the query never ran and any assertion below would be
  // a statement about nothing.
  expect(caught, 'getAllImages did not reach the hasSystemPosts check').toBe(STOP);
  expect(postFindFirst).toHaveBeenCalledTimes(1);

  return postFindFirst.mock.calls[0][0] as {
    where?: Record<string, unknown>;
    select?: Record<string, boolean>;
  };
}

describe('getAllImages hasSystemPosts — an existence check, projected to one column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects the existence check instead of decoding a whole Post row', async () => {
    const args = await captureHasSystemPostsCall();

    // Named first so a bare `findFirst({ where })` reports the real defect
    // rather than an `undefined` mismatch. The `toEqual` below would catch it
    // regardless — see the header.
    expect(args.select, 'a bare findFirst fetches every Post column').toBeDefined();

    // The exact key set: re-adding any Post column — the tagged ones
    // (`metadata`, `createdAt`, `updatedAt`, `publishedAt`) above all, since
    // each is a client-side decode — fails here.
    expect(args.select).toEqual({ id: true });
  });

  it('still asks the question it was asking — system user, this model version', async () => {
    // Behavioural pair: narrowing the projection must not have touched the
    // predicate. A `select` pinned over a `where` that no longer identifies the
    // system user's posts would be a green shape check over broken logic.
    const args = await captureHasSystemPostsCall();

    expect(args.where).toEqual({ userId: SYSTEM_USER_ID, modelVersionId: MODEL_VERSION_ID });
  });
});
