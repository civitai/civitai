import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_PUBLISH_MESSAGE, UNRENDERABLE_MEDIA_PUBLISH_MESSAGE } from '@civitai/shared';
import type * as S3Utils from '~/utils/s3-utils';
import type * as Shared from '@civitai/shared';

/**
 * The main-app half of the missing-media publish guard.
 *
 * `resolveIngestionError` here is the copy the article-image-scan flow reuses, and it published an
 * image — `ingestion = 'Scanned'` plus a locked nsfwLevel — without ever asking whether the media
 * exists. The spoke's copy is guarded in its own suite; this one proves the same rule runs in this
 * runtime, and that it runs THROUGH the shared module rather than a second local copy of it.
 */

const { headObject, getB2ImageS3Client, assertSpy } = vi.hoisted(() => ({
  headObject: vi.fn(),
  getB2ImageS3Client: vi.fn(() => ({} as never)),
  assertSpy: vi.fn(),
}));

// Narrow overrides on a spread of the real module — s3-utils exports a great many things this
// service uses, and a one-key factory would take the whole file out at collection.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  headObject,
  getB2ImageS3Client,
}));

/**
 * The wiring probe. `assertMediaPresentForPublish` still runs for real — this only records that the
 * service reached the SHARED implementation. A shared function nobody calls is worse than none, and
 * a local re-implementation would pass every behavioural case below while silently drifting.
 */
vi.mock('@civitai/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return {
    ...actual,
    assertMediaPresentForPublish: (
      ...args: Parameters<typeof actual.assertMediaPresentForPublish>
    ) => {
      assertSpy(...args);
      return actual.assertMediaPresentForPublish(...args);
    },
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
// The CANONICAL logging mock, registered globally in setup.ts. A local `vi.mock` of that module
// would shadow it — and is flagged by the `no-direct-shared-module-mock` lint rule for a reason:
// under `isolate: false` a per-file spy accumulates calls across every file sharing the worker.
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { resolveIngestionError } from '~/server/services/image.service';

const IMAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const resolve = () => resolveIngestionError({ id: 4242, nsfwLevel: 1, userId: 7 });

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` clears CALLS, not IMPLEMENTATIONS. Without this line the throwing client
  // installed by the "cannot even be built" case below leaks into every later test in the file, so
  // the probe fails open and the bucket is never consulted — which silently made the non-key cases
  // at the bottom pass for the wrong reason (they assert the bucket is NOT consulted).
  getB2ImageS3Client.mockImplementation(() => ({} as never));
  // postId null keeps the post-level recompute out of the way; it is not what these cases pin.
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    ingestion: 'Error',
    postId: null,
    userId: 99,
    metadata: {},
    url: IMAGE_KEY,
  } as never);
});

describe('main-app resolveIngestionError — missing-media guard', () => {
  it('REFUSES to publish when the bucket answered that the object is absent', async () => {
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(resolve()).rejects.toThrow(MISSING_MEDIA_PUBLISH_MESSAGE);

    // The write is the harm. Before this guard it ran unconditionally.
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('surfaces the refusal as a BAD_REQUEST, so a moderator sees the message not a 500', async () => {
    headObject.mockResolvedValue({ status: 'absent' });
    await expect(resolve()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('probes the image row url in the uploads bucket, under a bounded signal', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 12345 });

    await resolve();

    expect(headObject).toHaveBeenCalledTimes(1);
    const [bucket, key, , options] = headObject.mock.calls[0];
    expect(bucket).toBe('civitai-media-uploads');
    expect(key).toBe(IMAGE_KEY);
    // An unbounded probe against a degraded backend turns a moderator's click into a hung request.
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('publishes exactly as before when the bucket confirms the object is present', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 12345 });

    await resolve();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    const arg = dbMock.dbWrite.image.update.mock.calls[0][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: 4242 });
    // Literal expectations rather than a re-read of the implementation.
    expect(arg.data).toMatchObject({
      nsfwLevel: 1,
      nsfwLevelLocked: true,
      ingestion: 'Scanned',
    });
  });

  it('publishes when the bucket could not be consulted (probe returned unknown)', async () => {
    headObject.mockResolvedValue({ status: 'unknown' });

    await resolve();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('publishes when the storage CLIENT cannot even be built', async () => {
    // `getB2ImageS3Client()` throws when credentials are absent. That must land on "could not
    // consult", not on a failed publish — a guard that can fail the path by its own absence is
    // worse than no guard. The client is resolved inside the probe for exactly this reason.
    getB2ImageS3Client.mockImplementation(() => {
      throw new Error('B2 image upload credentials not configured');
    });

    await resolve();

    expect(headObject).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('decides through the SHARED module, not a second local copy of the rule', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 1 });
    await resolve();
    expect(assertSpy).toHaveBeenCalledTimes(1);
  });

  it('still refuses before the probe when there is no such image', async () => {
    // Reachability control: the not-found check runs FIRST, so a fixture without a row would test
    // that check instead of this guard.
    dbMock.dbRead.image.findUnique.mockResolvedValue(null as never);
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(resolve()).rejects.toThrow('Image not found');
    expect(headObject).not.toHaveBeenCalled();
  });
});

describe('a non-key Image.url is never treated as a missing object', () => {
  /**
   * The regression an earlier revision of this guard shipped: it assumed every `Image.url` is a
   * bucket key. Profile pictures may hold a whitelisted external avatar CDN url verbatim, and that
   * row is created and ingested like any other, so it reaches the review queue with a current
   * timestamp. Handing it to the bucket as a Key 404s → `absent` → the moderator could never
   * publish an image that renders perfectly well, with no override.
   *
   * The bucket must not even be CONSULTED for these, which is what `headObject` not being called
   * pins — asserting only "it published" would still pass if the probe ran and got lucky.
   */
  it.each([
    ['an external avatar CDN url', 'https://cdn.discordapp.com/avatars/123/abc.png'],
    ['a bare filename the comics router can write', 'some-file.png'],
    ['a prefixed key shape no upload endpoint issues', 'foo/0f8fad5b-d9cb-469f-a165-70867728950e'],
  ])('publishes without probing the bucket for %s', async (_label, url) => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ingestion: 'Error',
      postId: null,
      userId: 99,
      metadata: {},
      url,
    } as never);
    // Armed to answer `absent` — so if the probe DID run, the publish would be refused.
    headObject.mockResolvedValue({ status: 'absent' });

    await resolve();

    expect(headObject).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('REFUSES a legacy blob: handle, without probing the bucket', async () => {
    /**
     * 🔴 This case used to assert the opposite. `getEdgeUrl` returns a `blob:` src VERBATIM
     * (`src/client-utils/cf-images-utils.ts`), so publishing one emits `<img src="blob:...">` into a
     * browser that never created the handle — a permanently broken image. The bucket is armed
     * PRESENT here, so the refusal demonstrably comes from the url and not from the store.
     */
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ingestion: 'Error',
      postId: null,
      userId: 99,
      metadata: {},
      url: 'blob:https://civitai.com/9f8e-1234',
    } as never);
    headObject.mockResolvedValue({ status: 'present', size: 1 });

    await expect(resolve()).rejects.toThrow(UNRENDERABLE_MEDIA_PUBLISH_MESSAGE);

    expect(headObject).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });
});

describe('the guard reports what it did, in both directions', () => {
  /**
   * Both hooks survived a revert until these existed. They are the only signal distinguishing a
   * healthy run from two silent failure modes that look identical to it:
   *   - fail-OPEN: credentials rotate, every probe is `unknown`, every publish is allowed;
   *   - fail-CLOSED: a wrong bucket name 404s for every key, every publish is refused.
   */
  const eventsNamed = (name: string) =>
    loggingMock.logToAxiom.mock.calls.filter(
      (c: unknown[]) => (c[0] as { name?: string } | undefined)?.name === name
    );

  it('logs a refusal when the bucket answered absent, naming WHICH refusal', async () => {
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(resolve()).rejects.toThrow();

    const events = eventsNamed('resolveIngestionError:media-absent-refused');
    expect(events).toHaveLength(1);
    // `presence` is what separates a fail-CLOSED bucket misconfiguration (which can only ever
    // produce `absent`) from the url-shape refusal (which no bucket state can produce).
    expect(events[0][0]).toMatchObject({ type: 'warning', imageId: 4242, presence: 'absent' });
  });

  it('logs the url-shape refusal under its own presence value', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ingestion: 'Error',
      postId: null,
      userId: 99,
      metadata: {},
      url: 'blob:https://civitai.com/9f8e-1234',
    } as never);

    await expect(resolve()).rejects.toThrow();

    const events = eventsNamed('resolveIngestionError:media-absent-refused');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toMatchObject({ presence: 'unrenderable' });
  });

  it('logs an inconclusive probe with the reason the store could not answer', async () => {
    // 🔴 `headObject` RESOLVES `{ status: 'unknown' }` rather than throwing, so without a reason
    // this line is byte-identical to the one a client that cannot be BUILT produces — and the
    // `error` field is empty in both. That is the indistinguishability the log exists to remove.
    headObject.mockResolvedValue({ status: 'unknown' });

    await resolve();

    const events = eventsNamed('resolveIngestionError:media-probe-unknown');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toMatchObject({ reason: 'store-inconclusive', error: '' });
  });

  it('distinguishes a probe that THREW from a store that declined to answer', async () => {
    getB2ImageS3Client.mockImplementation(() => {
      throw new Error('B2 image upload credentials not configured');
    });

    await resolve();

    const events = eventsNamed('resolveIngestionError:media-probe-unknown');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toMatchObject({
      reason: 'probe-threw',
      error: 'B2 image upload credentials not configured',
    });
  });

  it('bounds the probe error it logs, so a remote response body cannot flood the pipeline', async () => {
    getB2ImageS3Client.mockImplementation(() => {
      throw new Error(`storage request failed (503) ${'x'.repeat(10_000)}`);
    });

    await resolve();

    const payload = eventsNamed('resolveIngestionError:media-probe-unknown')[0][0] as {
      error: string;
    };
    expect(payload.error.length).toBeLessThan(300);
    expect(payload.error.endsWith('…[truncated]')).toBe(true);
  });

  it('does NOT log an inconclusive probe for a url that was never a key', async () => {
    /**
     * 🔴 The finding this fixes. The not-a-key short-circuit used to return `unknown`, so every
     * profile-picture url in the queue emitted the same "could not consult the bucket" warning as a
     * genuine store outage — with an identical empty `error`. The one number this channel exists to
     * produce could not answer its own question.
     */
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ingestion: 'Error',
      postId: null,
      userId: 99,
      metadata: {},
      url: 'https://cdn.discordapp.com/avatars/123/abc.png',
    } as never);
    headObject.mockResolvedValue({ status: 'absent' });

    await resolve();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    expect(eventsNamed('resolveIngestionError:media-probe-unknown')).toHaveLength(0);
    expect(eventsNamed('resolveIngestionError:media-absent-refused')).toHaveLength(0);
  });

  it('logs neither when the media is present', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 1 });

    await resolve();

    expect(eventsNamed('resolveIngestionError:media-absent-refused')).toHaveLength(0);
    expect(eventsNamed('resolveIngestionError:media-probe-unknown')).toHaveLength(0);
  });
});
