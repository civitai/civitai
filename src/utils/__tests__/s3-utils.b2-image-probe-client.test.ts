import { describe, expect, it, vi } from 'vitest';

/**
 * The read-only probe client's bound, and the proof that buying it cost the shared upload
 * client nothing.
 *
 * 🔴 WHY THIS FILE EXISTS. `probeCreatedImageMedia` runs inline on `createImage`, a
 * user-facing mutation, and two `comics.router.ts` procedures call it in bounded loops. Its
 * `AbortSignal` bounds each network ATTEMPT, but the SDK's between-attempt sleep is not
 * abort-aware — so with SDK-default retries a degraded store could hold each call for the
 * budget plus a full backoff. The fix is a retry-free client for the probe ALONE.
 *
 * "Alone" is the load-bearing word and the reason for the negative control below: the
 * obvious fix — putting `maxAttempts` on `getB2ImageS3Client` — would have reached the live
 * upload-completion and abort endpoints, the announcement media check and the server-side
 * upload path, all of which want their retries. A test that only asserted "the probe client
 * has maxAttempts 1" would pass just as happily if the shared client had been changed too.
 */

// Concrete B2 image credentials so both factories can construct. Anything not overridden
// falls through to the global env mock in `src/__tests__/setup.ts`.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      S3_IMAGE_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      S3_IMAGE_B2_ACCESS_KEY: 'image-b2-key',
      S3_IMAGE_B2_SECRET_KEY: 'image-b2-secret',
      S3_IMAGE_B2_BUCKET: 'civitai-media-uploads-test',
      S3_IMAGE_B2_REGION: 'us-west-004',
      S3_UPLOAD_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
      S3_UPLOAD_BUCKET: 'civitai-modelfiles',
      S3_UPLOAD_KEY: 'test-key',
      S3_UPLOAD_SECRET: 'test-secret',
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return undefined;
      },
    }
  ),
}));

import {
  B2_IMAGE_PROBE_MAX_ATTEMPTS,
  getB2ImageProbeS3Client,
  getB2ImageS3Client,
  getImageUploadBackend,
  getImageUploadProbeBackend,
} from '~/utils/s3-utils';

/** `maxAttempts` is normalised to a provider by the SDK's config resolver. */
async function attemptsOf(client: { config: { maxAttempts: unknown } }) {
  const value = client.config.maxAttempts;
  return typeof value === 'function' ? await (value as () => Promise<number>)() : value;
}

describe('the B2 image PROBE client is retry-free', () => {
  it('attempts a request exactly once', async () => {
    // The whole bound. One attempt means there is no between-attempt sleep for a
    // non-abort-aware timer to sit in, so the abort budget IS the call's budget.
    await expect(attemptsOf(getB2ImageProbeS3Client())).resolves.toBe(1);
    expect(B2_IMAGE_PROBE_MAX_ATTEMPTS).toBe(1);
  });

  it('is memoised — one client, not one per probe', async () => {
    // `createImage` is a hot path; constructing a client per call would trade a retry
    // problem for an allocation one.
    expect(getB2ImageProbeS3Client()).toBe(getB2ImageProbeS3Client());
  });
});

describe('the SHARED B2 image client is untouched by that', () => {
  it('still retries — this is the negative control for the assertion above', async () => {
    /**
     * 🔴 If this ever reads 1, someone bounded the probe by taking retries away from
     * `src/pages/api/upload/complete.ts`, `src/pages/api/upload/abort.ts`,
     * `src/server/jobs/announcement-media-check.ts` and the server-side upload/delete
     * paths, where a transient 5xx losing a retry loses a user's bytes. It is also what
     * makes the probe assertion non-vacuous: without it, "the probe client has 1 attempt"
     * would pass in a world where EVERY client has 1 attempt.
     */
    const shared = await attemptsOf(getB2ImageS3Client());
    expect(shared).toBeGreaterThan(1);
  });

  it('is a DIFFERENT client instance from the probe one', () => {
    expect(getB2ImageProbeS3Client()).not.toBe(getB2ImageS3Client());
  });
});

describe('the probe backend resolves the same store as the upload backend', () => {
  it('hands back the probe client and the upload bucket', async () => {
    /**
     * 🔴 `Image.url` is the key the UPLOAD path minted, so the only store that can answer
     * about it is the one that path writes to. A probe that bounded itself by open-coding
     * its own bucket would answer 404 for every key the moment uploads moved — a
     * fleet-wide false defect rate, arrived at while every test stayed green.
     */
    const upload = await getImageUploadBackend();
    const probe = await getImageUploadProbeBackend();

    expect(probe.bucket).toBe(upload.bucket);
    expect(probe.backend).toBe(upload.backend);
    expect(probe.s3).toBe(getB2ImageProbeS3Client());
    expect(probe.s3).not.toBe(upload.s3);
  });

  it('points both clients at the same endpoint and region', async () => {
    // The two clients must differ in `maxAttempts` and in NOTHING else — any other drift
    // means the probe is asking a different store than the key was minted into.
    const probe = getB2ImageProbeS3Client();
    const shared = getB2ImageS3Client();

    const endpointOf = async (c: { config: { endpoint?: unknown } }) => {
      const e = c.config.endpoint;
      return typeof e === 'function' ? await (e as () => Promise<unknown>)() : e;
    };
    const regionOf = async (c: { config: { region: unknown } }) => {
      const r = c.config.region;
      return typeof r === 'function' ? await (r as () => Promise<string>)() : r;
    };

    expect(await regionOf(probe)).toEqual(await regionOf(shared));
    expect(await endpointOf(probe)).toEqual(await endpointOf(shared));
  });
});
