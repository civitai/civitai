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
 * `withBlockScope` at import time and asserts THREE things about them: the
 * opaque-origin opt is present, no `requiredScope` is declared, and each route
 * carries its OWN `endpoint` label. The last one is here for the same reason as
 * the first — it is invisible to the endpoint-behavior tests (which mock
 * `withBlockScope` away entirely) and would degrade only in prod telemetry.
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
  // The two `await import(...)` cold-transform a Next API page graph (~10s on a
  // loaded box) — right at the 10s global default, so worker-pool contention pushed
  // it over and flaked. Give this import-bound test a generous explicit budget.
  it(
    'all of /api/v1/blocks/{models,images,tools} opt into allowOpaqueOrigin, declare no requiredScope, and carry their own endpoint label',
    { timeout: 60000 },
    async () => {
      // Import order: models, images, tools → captured in that order.
      await import('~/pages/api/v1/blocks/models');
      await import('~/pages/api/v1/blocks/images');
      // The tool surface (#398 AC5) is called DIRECTLY from the sandboxed iframe
      // during a tool-calling loop, so it needs the same opaque-origin opt-in —
      // and, like the other two, it would fail only in prod (405 on the CORS
      // preflight) with every test still green.
      await import('~/pages/api/v1/blocks/tools');

      expect(captured).toHaveLength(3);
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
      // 🔴 EACH ENDPOINT DECLARES ITS OWN `endpoint` LABEL, asserted per-route
      // rather than in the loops above — the loops check a property they SHARE,
      // this checks the one thing that must DIFFER between them.
      //
      // Why it is pinned here and not left to the endpoint tests: a delta audit
      // found `endpoint: 'tools'` → `'models'` typechecks (`AppBlockEndpoint` is
      // a union containing both) and survived all ~23.9k tests — the sole
      // surviving mutant in the suite. The blast radius is narrow but real and
      // SILENT: the audit row takes its endpoint from `normalizeEndpoint(req.url)`
      // in the middleware, NOT from these opts, so the rows stay correct; what
      // breaks is the Prometheus RED pair (`civitai_app_block_requests_total` /
      // `_request_duration_seconds`), which would merge tool traffic into
      // `models` with nothing anywhere reporting a fault.
      //
      // 🔴 `endpoint` MAY BE A RESOLVER, so this reads the RESOLVED label rather
      // than the raw opt. `/api/v1/blocks/tools` serves two materially different
      // workloads on one path — a static declarations GET and a catalog-search
      // POST — and passes a per-request function so the RED series can tell them
      // apart. Comparing the raw opt against a string would compare a Function
      // to `'tools'` and fail while the wiring is correct.
      //
      // Resolving does NOT weaken the guard: the mutant this line exists for
      // (`'tools'` → `'models'`, which typechecks because `AppBlockEndpoint`
      // contains both, and once survived all ~23.9k tests) is still caught,
      // because a resolver returning `'models'` resolves to `'models'` here.
      const resolveLabel = (endpoint: unknown, method: string) =>
        typeof endpoint === 'function'
          ? (endpoint as (req: { method: string }) => string)({ method })
          : endpoint;

      // Index order is the import order above: models, images, tools.
      expect(captured.map((opts) => resolveLabel(opts.endpoint, 'GET'))).toEqual([
        'models',
        'images',
        'tools',
      ]);

      // 🔴 AND THE SPLIT ITSELF, pinned HERE because this is the file that
      // enumerates the catalog routes' labels — a future edit that collapsed the
      // resolver back to a bare `'tools'` would silently re-merge a free
      // declarations read with a Meilisearch query in the same RED series, and
      // the assertion above alone would still pass.
      expect(resolveLabel(captured[2].endpoint, 'POST')).toBe('tools_call');
    }
  );
});
