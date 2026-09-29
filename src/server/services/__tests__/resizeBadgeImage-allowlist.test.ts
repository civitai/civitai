import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `resizeBadgeImage` URL allowlist (product-badge.service).
 *
 * Third of the funnels that hand the orchestrator a caller-supplied media URL. Its router
 * rung is `moderatorProcedure`, so it is the NARROWEST of them — gated anyway, because "only
 * moderators can reach it" is a fact about the current router, not a property of this
 * exported function.
 *
 * 🔴 It THROWS rather than passing the url through. Returning it unchanged would hand an
 * un-resized, unvalidated url straight into `upsertProductBadge`'s cosmetic `data.url`, which
 * the `cosmetic-phash-sweep` cron then replays on a schedule — so a soft failure here would
 * PERSIST the thing the guard exists to refuse.
 */

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  PutObjectCommand: class {},
}));
vi.mock('@aws-sdk/client-s3', () => ({ PutObjectCommand: class {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/services/cosmetic-phash.service', () => ({
  queueCosmeticPerceptualHash: vi.fn(),
}));
vi.mock('~/server/services/storage-resolver', () => ({ registerMediaLocation: vi.fn() }));
vi.mock('~/server/schema/subscriptions.schema', () => ({
  subscriptionProductMetadataSchema: {},
}));
vi.mock('~/utils/s3-utils', () => ({ getImageUploadBackend: vi.fn() }));
// Pin the edge host — @prisma/client dotenv-loads `<repo>/.env` at import, so an unpinned
// expectation would depend on whether the checkout has one.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));

import { resizeBadgeImage } from '~/server/services/product-badge.service';

const EVIL_URL = 'https://evil.com/badge.png';
const STORAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/badge.png';

/**
 * 🔴 A DEFAULT resolution with an accusatory id, not a bare reset. With `submitWorkflow`
 * returning `undefined`, deleting the guard would kill the test on `Badge resize failed`
 * — an error about a broken mock, not about the allowlist, i.e. a mutant dying for the wrong
 * reason and reading as coverage.
 */
const allowSubmitByDefault = () =>
  mockSubmitWorkflow.mockReset().mockResolvedValue({
    data: {
      status: 'succeeded',
      steps: [{ status: 'succeeded', output: { images: [{ id: 'MUSTNOTHAPPEN' }] } }],
    },
    error: undefined,
    response: undefined,
  });

beforeEach(() => {
  allowSubmitByDefault();
});

describe('resizeBadgeImage URL allowlist', () => {
  it('throws before any orchestrator interaction for an off-allowlist absolute URL', async () => {
    await expect(resizeBadgeImage({ url: EVIL_URL })).rejects.toThrow(
      'not on the ingestion allowlist'
    );
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses the slash-light spelling getEdgeUrl would forward as a relative key', async () => {
    await expect(resizeBadgeImage({ url: 'http:/evil.com/badge.png' })).rejects.toThrow(
      'not on the ingestion allowlist'
    );
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a blob: url, which is never fetchable server-side', async () => {
    await expect(resizeBadgeImage({ url: 'blob:https://civitai.com/abc' })).rejects.toThrow(
      'not on the ingestion allowlist'
    );
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('does NOT reach the guard on the early-return path (already target size)', async () => {
    // The width/height short-circuit precedes the guard, so an already-200x200 badge is
    // returned untouched. Pinned so a future reorder does not silently start rejecting
    // stored urls that never needed re-encoding.
    await expect(resizeBadgeImage({ url: EVIL_URL, width: 200, height: 200 })).resolves.toBe(
      EVIL_URL
    );
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('submits an allowed relative storage key, resolved onto the edge', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: {
        status: 'succeeded',
        steps: [{ status: 'succeeded', output: { images: [{ id: 'resized-1' }] } }],
      },
      error: undefined,
      response: undefined,
    });

    await resizeBadgeImage({ url: STORAGE_KEY }).catch(() => undefined);

    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    const image = mockSubmitWorkflow.mock.calls[0][0].body.steps[0].input.image;
    expect(image.startsWith('https://image.test/')).toBe(true);
  });

  it('submits the NORMALIZED absolute url, so the fetcher resolves the host we validated', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: {
        status: 'succeeded',
        steps: [{ status: 'succeeded', output: { images: [{ id: 'resized-2' }] } }],
      },
      error: undefined,
      response: undefined,
    });

    await resizeBadgeImage({ url: 'http:/image.civitai.com/a/b.png' }).catch(() => undefined);

    const image = mockSubmitWorkflow.mock.calls[0][0].body.steps[0].input.image;
    expect(image).toBe('http://image.civitai.com/a/b.png');
  });
});
