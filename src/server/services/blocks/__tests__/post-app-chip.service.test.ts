/**
 * The WIRING of the post-detail app chip — the seam nothing else covers.
 *
 * 🔴 WHY THIS FILE EXISTS, stated plainly because the gap it closes was invisible
 * to a fully green suite. The decision module (`post-app-chip.logic.ts`) is
 * pinned by 40-odd tests over its builders and its branches. Every one of them
 * stays green under each of these mutations of the WIRING:
 *
 *   - `storeScope: await resolveStoreVisibilityScope({ user })` → `storeScope: 'full'`
 *     — the entire disclosure gate defeated, 32/32 passed;
 *   - `findUnique(postAppChipQuery(appId))` → `findUnique({ where: { id: appId } })`
 *     — no `select` at all, so Prisma returns every `OauthClient` column
 *     including `secret`, 32/32 passed;
 *   - `postAppMarkerQuery(id)` → `postAppMarkerQuery(1)` — reads a different
 *     person's post, 32/32 passed.
 *
 * The builders being pinned says nothing about what is handed to Prisma, and the
 * gate's input is not part of the decision it gates. Those are relationships
 * between two modules, so only a test that loads both can see them. Precedent:
 * `app-listing-icon.service.test.ts`, the file this module's own split copies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveStoreVisibilityScope, mockGetDbWithoutLag } = vi.hoisted(() => {
  // 🔴 Set HERE, before the static imports are evaluated. `server-domain.ts`
  // builds its domain map from `process.env` at import time, so a top-level
  // `vi.stubEnv` runs too late and leaves `red` undefined — which would make the
  // red-host half of the maturity test below pass for the wrong reason (no host
  // is red-capable, so nothing is ever mature-allowed). See the longer note in
  // `post-app-chip.projection.test.ts`.
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return {
    mockResolveStoreVisibilityScope: vi.fn(async (..._a: unknown[]): Promise<string> => 'full'),
    mockGetDbWithoutLag: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
  };
});

// Spread the real modules rather than hand-listing their exports: a wholesale
// mock couples this file to the whole transitive export set, and nothing warns
// when that grows (the repo has shipped a suite collecting 0 tests that way).
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveStoreVisibilityScope: mockResolveStoreVisibilityScope,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDbWithoutLag: mockGetDbWithoutLag,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { postAppChipQuery, postAppMarkerQuery } from '~/server/services/blocks/post-app-chip.logic';
import { readPostAppChip } from '~/server/services/blocks/post-app-chip.service';

const POST_ID = 31107522;
const OTHER_POST_ID = 1;
const MARKER = 'appblk-custom-generators';
const HOST = 'civitai.com';
const USER = { id: 77, isModerator: true } as never;

const approvedAppRow = {
  name: 'Custom Generators Client',
  appBlocks: [
    {
      status: 'approved',
      currentVersionDeployedAt: new Date('2026-09-01T00:00:00.000Z'),
      appListing: {
        slug: 'custom-generators',
        name: 'Custom Generators',
        status: 'approved',
        kind: 'onsite',
        contentRating: 'pg',
        revisionOfId: null,
        icon: null,
      },
    },
  ],
};

/**
 * The lag-aware client the marker read must go through. A distinct object from
 * `dbMock.dbRead` on purpose: if the implementation reaches for the plain replica
 * instead, THIS spy records zero calls and the assertion names the real fault.
 */
function markerDb(metadata: unknown) {
  const findUnique = vi.fn(async (..._a: unknown[]) => ({ metadata }));
  mockGetDbWithoutLag.mockResolvedValue({ post: { findUnique } });
  return findUnique;
}

beforeEach(() => {
  mockResolveStoreVisibilityScope.mockReset();
  mockResolveStoreVisibilityScope.mockResolvedValue('full');
  mockGetDbWithoutLag.mockReset();
  // 🔴 `dbMock` is a SHARED singleton registered once globally and reset per
  // FILE, not per test — so without this, call counts accumulate across the
  // tests in this file and every `toHaveBeenCalledTimes(0)` below reads whatever
  // the earlier tests left behind. `mockClear` (not `mockReset`) keeps the
  // registered post-reset defaults that make an undeclared method return a
  // plausible empty answer.
  dbMock.dbRead.oauthClient.findUnique.mockClear();
});

describe('the store scope is RESOLVED, not assumed', () => {
  it('asks the server resolver for THIS viewer and passes its answer through', async () => {
    markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(approvedAppRow);

    await readPostAppChip({ postId: POST_ID, user: USER, host: HOST });

    // 🔴 The mutant this kills: `storeScope: 'full'` hardcoded at the call site.
    // Nothing in the decision module's own tests can see that, because the scope
    // is an input there.
    expect(mockResolveStoreVisibilityScope).toHaveBeenCalledTimes(1);
    expect(mockResolveStoreVisibilityScope).toHaveBeenCalledWith({ user: USER });
  });

  it('withholds the chip and issues NO read when the resolver says `none`', async () => {
    // The disclosure property, asserted at the rung where the scope actually
    // comes from. A hardcoded `'full'` makes this fail.
    const findUnique = markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(approvedAppRow);
    mockResolveStoreVisibilityScope.mockResolvedValue('none');

    await expect(
      readPostAppChip({ postId: POST_ID, user: undefined, host: HOST })
    ).resolves.toBeNull();

    expect(mockGetDbWithoutLag).toHaveBeenCalledTimes(0);
    expect(findUnique).toHaveBeenCalledTimes(0);
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledTimes(0);
  });

  it('withholds the chip when the resolver says `public-external`', async () => {
    markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(approvedAppRow);
    mockResolveStoreVisibilityScope.mockResolvedValue('public-external');

    await expect(readPostAppChip({ postId: POST_ID, user: USER, host: HOST })).resolves.toBeNull();
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledTimes(0);
  });
});

describe('both reads use the exact builders, on the right client', () => {
  it('reads the marker for the REQUESTED post, through the lag-aware client', async () => {
    const findUnique = markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(approvedAppRow);

    await readPostAppChip({ postId: POST_ID, user: USER, host: HOST });

    // 🔴 `getDbWithoutLag`, not the plain replica. The marker is written inside
    // the create-post transaction, so a bare replica read can miss it on the
    // publishing author's own first view — the one view most likely to be looked
    // at. Asserted on the ROUTING KEY too: a wrong entity name silently opts out
    // of the lag window.
    expect(mockGetDbWithoutLag).toHaveBeenCalledWith('post', POST_ID);
    // 🔴 And on the exact builder, so the `select: { metadata: true }` narrowing
    // cannot be dropped at the call site. `toEqual` against the builder's output
    // rather than a hand-written literal keeps the two from drifting.
    expect(findUnique).toHaveBeenCalledWith(postAppMarkerQuery(POST_ID));
    expect(findUnique).not.toHaveBeenCalledWith(postAppMarkerQuery(OTHER_POST_ID));
  });

  it('reads the app with the ALLOWLISTED select, for the marker it found', async () => {
    markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(approvedAppRow);

    await readPostAppChip({ postId: POST_ID, user: USER, host: HOST });

    // 🔴 The mutant this kills: dropping the `select` entirely, which makes
    // Prisma return `secret` / `redirectUris` / `allowedOrigins`. The projector's
    // allowlist still stops them reaching the client — defence in depth genuinely
    // holding — but a credential loaded into process memory on every public post
    // view is not something to leave to one layer.
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledWith(postAppChipQuery(MARKER));
  });

  it('returns the projected chip for a viewable app', async () => {
    markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(approvedAppRow);

    await expect(readPostAppChip({ postId: POST_ID, user: USER, host: HOST })).resolves.toEqual({
      slug: 'custom-generators',
      name: 'Custom Generators',
      iconUrl: null,
    });
  });

  it('passes the request HOST through to the maturity gate', async () => {
    // Same mature app, two hosts, opposite answers. A hardcoded host — or
    // dropping the parameter — collapses one of these onto the other.
    const mature = {
      ...approvedAppRow,
      appBlocks: [
        {
          ...approvedAppRow.appBlocks[0],
          appListing: { ...approvedAppRow.appBlocks[0].appListing, contentRating: 'r' },
        },
      ],
    };
    markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(mature);
    const onSfw = await readPostAppChip({ postId: POST_ID, user: USER, host: 'civitai.com' });

    markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(mature);
    const onRed = await readPostAppChip({ postId: POST_ID, user: USER, host: 'civitai.red' });

    // 🔴 WHOLE OBJECT, not `?.slug`. This assertion used to read
    // `expect(onSfw?.slug).toBeNull()`, which passed both when the chip was null
    // AND when it came back carrying the app's store title with a null slug — the
    // optional chain makes those two indistinguishable. That is the same
    // single-field blind spot that let a mature app's name render on a non-red
    // host, and it was this test that went red when the projection was fixed.
    expect(onSfw).toBeNull();
    expect(onRed).toEqual({
      slug: 'custom-generators',
      name: 'Custom Generators',
      iconUrl: null,
    });
  });

  it('does not look up an app for a post with no marker', async () => {
    const findUnique = markerDb({ imageNsfwLevel: 1 });

    await expect(readPostAppChip({ postId: POST_ID, user: USER, host: HOST })).resolves.toBeNull();

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledTimes(0);
  });
});

describe('it FAILS OPEN rather than taking the post page down', () => {
  it('returns null when the marker read throws', async () => {
    mockGetDbWithoutLag.mockRejectedValue(new Error('replica gone'));

    // Not `rejects` — the whole point is that the post page still renders.
    await expect(readPostAppChip({ postId: POST_ID, user: USER, host: HOST })).resolves.toBeNull();
  });

  it('returns null when the app read throws', async () => {
    markerDb({ blockPublishedAppId: MARKER });
    dbMock.dbRead.oauthClient.findUnique.mockRejectedValue(new Error('column does not exist'));

    await expect(readPostAppChip({ postId: POST_ID, user: USER, host: HOST })).resolves.toBeNull();
  });

  it('returns null when the scope resolver itself throws', async () => {
    mockResolveStoreVisibilityScope.mockRejectedValue(new Error('flipt unreachable'));

    await expect(readPostAppChip({ postId: POST_ID, user: USER, host: HOST })).resolves.toBeNull();
  });
});
