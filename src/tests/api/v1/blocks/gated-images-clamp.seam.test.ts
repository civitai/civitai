import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * THE SEAM TEST for `GET /api/v1/blocks/gated-images`: the REST handler, the
 * shared body (`resolveGatedImagesForBlockClaims`), the projection
 * (`getBlockGatedImagesByIds`) and the pure clamp
 * (`classifyGatedImageForViewer`) running TOGETHER, with only the database, the
 * viewer's hidden-prefs, the edge-url helper and the two gates the route cannot
 * reach in a unit env stubbed out.
 *
 * 🔴 WHY IT IS A SEAM TEST AND NOT FOUR UNIT TESTS. Every piece above already has
 * its own coverage — `block-gated-images.service.test.ts` for the projection,
 * `block-gated-images.logic.test.ts` for the clamp, and
 * `gated-images-endpoint.test.ts` for the adapter (which mocks the shared body
 * away entirely, as adapter tests must). All three can be green while the route
 * is broken, because none of them ever builds the combined state: the one thing
 * that decides whether this surface is safe is whether the CLAIM'S ceiling
 * actually reaches the per-row decision, and that relationship lives in no single
 * component. This file is the only place it is asserted.
 *
 * WHAT IS MOCKED, AND WHY EACH ONE CANNOT DECIDE THE OUTCOME:
 *   - `withBlockScope` → a passthrough that stamps `blockClaims`. It is the token
 *     verifier; the route is unreachable in a unit env without it, and stubbing it
 *     is what LETS the clamp be exercised rather than what decides it.
 *   - `assertAppBlocksEnabledForTokenUser` → allow. An earlier gate. Stubbing it
 *     to allow makes the clamp REACHABLE; stubbing it to refuse would make every
 *     assertion below vacuous, which is the failure this note exists to prevent.
 *   - `checkBlockCatalogRateLimit` → allowed. Same argument.
 *   - `dbRead.$queryRaw`, `getAllHiddenForUser`, `getEdgeUrl` → the I/O boundary.
 *   - `handleEndpointError` → captured, so a refusal's TRPCError code is asserted
 *     directly. Its status mapping is `endpoint-helpers-error-envelope.test.ts`'s.
 *
 * `resolveViewerBrowsingLevel`, `classifyGatedImageForViewer` and the whole
 * projection are REAL. Nothing between the token claim and the wire is stubbed.
 */

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', async () => {
  // 🔴 `parseSubjectUserId` IS REAL — the anon refusal below is one of the things
  // under test, and stubbing the subject parser would decide it rather than
  // observe it. Only the wrapper is replaced, and only so the route module can be
  // imported: the cases drive `baseHandler` (the UNWRAPPED export) directly and
  // set `blockClaims` on the request themselves, so this stub stamps nothing.
  const actual = (await vi.importActual('~/server/middleware/block-scope.middleware')) as Record<
    string,
    unknown
  >;
  return { ...actual, withBlockScope: (handler: unknown) => handler };
});
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockAssertEnabled, mockRateLimit, mockHandleEndpointError, mockGetAllHidden } = vi.hoisted(
  () => ({
    mockAssertEnabled: vi.fn(),
    mockRateLimit: vi.fn(),
    mockHandleEndpointError: vi.fn(),
    mockGetAllHidden: vi.fn(),
  })
);

vi.mock('~/server/services/blocks/block-token-access.service', () => ({
  assertAppBlocksEnabledForTokenUser: mockAssertEnabled,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockRateLimit,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: mockGetAllHidden,
}));
// Deterministic edge-url so the assertions are stable and the real CF util (which
// reads env) never loads. It EMBEDS the raw storage key, which is what lets the
// hidden-case assertions state that the key never crosses the wire.
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (url: string, opts?: { width?: number }) => `edge:${url}@${opts?.width}`,
}));
// The provenance-marker constant, stubbed so the test does not pull the image
// upload service's env/S3 graph. Same stub the service's own unit test uses.
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  BLOCK_PUBLISHED_APP_ID_META_KEY: 'blockPublishedAppId',
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { baseHandler } from '~/pages/api/v1/blocks/gated-images';

const queryRaw = dbMock.dbRead.$queryRaw;

/** The app the token belongs to. */
const APP = 'app_seam';
/** The requesting viewer. Distinct from AUTHOR and from every image id, so a
 *  mixed-up field cannot coincidentally satisfy an assertion. */
const VIEWER = 42;
/** Someone ELSE — the default fixture is the CROSS-USER path. */
const AUTHOR = 7;

/**
 * A SFW ceiling (PG | PG13 = 3) and a MATURE image level (R = 4). Disjoint bit
 * sets, and — the part that matters — `R` is NOT a value the SFW ceiling could
 * ever produce, so a mutant that ignores the claim and hardcodes a wide ceiling
 * changes the answer instead of coincidentally reproducing it.
 */
const SFW_CEILING = NsfwLevel.PG | NsfwLevel.PG13;
const MATURE_CEILING = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R;
const MATURE_LEVEL = NsfwLevel.R;

function claimsWith(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${VIEWER}`,
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'b',
    appId: APP,
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes: [],
    maxBrowsingLevel: SFW_CEILING,
    ...over,
  } as unknown as BlockTokenClaims;
}

/** A row that passes EVERY check ahead of the maturity clamp: no moderation flag
 *  is set, the scan reached a terminal `Scanned`, and a real level was written.
 *  The ONLY thing that can decide it is the clamp — which is what makes the clamp
 *  reachable rather than shadowed by an earlier refusal. */
const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  userId: AUTHOR,
  url: `key-${id}`,
  nsfwLevel: MATURE_LEVEL,
  ingestion: ImageIngestionStatus.Scanned,
  width: 512,
  height: 512,
  needsReview: null,
  poi: false,
  minor: false,
  tosViolation: false,
  acceptableMinor: false,
  blockedFor: null,
  ...over,
});

function createMocks({
  method = 'GET',
  query = { ids: '1' } as Record<string, unknown>,
}: { method?: string; query?: Record<string, unknown> } = {}) {
  const req = {
    method,
    query,
    // Exactly what `withBlockScope` stamps on a verified request.
    blockClaims: claimsBox.claims,
    headers: { authorization: 'Bearer tok_gated', host: 'civitai.test' },
    url: '/api/v1/blocks/gated-images',
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
      return res;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
    _headers: () => headers,
  };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockReset();
  claimsBox.claims = claimsWith();
  mockAssertEnabled.mockResolvedValue(undefined);
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockGetAllHidden.mockResolvedValue({
    hiddenUsers: [],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [],
  });
});

describe('GET /api/v1/blocks/gated-images — the maturity clamp reaches the wire', () => {
  it('CONTROL: the same row IS visible when the token ceiling admits its level', async () => {
    // 🔴 THE POSITIVE HALF OF THE PAIR, AND IT IS NOT OPTIONAL. Without it the
    // `hidden` assertion below is indistinguishable from a fixture that could
    // never have been visible for some unrelated reason (a flag left set, a
    // non-terminal ingestion, a query that returned nothing). Same row, same
    // handler, ONE input moved — the token's ceiling — and the answer moves with
    // it. That is what makes the next test a statement about the clamp.
    claimsBox.claims = claimsWith({ maxBrowsingLevel: MATURE_CEILING });
    queryRaw.mockResolvedValue([row(1)]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(200);
    expect((res._json() as any).images).toEqual([
      {
        imageId: 1,
        status: 'visible',
        nsfwLevel: MATURE_LEVEL,
        contentRating: expect.any(String),
        url: 'edge:key-1@1200',
        width: 512,
        height: 512,
      },
    ]);
  });

  it('an above-ceiling image comes back `hidden`, with NO url, on a SFW token ceiling', async () => {
    // The regression case. `maxBrowsingLevel` is SFW, the row is rated R, and
    // nothing earlier in the ladder can refuse it — so if this returns anything
    // but `hidden` the clamp did not run, ran against the wrong number, or ran
    // and was ignored.
    queryRaw.mockResolvedValue([row(1)]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(200);
    const body = res._json() as { images: unknown[] };
    expect(body.images).toEqual([{ imageId: 1, status: 'hidden' }]);
    // 🔴 Asserted on the SERIALISED body, not on the entry: the property that
    // matters is that no url reached the wire by ANY route — not merely that the
    // one field we thought to name is absent. `getEdgeUrl` embeds the raw storage
    // key, so this also states the key itself never crossed.
    expect(JSON.stringify(body)).not.toContain('edge:');
    expect(JSON.stringify(body)).not.toContain('key-1');
  });

  it('the CLIENT cannot widen the ceiling — no query parameter moves the clamp', async () => {
    // INVARIANT GUARD (labelled as such — no bug ever violated it): the schema
    // has no maturity field at all, so these are stripped. It pins that a future
    // author cannot add one without this going red.
    queryRaw.mockResolvedValue([row(1)]);

    const { req, res } = createMocks({
      query: { ids: '1', browsingLevel: '31', nsfw: 'true', maxBrowsingLevel: '31' },
    });
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(200);
    expect((res._json() as any).images).toEqual([{ imageId: 1, status: 'hidden' }]);
  });

  it('a malformed ceiling FAILS CLOSED to the public floor rather than opening up', async () => {
    // `resolveViewerBrowsingLevel(undefined)` → publicBrowsingLevelsFlag, which
    // carries no mature bit. A token minted before the claim existed must not be
    // read as "no ceiling declared, so no ceiling applies".
    claimsBox.claims = claimsWith({ maxBrowsingLevel: undefined });
    queryRaw.mockResolvedValue([row(1)]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect((res._json() as any).images).toEqual([{ imageId: 1, status: 'hidden' }]);
  });
});

describe('GET /api/v1/blocks/gated-images — visible/hidden vs omission', () => {
  it('discriminates hidden from omitted in ONE response', async () => {
    // 🔴 THE PROPERTY THIS ROUTE EXISTS FOR. `/api/v1/blocks/images?ids=` reports
    // both cases by omission, which makes a withheld image indistinguishable from
    // a deleted one and leaves a consumer unable to render the "Hidden — rated
    // mature" tile it renders today. Here the two are DIFFERENT observations:
    //   id 1 → resolvable, above the ceiling  → `hidden` (existence disclosed —
    //          the calling app published it and already holds the id)
    //   id 2 → not returned by the app-scoped query at all → OMITTED (existence
    //          would itself be the disclosure)
    queryRaw.mockResolvedValue([row(1)]);

    const { req, res } = createMocks({ query: { ids: '1,2' } });
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(200);
    expect((res._json() as any).images).toEqual([{ imageId: 1, status: 'hidden' }]);
  });

  it('preserves REQUEST order and de-duplicates, whatever order the rows arrive in', async () => {
    queryRaw.mockResolvedValue([row(3, { nsfwLevel: NsfwLevel.PG }), row(1)]);

    const { req, res } = createMocks({ query: { ids: '1,3,1' } });
    await (baseHandler as any)(req, res);

    expect((res._json() as any).images.map((i: any) => i.imageId)).toEqual([1, 3]);
  });

  it('scopes the read to the TOKEN’s appId — never a value from the request', async () => {
    queryRaw.mockResolvedValue([]);

    const { req, res } = createMocks({ query: { ids: '1', appId: 'app_someone_else' } });
    await (baseHandler as any)(req, res);

    // The app scope reaches the SQL as a bound substitution, and it is the
    // token's, not the query string's.
    const substitutions = queryRaw.mock.calls[0]?.slice(1) ?? [];
    expect(substitutions).toContain(APP);
    expect(substitutions).not.toContain('app_someone_else');
  });

  it('binds the blocked-users / blocked-tags read to the TOKEN subject', async () => {
    queryRaw.mockResolvedValue([]);

    const { req, res } = createMocks({ query: { ids: '1', userId: '999' } });
    await (baseHandler as any)(req, res);

    expect(mockGetAllHidden).toHaveBeenCalledWith({ userId: VIEWER });
  });
});

describe('GET /api/v1/blocks/gated-images — the gates ahead of the clamp', () => {
  it('refuses an ANONYMOUS subject rather than answering with an empty list', async () => {
    claimsBox.claims = claimsWith({ sub: 'anon' });

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    // Parity with the bridge: a TRPCError UNAUTHORIZED, handed to
    // handleEndpointError (whose 401 mapping is pinned elsewhere). Asserted on
    // the CODE rather than on a message, so a reworded string does not fail it
    // and a reclassified refusal does.
    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    const err = mockHandleEndpointError.mock.calls[0][1] as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('UNAUTHORIZED');
    // And it never reached the database.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('propagates the App-Blocks kill-switch refusal and never reads the DB', async () => {
    // 🔴 THE FIXTURE MUST BE THE CODE THE REAL COLLABORATOR THROWS, NOT A
    // PLAUSIBLE ONE. This case used to reject with `FORBIDDEN` / "App Blocks is
    // not enabled for this account" — a pairing `assertAppBlocksEnabledForTokenUser`
    // has never emitted. Both of its refusals are `UNAUTHORIZED`
    // (`block-token-access.service.ts`: "runtime block token subject could not be
    // resolved" and "Apps are not enabled"), which is what the sibling pins assert
    // — `blocks.router.createPostFromApp.test.ts`, `apps.router.storage.test.ts`,
    // `blocks.router.flag-gate-hydrate.test.ts` — and `blocks.router.me-parity.test.ts`
    // asserts the resulting status outright as **401**, not 403. Those pins drive the
    // REAL function (they mock only `isAppBlocksEnabled`, one level below it), so
    // they are evidence about the code; this case mocks the function itself, so its
    // fixture is only ever as good as whoever typed it. The invented code was
    // harmless to the old assertion and not harmless beside it: the route's docblock
    // stated the kill-switch as 403, agreeing with this fixture and with nothing in
    // the function. Both are corrected in the same commit.
    mockAssertEnabled.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' })
    );

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect(mockHandleEndpointError).toHaveBeenCalledTimes(1);
    const err = mockHandleEndpointError.mock.calls[0][1] as TRPCError;
    expect(err.code).toBe('UNAUTHORIZED');
    // Asserted on the MESSAGE too, because the anon refusal above is now the same
    // CODE — without this the two cases stop being separable and this one would
    // pass on the anon path firing instead.
    expect(err.message).toBe('Apps are not enabled');
    expect(err.message).not.toContain('could not be resolved');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('evaluates the kill-switch against the TOKEN SUBJECT, not a session user', async () => {
    // The #5087 shape: `enforceAppBlocksFlag` would have read `ctx.user`, which is
    // undefined here. Pin that the argument is the subject parsed off the claim.
    queryRaw.mockResolvedValue([]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect(mockAssertEnabled).toHaveBeenCalledWith(VIEWER);
  });

  it('sheds with 429 + Retry-After and does not reach the read', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect(res._status()).toBe(429);
    expect(res._headers()['Retry-After']).toBe('9');
    expect(mockAssertEnabled).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('charges the limiter on the token’s blockInstanceId', async () => {
    queryRaw.mockResolvedValue([]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect(mockRateLimit).toHaveBeenCalledWith('bki');
  });
});

describe('GET /api/v1/blocks/gated-images — the owner ratingPending branch', () => {
  it('shows an AUTHOR their own not-yet-rated image, with no rating claim', async () => {
    queryRaw.mockResolvedValue([row(1, { userId: VIEWER, nsfwLevel: 0 })]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect((res._json() as any).images).toEqual([
      {
        imageId: 1,
        status: 'visible',
        ratingPending: true,
        url: 'edge:key-1@1200',
        width: 512,
        height: 512,
      },
    ]);
  });

  it('gives every OTHER viewer `hidden` for that same unrated image', async () => {
    // 🔴 The non-disclosure the `hidden` discriminator depends on. If an unrated
    // image reported a status of its own, the remaining `hidden` cells would
    // positively assert "a rating exists and it is above your ceiling" — and a
    // SFW viewer could enumerate which cells of someone else's grid are
    // mature-or-flagged. Collapsed into `hidden`, they cannot.
    queryRaw.mockResolvedValue([row(1, { userId: AUTHOR, nsfwLevel: 0 })]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect((res._json() as any).images).toEqual([{ imageId: 1, status: 'hidden' }]);
  });

  it('does NOT let the owner branch bypass the ceiling for a RATED image', async () => {
    // The author's own image, rated above their own token's ceiling, is still
    // hidden — the owner affordance is "no rating exists yet", never "you own it".
    queryRaw.mockResolvedValue([row(1, { userId: VIEWER, nsfwLevel: MATURE_LEVEL })]);

    const { req, res } = createMocks({ query: { ids: '1' } });
    await (baseHandler as any)(req, res);

    expect((res._json() as any).images).toEqual([{ imageId: 1, status: 'hidden' }]);
  });
});
