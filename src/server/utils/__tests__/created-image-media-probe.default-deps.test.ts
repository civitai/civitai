import { describe, expect, it, vi } from 'vitest';

/**
 * The SEAM between the probe and the bounded client.
 *
 * 🔴 EVERY OTHER TEST OF THIS MODULE INJECTS `deps`, so none of them can see which backend
 * production resolves. That is the gap this file closes: switch the import in
 * `created-image-media-probe.ts` back to `getImageUploadBackend` and the probe would run on
 * the SHARED, retrying client again — an unbounded probe on a user-facing mutation — while
 * `created-image-media-probe.test.ts` stayed entirely green, because it never exercises the
 * default deps at all. The bound would be documented, tested in isolation, and not in
 * effect.
 *
 * Two claims, and they are separate: that the probe asks for the PROBE backend, and that it
 * does not ask for the shared one. The second is what fails if someone "helpfully" resolves
 * both.
 */

const { getImageUploadProbeBackend, getImageUploadBackend, headObject } = vi.hoisted(() => ({
  getImageUploadProbeBackend: vi.fn(async () => ({
    s3: { marker: 'probe-client' } as never,
    bucket: 'probe-backend-bucket',
    backend: 'backblaze' as const,
  })),
  getImageUploadBackend: vi.fn(async () => ({
    s3: { marker: 'shared-client' } as never,
    bucket: 'shared-backend-bucket',
    backend: 'backblaze' as const,
  })),
  headObject: vi.fn(async () => ({ status: 'present' as const, size: 128 })),
}));

vi.mock('~/utils/s3-utils', () => ({
  getImageUploadProbeBackend,
  getImageUploadBackend,
  headObject,
}));

import { probeCreatedImageMedia } from '~/server/utils/created-image-media-probe';

/** Distinct from every other literal here, so nothing can pass by coincidence. */
const KEY = 'b7d4e0a2-31c5-4f68-9a03-5c8ef1276b4d';

describe('probeCreatedImageMedia default deps', () => {
  it('resolves the RETRY-FREE probe backend, and only that one', async () => {
    await expect(probeCreatedImageMedia(KEY)).resolves.toBe('present');

    expect(getImageUploadProbeBackend).toHaveBeenCalledTimes(1);
    // 🔴 The half that catches a revert: the shared upload client keeps SDK-default
    // retries on purpose, and a probe running on it is exactly the unbounded shape this
    // change exists to remove.
    expect(getImageUploadBackend).not.toHaveBeenCalled();
  });

  it('heads the probe backend’s bucket with the probe backend’s client', async () => {
    await probeCreatedImageMedia(KEY);

    const [bucket, key, s3] = headObject.mock.calls.at(-1) as unknown as [string, string, unknown];
    expect(bucket).toBe('probe-backend-bucket');
    expect(key).toBe(KEY);
    expect(s3).toEqual({ marker: 'probe-client' });
  });
});
