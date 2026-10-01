/**
 * The controller→component SEAM, and the DTO's key-count ledger.
 *
 * 🔴 WHAT THIS FILE DOES NOT GUARD — read this before adding a metadata
 * assertion to it, because an earlier revision had three and all three were
 * UNFALSIFIABLE.
 *
 * `getPostDetail` is MOCKED here. So no `Post.metadata` ever enters the system
 * under test, and no assertion in this file can observe a metadata leak: the
 * three `not.toContain('reviewId' | 'imageNsfwLevel' | <moderator id>)` checks
 * and an `unpublishedBy === null` check were all passing vacuously, and would
 * have passed against any controller mutation. Worse, widening `postSelect` to
 * `metadata: true` — the ACTUAL hazard — changes nothing here, because the
 * selector is mocked out of the picture. The header used to claim this file
 * guarded "a second, unguarded door" into the public payload. It did not guard it
 * at all, and reading as defence-in-depth while providing none is worse than
 * providing none, because it stops the next reader looking.
 *
 * ✅ THE REAL GUARD EXISTS AND IS GENUINELY TESTED, one layer down:
 * `postSelect` carries no `metadata` key, pinned by `__tests__/
 * post-app-chip.projection.test.ts` both as a negative (`not.toContain`) and as a
 * SORTED KEY LEDGER over the whole projection — so the field cannot be added
 * under any spelling, and the set cannot be widened by anything else either. That
 * is where a metadata assertion belongs. `unpublishedBy`'s forced `null` for a
 * published post is likewise a property of `getPostDetail`, which this change
 * does not touch and which this file cannot see.
 *
 * ⚠️ A controller-level metadata strip was considered and deliberately NOT added:
 * it would be a new runtime guard, the card's non-goals forbid one beyond the two
 * named criteria, and the guard that matters already exists.
 *
 * WHAT IT DOES GUARD, and both are falsifiable — each was watched to fail:
 *
 *  - THE SEAM. The chip's decision module and its React component are each
 *    hermetically tested, and both stay green if the controller never attaches
 *    the field — the feature would be inert with 40-odd passing tests. Mutant:
 *    drop `publishedWithApp` from the returned spread → 3 failed.
 *  - THE KEY-COUNT LEDGER. Exactly one key may be added to this public,
 *    anon-capable payload. This one IS falsifiable even against metadata, because
 *    it counts KEYS rather than inspecting values: spreading `metadata` in adds
 *    the key whatever its value, including `undefined`. Mutant: add it → 1 failed,
 *    `expected [ 'publishedWithApp', 'metadata' ] to deeply equal
 *    [ 'publishedWithApp' ]`.
 *  - The chip is resolved with the RETURNED post's id, the session user and the
 *    request host, and only AFTER the authorisation and blocked-user checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetPostDetail, mockAmIBlockedByUser, mockReadPostAppChip } = vi.hoisted(() => ({
  mockGetPostDetail: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
  mockAmIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
  mockReadPostAppChip: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));

// Spread the real modules: a hand-listed mock couples this file to the whole
// transitive export set of a very large service, and nothing warns when it grows.
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPostDetail: mockGetPostDetail,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  amIBlockedByUser: mockAmIBlockedByUser,
}));
vi.mock('~/server/services/blocks/post-app-chip.service', () => ({
  readPostAppChip: mockReadPostAppChip,
}));

import { getPostHandler } from '~/server/controllers/post.controller';

const POST_ID = 31107522;
const AUTHOR_ID = 5;
const VIEWER = { id: 77, isModerator: false } as never;
const HOST = 'civitai.com';

const CHIP = { slug: 'custom-generators', name: 'Custom Generators', iconUrl: null };

/**
 * A published post exactly as `getPostDetail` returns one: the `postSelect`
 * fields, its two transforms, and the `PostUnpublishContext` it appends.
 *
 * ⚠️ NO `metadata` KEY, DELIBERATELY — and an earlier revision's note claiming the
 * opposite ("`metadata` IS PRESENT ON THIS FIXTURE… a fixture without it could not
 * fail") was wrong in a way worth recording. It carried the real moderator-id
 * keys, but the mock was only ever handed a copy with `metadata` destructured
 * OUT, so the blob never entered the system under test and every assertion over
 * it was vacuous. The honest fixture is the shape `getPostDetail` actually
 * returns; the metadata guard lives at the selector, as the header explains.
 */
const selected = () => ({
  id: POST_ID,
  nsfw: false,
  nsfwLevel: 1,
  title: 'A post',
  detail: null,
  modelVersionId: null,
  modelVersion: null,
  user: { id: AUTHOR_ID, username: 'author' },
  publishedAt: new Date('2026-09-20T00:00:00.000Z'),
  availability: 'Public',
  tags: [],
  collectionId: null,
  // PostUnpublishContext, as computed for a PUBLISHED post.
  wasPublished: false,
  unpublishedAt: null,
  unpublishedBy: null,
  parentModelId: null,
});

const ctx = (over: Record<string, unknown> = {}) =>
  ({ user: VIEWER, req: { headers: { host: HOST } }, ...over } as never);

beforeEach(() => {
  mockGetPostDetail.mockReset();
  mockGetPostDetail.mockResolvedValue(selected());
  mockAmIBlockedByUser.mockReset();
  mockAmIBlockedByUser.mockResolvedValue(false);
  mockReadPostAppChip.mockReset();
  mockReadPostAppChip.mockResolvedValue(CHIP);
});

describe('the assembled payload carries the chip and nothing else new', () => {
  it('attaches `publishedWithApp` — the seam the component reads', async () => {
    // 🔴 Without this, the chip's module tests and its component tests are both
    // green while the feature is inert: nothing else in the change asserts that
    // the resolved chip is ever attached to the DTO the page renders from.
    const result = (await getPostHandler({ input: { id: POST_ID }, ctx: ctx() })) as Record<
      string,
      unknown
    >;
    expect(result.publishedWithApp).toEqual(CHIP);
  });

  it('adds EXACTLY one key to the payload', async () => {
    // A ledger over the whole DTO. `getPostDetail`'s own output is the baseline,
    // so this does not restate the selector's field list and cannot drift from it.
    //
    // 🔴 THE ONE ASSERTION HERE THAT CAN SEE A METADATA SPREAD, and only because
    // it counts KEYS rather than inspecting values: spreading `metadata` in adds
    // the key whatever its value, `undefined` included. Everything value-based
    // about metadata is unfalsifiable in this file — see the header — and the
    // three assertions that tried were removed rather than left reading as
    // coverage.
    const result = (await getPostHandler({ input: { id: POST_ID }, ctx: ctx() })) as Record<
      string,
      unknown
    >;
    const added = Object.keys(result).filter((k) => !(k in selected()));
    expect(added).toEqual(['publishedWithApp']);
  });
});

describe('the chip is resolved AFTER authorisation, for the right post and viewer', () => {
  it('passes the RETURNED post id, the session user and the request host', async () => {
    await getPostHandler({ input: { id: POST_ID }, ctx: ctx() });

    // 🔴 `post.id` — the row that was actually returned — never `input.id`. The
    // resolver takes the post as already-admitted and does not re-derive its
    // visibility, so an unvetted id would disclose whether that post was
    // app-published. And the viewer must be the session user: `user: undefined`
    // resolves scope `none` for everyone, silently disabling the feature.
    expect(mockReadPostAppChip).toHaveBeenCalledWith({
      postId: POST_ID,
      user: VIEWER,
      host: HOST,
    });
  });

  it('does NOT resolve a chip for a post the viewer is blocked from', async () => {
    // Ordering, asserted by a call count. If the chip were resolved before the
    // block check, a blocked viewer's request would still read the marker and the
    // app — work done on behalf of a request that is about to 404.
    mockAmIBlockedByUser.mockResolvedValue(true);

    await expect(getPostHandler({ input: { id: POST_ID }, ctx: ctx() })).rejects.toThrow();
    expect(mockReadPostAppChip).toHaveBeenCalledTimes(0);
  });

  it('falls back to an empty host when the request carries none', async () => {
    // Fail-closed: `ratingAllowedOnHost('')` refuses a mature app, so a missing
    // host under-links rather than over-links. `undefined` would instead throw at
    // the maturity term.
    await getPostHandler({ input: { id: POST_ID }, ctx: ctx({ req: undefined }) });
    expect(mockReadPostAppChip).toHaveBeenCalledWith({
      postId: POST_ID,
      user: VIEWER,
      host: '',
    });
  });

  it('still returns the payload when no chip resolves', async () => {
    mockReadPostAppChip.mockResolvedValue(null);
    const result = (await getPostHandler({ input: { id: POST_ID }, ctx: ctx() })) as Record<
      string,
      unknown
    >;
    expect(result.publishedWithApp).toBeNull();
    expect(result.id).toBe(POST_ID);
  });
});
