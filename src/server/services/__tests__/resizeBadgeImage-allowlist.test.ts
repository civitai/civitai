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
 * A DEFAULT resolution rather than a bare reset, so a guard-deleted mutant gets PAST the
 * `if (!data)` throw instead of dying on `Badge resize failed: unknown error` — an error about
 * the mock rather than about the allowlist.
 *
 * ⚠ CORRECTED: this block used to claim the planted `'MUSTNOTHAPPEN'` id was the accusatory
 * signal. It is not, and cannot be — the implementation reads `step?.output?.blob?.url`
 * (`product-badge.service.ts`), never `output.images[0].id`, so that string is never read by
 * anything and a deleted guard dies on `'Badge resize did not return an output blob'`
 * instead. The comment asserted a mechanism it did not have. **What actually discriminates**
 * on the FOUR REFUSAL rows — and only those four — is the pair they assert: the guard's own
 * message (`'not on the ingestion allowlist'`), which no downstream failure produces, AND
 * `mockSubmitWorkflow` never having been called. The id is left in place only as inert
 * fixture shape; do not reintroduce a claim about it.
 *
 * ⚠ "every test below" is what this said, and that was its own smaller version of the same
 * overclaim: the three NON-refusal rows do not assert that pair and must not — two assert
 * `toHaveBeenCalledTimes(1)`, the opposite, and the short-circuit row asserts a resolved
 * value. Read as a convention, "every test" would invite an eighth row without the pair,
 * which would pass on a deleted guard.
 */
const allowSubmitByDefault = () =>
  mockSubmitWorkflow.mockReset().mockResolvedValue({
    data: {
      status: 'succeeded',
      steps: [{ status: 'succeeded', output: { images: [{ id: 'inert-fixture' }] } }],
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

  it('refuses an off-allowlist url even on the target-size SHORT-CIRCUIT path', async () => {
    // 🔴 THIS ROW REPLACES ONE THAT PINNED THE BYPASS AS INTENDED, which is worse than having
    // no row: `width`/`height` are caller input (`product-badge.schema.ts`, plain optional
    // positive ints), so when the short-circuit preceded the guard this exact call returned
    // EVIL_URL and `upsertProductBadge` persisted it into the cosmetic's `data.url` for the
    // phash sweep to replay — the outcome the guard's own comment says it prevents. The old
    // row asserted `.resolves.toBe(EVIL_URL)` and a green suite certified the hole.
    await expect(resizeBadgeImage({ url: EVIL_URL, width: 200, height: 200 })).rejects.toThrow(
      'not on the ingestion allowlist'
    );
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('still short-circuits an ALLOWED url at target size — no orchestrator round-trip', async () => {
    // The cost short-circuit must survive the reorder: an allowed, already-200x200 badge is
    // returned untouched and submits nothing. Without this row, moving the guard first could
    // have been "fixed" by deleting the short-circuit and nothing would have objected.
    await expect(resizeBadgeImage({ url: STORAGE_KEY, width: 200, height: 200 })).resolves.toBe(
      STORAGE_KEY
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
