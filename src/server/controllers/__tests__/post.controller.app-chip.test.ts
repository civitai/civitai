/**
 * The ASSEMBLED post-detail payload — criterion 5's remaining route, and the
 * controller→component seam.
 *
 * 🔴 WHY HERE RATHER THAN ON THE SELECTOR. `postSelect`'s key ledger stops
 * `metadata` entering the Prisma projection, and that is the main door. But since
 * this change the CONTROLLER also constructs the DTO (`{ ...post,
 * publishedWithApp }`), which is a second, unguarded door into the same public,
 * anon-capable payload: adding `metadata` to that spread ships every
 * `Post.metadata` key — `unpublishedBy` (a moderator id), `unpublishedAt`,
 * `reviewId` — with the selector ledger still green. Measured: that mutant
 * survived every other test in this change.
 *
 * It also pins the SEAM. The chip's decision module and its React component are
 * each hermetically tested, and both stay green if the controller never attaches
 * the field — the feature would simply be inert, with 40-odd passing tests. And
 * it pins criterion 7 by VALUE for the first time: nothing in the repo asserted
 * `unpublishedBy === null` for a published post, before or after this change.
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
 * 🔴 `metadata` IS PRESENT ON THIS FIXTURE, carrying the real moderator-id keys.
 * That is the point: `getPostDetail` does not return it today, but the fixture
 * supplies it so a controller that starts spreading it has somewhere to get it
 * from. A fixture without it could not fail.
 */
const publishedPost = () => ({
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
  // Not returned by the real selector — see above.
  metadata: {
    blockPublishedAppId: 'appblk-custom-generators',
    unpublishedBy: 318,
    unpublishedAt: '2026-04-02T00:00:00.000Z',
    reviewId: 8812,
    imageNsfwLevel: 1,
  },
});

/** What `getPostDetail` actually hands back — the fixture minus `metadata`. */
const selected = () => {
  const { metadata: _omitted, ...rest } = publishedPost();
  return rest;
};

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
    // A ledger over the whole DTO. It fails if `metadata` is spread in, and
    // equally if some later change quietly widens this public read by anything
    // else. `getPostDetail`'s own output is the baseline, so this test does not
    // restate the selector's field list and cannot drift from it.
    const result = (await getPostHandler({ input: { id: POST_ID }, ctx: ctx() })) as Record<
      string,
      unknown
    >;
    const added = Object.keys(result).filter((k) => !(k in selected()));
    expect(added).toEqual(['publishedWithApp']);
  });

  it('puts no raw Post.metadata key on the wire', async () => {
    // The behavioural form of the same property, against the VALUES rather than
    // the key set — so it also catches a spread that flattens the blob in.
    const result = await getPostHandler({ input: { id: POST_ID }, ctx: ctx() });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('reviewId');
    expect(serialized).not.toContain('imageNsfwLevel');
    expect(serialized).not.toContain('8812');
    // 318 is the moderator id in the fixture's metadata. `unpublishedBy` itself
    // IS a legitimate DTO key (forced null below), so the VALUE is what matters.
    expect(serialized).not.toContain('318');
  });

  it('keeps `unpublishedBy` null for a published post — criterion 7, by value', async () => {
    // Nothing in the repo asserted this before, in either direction. Widening
    // `postSelect` to `metadata: true` would have routed the real moderator id
    // (318, in the fixture) to the client by a second path that nothing guards;
    // this is the assertion that would have caught it on the DTO.
    const result = (await getPostHandler({ input: { id: POST_ID }, ctx: ctx() })) as Record<
      string,
      unknown
    >;
    expect(result.unpublishedBy).toBeNull();
    expect(result.unpublishedAt).toBeNull();
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
