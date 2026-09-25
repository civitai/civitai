import { describe, it, expect, vi } from 'vitest';

/**
 * Wiring guard for `GET /api/v1/blocks/gated-images` — the options literal it
 * hands `withBlockScope` at module-eval time.
 *
 * WHY IT IS ITS OWN FILE RATHER THAN A ROW IN AN EXISTING ONE. The two
 * sibling wiring guards partition the surface by a property this route does not
 * share with either side. `scoped-endpoints-cors-wiring.test.ts` derives its
 * population from routes that DECLARE a `requiredScope`; this one declares none,
 * so it is correctly invisible there. `catalog-cors-wiring.test.ts` covers the
 * no-scope routes — but it covers them as the CATALOG (`models`, `images`,
 * `tools`), and this route is not catalog data: it reads one app's own published
 * rows under one viewer's ceiling. Adding it to that file would make the file's
 * own title false, which is the drift that turns a guard into decoration.
 *
 * WHAT WOULD BREAK WITHOUT IT — all of it only in prod, with every other test
 * green, because `gated-images-endpoint.test.ts` and
 * `gated-images-clamp.seam.test.ts` both mock `withBlockScope` away entirely and
 * therefore cannot see these opts at all:
 *   - dropping `allowOpaqueOrigin` → an UNVERIFIED block runs at `Origin: null`
 *     and its direct fetch 405s on the CORS preflight;
 *   - gaining a `requiredScope` → every already-installed app's token lacks it,
 *     and the surface 403s fleet-wide until each app re-consents;
 *   - gaining `onApprovalLookupFailure: 'serve'` → a suspended app whose backing
 *     row cannot be read keeps serving its users' images;
 *   - a wrong `endpoint` label → the Prometheus RED pair merges this route's
 *     series into another's, with nothing anywhere reporting a fault. That exact
 *     mutant (`'tools'` → `'models'`) once survived the whole suite, which is why
 *     `catalog-cors-wiring.test.ts` pins labels per route and why this does too.
 */

// Capture the opts the route hands withBlockScope at module-eval time.
const captured: Array<Record<string, unknown>> = [];
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (_handler: unknown, opts: Record<string, unknown>) => {
    captured.push(opts ?? {});
    // A stand-in handler; this test never invokes it.
    return () => undefined;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
// Module-load stubs so importing the route does not drag the Prisma client or the
// block auth graph. None is invoked — only the options literal is read.
vi.mock('~/server/services/blocks/block-gated-images-read.service', () => ({
  resolveGatedImagesForBlockClaims: vi.fn(),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: vi.fn(),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({ handleEndpointError: vi.fn() }));

describe('/api/v1/blocks/gated-images — withBlockScope wiring', () => {
  it(
    'opts into allowOpaqueOrigin, declares no requiredScope, fails CLOSED on an approval-lookup failure, and carries its own endpoint label',
    { timeout: 60000 },
    async () => {
      await import('~/pages/api/v1/blocks/gated-images');

      // Positive control: report the pair, never the zero. A capture array that
      // stayed empty would make every assertion below vacuously true.
      expect(captured).toHaveLength(1);
      const opts = captured[0];

      expect(opts.allowOpaqueOrigin, 'allowOpaqueOrigin').toBe(true);
      expect(opts.requiredScope, 'requiredScope').toBeUndefined();
      // 🔴 The fail-closed one. `images.ts` opts into `'serve'` because it is
      // public catalog data; this route is viewer-scoped and mints a moderated
      // edge url, so it must take the default refusal. `no-unguarded-block-rest-
      // token.test.ts` asserts the same thing from the source text; this asserts
      // it from the value the middleware actually receives.
      expect(opts.onApprovalLookupFailure, 'onApprovalLookupFailure').toBeUndefined();
      // A literal, not a resolver — this route serves one workload on one method.
      expect(opts.endpoint, 'endpoint label').toBe('gated_images');
    }
  );
});
