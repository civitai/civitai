import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectHeadResult } from '~/utils/s3-utils';
import {
  CREATED_IMAGE_MEDIA_PROBE_DEADLINE_MS,
  CREATED_IMAGE_MEDIA_PROBE_TIMEOUT_MS,
  isProbeableMediaKey,
  probeCreatedImageMedia,
  type CreatedImageMediaProbeDeps,
} from '~/server/utils/created-image-media-probe';

/**
 * A uuid that is NOT any constant this file asserts against, so a mutant that hardcodes a
 * key cannot pass by coincidence.
 */
const KEY = '9c1f8a3e-4b2d-4c77-b0a1-6e5d2f7a91cc';

/**
 * Deps that answer with a fixed head result and record what they were asked.
 *
 * The bucket name is deliberately not the production one: `getImageUploadBackend` is the
 * seam under test, so an assertion that the probe passes ITS bucket through has to be able
 * to fail when the probe substitutes a literal.
 */
function deps(head: ObjectHeadResult | (() => Promise<ObjectHeadResult>)) {
  const headObject = vi.fn(async () => (typeof head === 'function' ? head() : head));
  const getBackend = vi.fn(async () => ({ s3: { marker: 's3' } as never, bucket: 'probe-bucket' }));
  return {
    getBackend,
    headObject,
  } as unknown as CreatedImageMediaProbeDeps & {
    getBackend: ReturnType<typeof vi.fn>;
    headObject: ReturnType<typeof vi.fn>;
  };
}

describe('isProbeableMediaKey', () => {
  it('accepts the bare uuid shape our upload endpoints mint', () => {
    expect(isProbeableMediaKey(KEY)).toBe(true);
    expect(isProbeableMediaKey('9C1F8A3E-4B2D-4C77-B0A1-6E5D2F7A91CC')).toBe(true);
  });

  it.each([
    ['a filename', 'photo.jpg'],
    ['a prefixed key', `uploads/${KEY}`],
    ['a trailing extension', `${KEY}.png`],
    ['an http url', `https://example.test/${KEY}`],
    ['a blob url', 'blob:https://example.test/abc'],
    ['a data url', 'data:image/png;base64,AAAA'],
    ['a bare number', '12345'],
    ['the empty string', ''],
  ])('declines %s', (_label, url) => {
    expect(isProbeableMediaKey(url)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [[KEY]]])('declines the non-string %s', (url) => {
    expect(isProbeableMediaKey(url)).toBe(false);
  });
});

describe('probeCreatedImageMedia', () => {
  it('returns not-applicable and never touches the store for a non-key url', async () => {
    const d = deps({ status: 'absent' });

    await expect(probeCreatedImageMedia('photo.jpg', d)).resolves.toBe('not-applicable');

    // 🔴 The point of the predicate: an arbitrary caller-supplied string must not produce a
    // 404 that is then counted as a defect. If the probe asked anyway, this fails.
    expect(d.getBackend).not.toHaveBeenCalled();
    expect(d.headObject).not.toHaveBeenCalled();
  });

  it('returns present when the store reports the object with bytes', async () => {
    await expect(
      probeCreatedImageMedia(KEY, deps({ status: 'present', size: 4096 }))
    ).resolves.toBe('present');
  });

  it('returns present when the store reports no length at all', async () => {
    // 🔴 `size: null` is "the backend reported no length", NOT "size zero". Reading it as
    // zero would report every length-less backend response as a missing-media defect.
    await expect(
      probeCreatedImageMedia(KEY, deps({ status: 'present', size: null }))
    ).resolves.toBe('present');
  });

  it('returns absent when the store answers that the key is not there', async () => {
    await expect(probeCreatedImageMedia(KEY, deps({ status: 'absent' }))).resolves.toBe('absent');
  });

  it('returns absent for a zero-length object', async () => {
    // The shape the production sample actually showed: a signed key whose object landed
    // with no bytes. Present-but-empty cannot render, so it is the same defect.
    await expect(probeCreatedImageMedia(KEY, deps({ status: 'present', size: 0 }))).resolves.toBe(
      'absent'
    );
  });

  it('returns unknown when the store could not be consulted', async () => {
    await expect(probeCreatedImageMedia(KEY, deps({ status: 'unknown' }))).resolves.toBe('unknown');
  });

  it('returns unknown, not absent, when the backend cannot be resolved', async () => {
    // 🔴 An unconfigured or credential-less environment must fail OPEN. Collapsing this
    // into `absent` would make every such deploy read as a fleet-wide defect spike.
    const d = deps({ status: 'present', size: 1 });
    d.getBackend = vi.fn(async () => {
      throw new Error('no credentials');
    }) as never;

    await expect(probeCreatedImageMedia(KEY, d)).resolves.toBe('unknown');
  });

  it('returns unknown when the head itself throws', async () => {
    const d = deps(async () => {
      throw new Error('boom');
    });

    await expect(probeCreatedImageMedia(KEY, d)).resolves.toBe('unknown');
  });

  it('asks the resolved backend for the exact key, under an abort signal', async () => {
    const d = deps({ status: 'present', size: 1 });

    await probeCreatedImageMedia(KEY, d);

    expect(d.headObject).toHaveBeenCalledTimes(1);
    const [bucket, key, s3, options] = d.headObject.mock.calls[0];
    expect(bucket).toBe('probe-bucket');
    expect(key).toBe(KEY);
    expect(s3).toEqual({ marker: 's3' });
    // 🔴 An unbounded probe on a user-facing mutation hangs the request rather than
    // failing open. Pin that a signal is passed at all.
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('bounds the probe with a budget under 5s', () => {
    // A literal bound, not a re-read of the constant: a mutant that raises the budget to a
    // value that would outlive a user-facing request has to fail here.
    expect(CREATED_IMAGE_MEDIA_PROBE_TIMEOUT_MS).toBe(2000);
  });

  it('hands the store a signal carrying THAT budget, not merely some signal', async () => {
    /**
     * 🔴 THE CONSTANT AND THE DELIVERED BUDGET ARE TWO DIFFERENT CLAIMS, and the tests
     * above pin only the first two-thirds of them: one asserts the constant is 2000,
     * another asserts that `options.abortSignal instanceof AbortSignal`. Neither can see a
     * probe that declares a 2s budget and then bounds the actual request with something
     * else. Measured: mutating the call to `AbortSignal.timeout(600000)` left all 24 probe
     * tests green — a 10-minute deadline on a user-facing mutation, invisible.
     *
     * So assert the number that reaches `AbortSignal.timeout`, and assert it against a
     * LITERAL rather than re-reading the constant: a mutant that moves the constant AND the
     * call site together still has to fail here, which re-reading the constant could not
     * catch.
     */
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      await probeCreatedImageMedia(KEY, deps({ status: 'present', size: 1 }));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(2000);
      // And the two claims agree — so raising the constant alone is caught by the test
      // above, and raising only the delivered value is caught by the assertion above this.
      expect(spy.mock.calls[0][0]).toBe(CREATED_IMAGE_MEDIA_PROBE_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The WALL-CLOCK bound, which is a different claim from the per-attempt one above.
 *
 * 🔴 Why these exist at all: the per-attempt budget is a request to the SDK, and the SDK's
 * between-attempt sleep is not abort-aware — so before this bound a degraded store could
 * hold a `createImage` call for the budget plus a full backoff, and the two `comics.router`
 * loops multiply that by up to 20. A configured retry count nobody watched take effect is a
 * claim; these watch it.
 */
describe('probeCreatedImageMedia — the wall-clock bound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up with unknown when the store never answers', async () => {
    vi.useFakeTimers();
    // A head that NEVER settles — the shape an unbounded probe cannot survive. Without the
    // deadline race this test hangs until vitest's own timeout kills it.
    const d = deps(() => new Promise<ObjectHeadResult>(() => undefined));

    const verdict = probeCreatedImageMedia(KEY, d);
    await vi.advanceTimersByTimeAsync(CREATED_IMAGE_MEDIA_PROBE_DEADLINE_MS);

    await expect(verdict).resolves.toBe('unknown');
  });

  it('gives up with unknown when resolving the backend never answers', async () => {
    // 🔴 The head is not the only thing that can hang. `getBackend` builds a client and
    // reads config; putting only the head inside the race would leave this uncovered.
    vi.useFakeTimers();
    const d = deps({ status: 'present', size: 1 });
    d.getBackend = vi.fn(() => new Promise(() => undefined)) as never;

    const verdict = probeCreatedImageMedia(KEY, d);
    await vi.advanceTimersByTimeAsync(CREATED_IMAGE_MEDIA_PROBE_DEADLINE_MS);

    await expect(verdict).resolves.toBe('unknown');
  });

  it('does NOT give up before the deadline — a slow-but-answering store still counts', async () => {
    /**
     * The negative control for the two cases above. A deadline that fires early would turn
     * every slow-but-successful probe into `unknown`, which is exactly the reading that
     * makes the `absent` rate unusable: `unknown` is the fail-open bucket, so a probe that
     * quietly moved its own traffic there would report a healthy zero forever.
     */
    vi.useFakeTimers();
    let release!: (r: ObjectHeadResult) => void;
    const d = deps(() => new Promise<ObjectHeadResult>((r) => (release = r)));

    const verdict = probeCreatedImageMedia(KEY, d);
    await vi.advanceTimersByTimeAsync(CREATED_IMAGE_MEDIA_PROBE_DEADLINE_MS - 1);
    release({ status: 'present', size: 7 });

    await expect(verdict).resolves.toBe('present');
  });

  it('bounds one call at 3s, above the per-attempt budget and below any request timeout', () => {
    // Literals, not a re-read of the constants: a mutant that moves the deadline has to
    // fail here even if it moves the constant's declaration with it.
    expect(CREATED_IMAGE_MEDIA_PROBE_DEADLINE_MS).toBe(3000);
    // 🔴 The ORDER is the load-bearing part. Equal budgets would let the deadline win the
    // race on the ordinary abort path, hiding a broken abort behind a passing test.
    expect(CREATED_IMAGE_MEDIA_PROBE_DEADLINE_MS).toBeGreaterThan(
      CREATED_IMAGE_MEDIA_PROBE_TIMEOUT_MS
    );
  });
});
