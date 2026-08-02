import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module under test imports the (very large) image service, the db client and the s3
// helpers only to build its production deps. The behaviour under test is injected, so stub
// those graphs out entirely rather than dragging them into the suite.
const {
  dbWriteMock,
  createImageMock,
  checkFileExistsMock,
  getImageUploadBackendMock,
  logToAxiomMock,
} = vi.hoisted(() => ({
  dbWriteMock: { image: { findMany: vi.fn() } },
  createImageMock: vi.fn(),
  checkFileExistsMock: vi.fn(),
  getImageUploadBackendMock: vi.fn(),
  logToAxiomMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({ dbWrite: dbWriteMock, dbRead: dbWriteMock }));
vi.mock('~/server/services/image.service', () => ({ createImage: createImageMock }));
vi.mock('~/utils/s3-utils', () => ({
  checkFileExists: checkFileExistsMock,
  getImageUploadBackend: getImageUploadBackendMock,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: logToAxiomMock,
  safeError: (e: unknown) => ({ message: (e as Error)?.message }),
}));

import type { CoverImageDeps, ReusableCoverImageCandidate } from '../cover-image.service';
import {
  COVER_IMAGE_EXISTS_TIMEOUT_MS,
  COVER_IMAGE_EXISTS_UNKNOWN_LOG,
  COVER_IMAGE_UNAVAILABLE_MESSAGE,
  isReusableCoverImage,
  productionCoverImageDeps,
  resolveCoverImageId,
} from '../cover-image.service';

const coverImage = { url: '0d5f0a4e-0000-4000-8000-000000000001', name: 'cover.png' } as any;

function makeDeps(overrides: Partial<CoverImageDeps> = {}): CoverImageDeps {
  return {
    findReusableImageId: vi.fn().mockResolvedValue(null),
    objectExists: vi.fn().mockResolvedValue(true),
    createImage: vi.fn().mockResolvedValue({ id: 999 }),
    logExistenceUnknown: vi.fn(),
    ...overrides,
  };
}

const unattached: ReusableCoverImageCandidate = {
  id: 10,
  postId: null,
  article: null,
  _count: { connections: 0, challengesCover: 0, challengeEventCovers: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCoverImageId — the client supplied an id (the hot path)', () => {
  it('returns the id without a url lookup or a bucket round-trip', async () => {
    const deps = makeDeps();

    const result = await resolveCoverImageId(
      { coverImage: { ...coverImage, id: 42 }, userId: 7 },
      deps
    );

    expect(result).toBe(42);
    // 🔴 This is the whole point of keeping the check off the hot path: an id-carrying cover
    // must not pay for a db probe or a HeadObject.
    expect(deps.findReusableImageId).not.toHaveBeenCalled();
    expect(deps.objectExists).not.toHaveBeenCalled();
    expect(deps.createImage).not.toHaveBeenCalled();
  });

  it("runs the call site's own ownership rule and propagates its rejection", async () => {
    const deps = makeDeps();
    const assertOwnership = vi.fn().mockRejectedValue(new Error('Invalid cover image'));

    await expect(
      resolveCoverImageId(
        { coverImage: { ...coverImage, id: 42 }, userId: 7, assertOwnership },
        deps
      )
    ).rejects.toThrow('Invalid cover image');

    expect(assertOwnership).toHaveBeenCalledWith(42);
    expect(deps.createImage).not.toHaveBeenCalled();
  });
});

describe('resolveCoverImageId — no id (a raw upload key)', () => {
  it('reuses an existing row for the same url instead of minting a duplicate', async () => {
    const deps = makeDeps({ findReusableImageId: vi.fn().mockResolvedValue(1234) });

    const result = await resolveCoverImageId({ coverImage, userId: 7, currentCoverId: 1234 }, deps);

    expect(result).toBe(1234);
    expect(deps.findReusableImageId).toHaveBeenCalledWith({
      url: coverImage.url,
      userId: 7,
      currentCoverId: 1234,
    });
    // Reuse short-circuits: no bucket call, no insert.
    expect(deps.objectExists).not.toHaveBeenCalled();
    expect(deps.createImage).not.toHaveBeenCalled();
  });

  it('rejects with an actionable error when the object is definitively gone', async () => {
    const deps = makeDeps({ objectExists: vi.fn().mockResolvedValue(false) });

    const error = await resolveCoverImageId({ coverImage, userId: 7 }, deps).catch((e) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(COVER_IMAGE_UNAVAILABLE_MESSAGE);
    // The row that would have 404'd for every reader is never created.
    expect(deps.createImage).not.toHaveBeenCalled();
  });

  it('creates the row when the object is present, dropping the absent id from the payload', async () => {
    const deps = makeDeps();

    // An explicit `id: undefined` is what an optional zod field yields on a real form payload;
    // it must not survive into the insert as a present-but-undefined key.
    const result = await resolveCoverImageId(
      { coverImage: { ...coverImage, id: undefined }, userId: 7 },
      deps
    );

    expect(result).toBe(999);
    expect(deps.createImage).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(deps.createImage).mock.calls[0][0];
    expect(payload).toMatchObject({ url: coverImage.url, userId: 7 });
    expect(payload).not.toHaveProperty('id');
  });

  it('fails OPEN when the bucket could not be consulted at all', async () => {
    // `null` is "we do not know" (no credentials, 403 from a rotated key, network blip).
    // Treating it as absent would turn an infrastructure hiccup into a user-facing rejection.
    const deps = makeDeps({ objectExists: vi.fn().mockResolvedValue(null) });

    await expect(resolveCoverImageId({ coverImage, userId: 7 }, deps)).resolves.toBe(999);
    expect(deps.createImage).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCoverImageId — the fail-open branch is observable', () => {
  // 🔴 Failing open is correct, but it is SILENT: while it is happening the guard is off, and
  // "no bad drafts found" is indistinguishable from "the check never ran". These pin the signal
  // that tells those apart.
  it('reports the indeterminate check when it proceeds unverified', async () => {
    const deps = makeDeps({ objectExists: vi.fn().mockResolvedValue(null) });

    await expect(resolveCoverImageId({ coverImage, userId: 7 }, deps)).resolves.toBe(999);

    expect(deps.logExistenceUnknown).toHaveBeenCalledTimes(1);
    expect(deps.logExistenceUnknown).toHaveBeenCalledWith({ userId: 7 });
  });

  it('stays quiet when the object was definitively present', async () => {
    const deps = makeDeps({ objectExists: vi.fn().mockResolvedValue(true) });

    await resolveCoverImageId({ coverImage, userId: 7 }, deps);

    expect(deps.logExistenceUnknown).not.toHaveBeenCalled();
  });

  it('stays quiet when the object was definitively absent', async () => {
    const deps = makeDeps({ objectExists: vi.fn().mockResolvedValue(false) });

    await resolveCoverImageId({ coverImage, userId: 7 }, deps).catch(() => undefined);

    // A rejection is a decision the user sees; it is not the silent no-op this signal counts.
    expect(deps.logExistenceUnknown).not.toHaveBeenCalled();
  });

  it('stays quiet on the hot path and on reuse — neither consults the bucket', async () => {
    const idDeps = makeDeps();
    await resolveCoverImageId({ coverImage: { ...coverImage, id: 42 }, userId: 7 }, idDeps);
    expect(idDeps.logExistenceUnknown).not.toHaveBeenCalled();

    const reuseDeps = makeDeps({ findReusableImageId: vi.fn().mockResolvedValue(1234) });
    await resolveCoverImageId({ coverImage, userId: 7 }, reuseDeps);
    expect(reuseDeps.logExistenceUnknown).not.toHaveBeenCalled();
  });
});

describe('isReusableCoverImage', () => {
  it('accepts a row attached to nothing', () => {
    expect(isReusableCoverImage(unattached)).toBe(true);
  });

  it("accepts the entity's own current cover even though it is attached", () => {
    const ownCover = { ...unattached, article: { id: 5 } };
    expect(isReusableCoverImage(ownCover, unattached.id)).toBe(true);
  });

  it.each([
    ['already covers another article', { article: { id: 5 } }],
    ['belongs to a post', { postId: 3 }],
    ['has image connections', { _count: { ...unattached._count, connections: 1 } }],
    ['covers a challenge', { _count: { ...unattached._count, challengesCover: 1 } }],
    ['covers a challenge event', { _count: { ...unattached._count, challengeEventCovers: 1 } }],
  ])('refuses a row that %s', (_label, overrides) => {
    // Sharing one row across entities is not safe: `Article.coverId` is UNIQUE, and deleting
    // an entity deletes its cover row — which would break whatever else pointed at it.
    expect(isReusableCoverImage({ ...unattached, ...(overrides as object) }, 4321)).toBe(false);
  });
});

describe('productionCoverImageDeps.findReusableImageId', () => {
  it('scopes the url lookup to the caller and applies the reuse predicate', async () => {
    dbWriteMock.image.findMany.mockResolvedValue([
      { ...unattached, id: 20, article: { id: 5 } }, // attached elsewhere -> skipped
      { ...unattached, id: 10 },
    ]);

    const result = await productionCoverImageDeps.findReusableImageId({
      url: coverImage.url,
      userId: 7,
    });

    expect(result).toBe(10);
    // 🔴 `Image.url` is the bare object key and is visible in public image URLs. An unscoped
    // lookup would let anyone attach someone else's image by reading a key off the site.
    expect(dbWriteMock.image.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { url: coverImage.url, userId: 7 } })
    );
  });

  it('returns null when every row for the url is attached elsewhere', async () => {
    dbWriteMock.image.findMany.mockResolvedValue([{ ...unattached, id: 20, postId: 3 }]);

    await expect(
      productionCoverImageDeps.findReusableImageId({ url: coverImage.url, userId: 7 })
    ).resolves.toBeNull();
  });
});

describe('productionCoverImageDeps.objectExists', () => {
  it('reports unknown (null) rather than absent when the uploads client cannot be built', async () => {
    getImageUploadBackendMock.mockRejectedValue(
      new Error('B2 image upload credentials not configured')
    );

    await expect(productionCoverImageDeps.objectExists(coverImage.url)).resolves.toBeNull();
    expect(checkFileExistsMock).not.toHaveBeenCalled();
  });

  it('reports the indeterminate check when the uploads client cannot be built', async () => {
    getImageUploadBackendMock.mockRejectedValue(
      new Error('B2 image upload credentials not configured')
    );

    await productionCoverImageDeps.objectExists(coverImage.url);

    expect(logToAxiomMock).toHaveBeenCalledTimes(1);
    expect(logToAxiomMock.mock.calls[0][0]).toMatchObject({
      name: COVER_IMAGE_EXISTS_UNKNOWN_LOG,
      reason: 'client-unavailable',
    });
  });

  it('probes the uploads bucket the app actually writes to', async () => {
    const s3 = { send: vi.fn() };
    getImageUploadBackendMock.mockResolvedValue({ s3, bucket: 'civitai-media-uploads' });
    checkFileExistsMock.mockResolvedValue(false);

    await expect(productionCoverImageDeps.objectExists(coverImage.url)).resolves.toBe(false);
    expect(checkFileExistsMock).toHaveBeenCalledWith(
      coverImage.url,
      expect.objectContaining({ s3, bucket: 'civitai-media-uploads' })
    );
  });

  it('bounds the probe with an abort signal — this runs on the user-facing save path', async () => {
    // 🔴 The uploads client has SDK-default retries and no request timeout, so without a bound
    // a degraded backend turns this guard into an unbounded wait on someone's save. The signal
    // is created once and shared by every retry attempt, so it bounds every network attempt —
    // it is not a wall-clock cap: an in-flight retry backoff is not interrupted, so worst-case
    // wall time is the budget plus one backoff (see the note on `checkFileExists`).
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const s3 = { send: vi.fn() };
      getImageUploadBackendMock.mockResolvedValue({ s3, bucket: 'civitai-media-uploads' });
      checkFileExistsMock.mockResolvedValue(true);

      await productionCoverImageDeps.objectExists(coverImage.url);

      const options = checkFileExistsMock.mock.calls[0][1];
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options.abortSignal.aborted).toBe(false);
      expect(timeoutSpy).toHaveBeenCalledWith(COVER_IMAGE_EXISTS_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('keeps the budget small enough to sit on a user-facing save path', () => {
    // 🔴 Deliberately a CEILING, not `toBe(2000)`. Re-stating the constant would be a
    // change-detector — it can only fail when someone edits the value on purpose, and the fix is
    // to edit the test. What actually needs defending is the invariant the design argument rests
    // on: this is a synchronous cost added to somebody's save, and worst-case wall time is this
    // budget plus one un-interruptible retry backoff. Retuning 2000 → 1500 or 3000 is a normal
    // decision and stays green; widening it to something that would visibly stall a save (the
    // failure mode this bound exists to prevent) does not.
    expect(COVER_IMAGE_EXISTS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(COVER_IMAGE_EXISTS_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe('productionCoverImageDeps.logExistenceUnknown', () => {
  it('emits a structured warning naming the branch, and never throws', () => {
    expect(() => productionCoverImageDeps.logExistenceUnknown({ userId: 7 })).not.toThrow();

    expect(logToAxiomMock).toHaveBeenCalledTimes(1);
    expect(logToAxiomMock.mock.calls[0][0]).toMatchObject({
      type: 'warning',
      name: COVER_IMAGE_EXISTS_UNKNOWN_LOG,
      reason: 'proceeded-unverified',
      userId: 7,
    });
    // The object key is deliberately NOT logged — the decision is what needs counting.
    expect(logToAxiomMock.mock.calls[0][0]).not.toHaveProperty('url');
  });

  // The `.catch()` on that `logToAxiom(...)` — the thing that stops a logging failure surfacing
  // as an unhandled rejection — is pinned in `cover-image.service.logging.test.ts`, NOT here.
  //
  // 🔴 The reason is a trap worth knowing: it cannot be tested through THIS file's mocks. The
  // only observable difference between having and not having the `.catch()` is whether Node
  // emits `unhandledRejection`, and a `vi.fn()` mock suppresses that by construction — it
  // attaches `returnValue.then(onFulfilled, onRejected)` to whatever the implementation returns
  // (that is how `mock.settledResults` is populated), which marks a returned rejected promise
  // handled. Measured both ways: with `logToAxiom` mocked as a `vi.fn()`, an assertion that no
  // `unhandledRejection` fires passes whether or not the production `.catch()` exists —
  // unfalsifiable, which is worse than no test. Mocked as a PLAIN function returning a rejected
  // promise, the same assertion fails the moment the `.catch()` is deleted. Since this file's
  // other tests need `logToAxiom` to be a `vi.fn()` to assert on payloads, and `vi.mock` is
  // per-file, the falsifiable version lives in its own file.
});
