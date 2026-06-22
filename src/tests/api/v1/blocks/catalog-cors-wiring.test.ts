import { describe, it, expect, vi } from 'vitest';

/**
 * Wiring guard for the opaque-origin CORS fix (civitai PR #2681).
 *
 * The middleware MECHANISM — `withBlockScope` honoring `Origin: null` only when
 * `allowOpaqueOrigin` is set — is covered in
 * `src/server/middleware/__tests__/block-scope.anytoken-mode.test.ts`. But that
 * proves nothing about whether the two CATALOG endpoints actually OPT IN. The
 * endpoint-behavior tests (models-endpoint / images-endpoint) mock
 * `withBlockScope` as a passthrough, so dropping `allowOpaqueOrigin: true` from
 * `blocks/models.ts` or `blocks/images.ts` would leave every test green while
 * re-breaking the in-block catalog fetch for unverified (opaque-origin) blocks
 * in prod (405 on the CORS preflight).
 *
 * This test captures the exact opts each endpoint module passes to
 * `withBlockScope` at import time and asserts the opaque-origin opt is present.
 */

// Capture the opts each endpoint hands to withBlockScope at module-eval time.
const captured: Array<Record<string, unknown>> = [];
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (_handler: unknown, opts: Record<string, unknown>) => {
    captured.push(opts ?? {});
    // Return a stand-in handler; this test never invokes it.
    return () => undefined;
  },
}));

// Mock the heavy imports the endpoints pull in at module load so importing them
// doesn't drag the Prisma client / search services (mirrors the mock set the
// existing models-endpoint / images-endpoint tests use).
vi.mock('~/server/services/model-search.service', () => ({
  runModelSearch: vi.fn(),
  resolveModelSearchIds: vi.fn(),
  ModelSearchMeiliTimeoutError: class extends Error {},
}));
vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: vi.fn(),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/utils/endpoint-helpers', () => ({ handleEndpointError: vi.fn() }));
vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: () => ({ baseUrl: { origin: 'https://civitai.com' }, nextPage: undefined }),
  getPagination: () => ({ skip: 0 }),
}));
vi.mock('~/server/utils/request-bulkhead', () => ({
  acquireBulkheadSlot: () => () => {},
  BulkheadFullError: class extends Error {},
  HEAVY_REQUEST_CONCURRENCY: 10,
}));

describe('block catalog endpoints — opaque-origin CORS wiring (PR #2681)', () => {
  it('both /api/v1/blocks/{models,images} opt into allowOpaqueOrigin', async () => {
    // Import order: models then images → captured = [modelsOpts, imagesOpts].
    await import('~/pages/api/v1/blocks/models');
    await import('~/pages/api/v1/blocks/images');

    expect(captured).toHaveLength(2);
    // Every catalog endpoint must opt in — else an unverified (opaque-origin)
    // block's direct catalog fetch 405s on the CORS preflight again.
    for (const opts of captured) {
      expect(opts.allowOpaqueOrigin).toBe(true);
    }
    // And neither catalog endpoint declares a requiredScope ("any valid block
    // token" mode) — the maturity clamp is the whole authority surface.
    for (const opts of captured) {
      expect(opts.requiredScope).toBeUndefined();
    }
  });
});
