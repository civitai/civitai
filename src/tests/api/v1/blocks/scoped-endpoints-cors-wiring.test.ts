import { describe, it, expect, vi } from 'vitest';

/**
 * Wiring guard for the opaque-origin CORS fix on the SCOPED block endpoints
 * (collections / tip / buzz / shared-storage).
 *
 * The middleware MECHANISM — `withBlockScope` honoring `Origin: null` only when
 * `allowOpaqueOrigin` is set — is covered in
 * `src/server/middleware/__tests__/block-scope.anytoken-mode.test.ts`. And the
 * two CATALOG endpoints are guarded by `catalog-cors-wiring.test.ts`.
 *
 * But those prove nothing about whether these per-user endpoints actually
 * OPT IN. The endpoint-behavior tests (buzz-endpoint / tip-endpoint /
 * collections-endpoint / …) mock `withBlockScope` as a passthrough whose
 * `res.setHeader` is a no-op, so the real CORS layer never runs there — dropping
 * `allowOpaqueOrigin: true` from any of these modules would leave every one of
 * those tests green while re-breaking the in-block fetch for unverified
 * (opaque-origin) blocks in prod (405 on the CORS preflight).
 *
 * This test captures the exact opts each endpoint module passes to
 * `withBlockScope` at import time and asserts BOTH that the opaque-origin opt is
 * present AND that the endpoint's `requiredScope` authorization gate is intact
 * (the change must be CORS-only — it must not drop the scope).
 */

// Capture the opts each endpoint hands to withBlockScope at module-eval time.
const captured: Array<Record<string, unknown>> = [];
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (_handler: unknown, opts: Record<string, unknown>) => {
    captured.push(opts ?? {});
    // Return a stand-in handler; this test never invokes it.
    return () => undefined;
  },
  // Imported by several endpoints; only referenced inside the (never-run)
  // handler bodies, but provide a stub so the named import resolves.
  parseSubjectUserId: () => null,
}));

// Mock the heavy service/db/router imports the endpoints pull at module load so
// importing them doesn't drag the Prisma client / external clients. Union of the
// mock sets the existing per-endpoint tests use. None of these are invoked (we
// only capture opts at module eval), so bare stubs suffice.
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: vi.fn(),
  getCollectionItemCount: vi.fn(),
  getUserCollectionsWithPermissions: vi.fn(),
  getCollectionById: vi.fn(),
  getCollectionItemsByCollectionId: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  addContributorToCollection: vi.fn(),
  removeContributorFromCollection: vi.fn(),
}));
vi.mock('~/server/services/blocks/block-collections.service', () => ({
  collectionWithinCeiling: vi.fn(),
  getFollowedCollectionIds: vi.fn(),
  hydrateBlockSubject: vi.fn(),
  toMediaUrl: vi.fn(),
  mapImageItemToMedia: vi.fn(),
}));
vi.mock('~/server/utils/block-catalog-maturity', () => ({
  resolveCatalogBrowsingLevel: vi.fn(),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: vi.fn(),
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: vi.fn(),
  isRegionRestricted: vi.fn(),
}));
vi.mock('~/server/controllers/buzz.controller', () => ({
  createBuzzTipTransactionHandler: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({ dbRead: {} }));
vi.mock('~/server/clickhouse/client', () => ({ Tracker: class {} }));
vi.mock('~/server/utils/block-tip-rate-limit', () => ({
  BLOCK_TIP_CAP_PER_DAY: 0,
  BLOCK_TIP_MAX_PER_TIP: 0,
  checkBlockTipRateLimit: vi.fn(),
  refundBlockTipSpend: vi.fn(),
  reserveBlockTipSpend: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccount: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({ handleEndpointError: vi.fn() }));
vi.mock('~/server/routers/apps-shared.router', () => ({
  assertValidCounterKey: vi.fn(),
  incrementSharedCounter: vi.fn(),
  getTopSharedCounters: vi.fn(),
}));

// The endpoint → expected requiredScope contract. Import order fixes the
// `captured` index; asserting the scope proves the CORS change didn't drop it.
const ENDPOINTS: Array<{ module: string; requiredScope: string }> = [
  { module: '~/pages/api/v1/blocks/collections/index', requiredScope: 'collections:read:self' },
  {
    module: '~/pages/api/v1/blocks/collections/[id]/index',
    requiredScope: 'collections:read:self',
  },
  {
    module: '~/pages/api/v1/blocks/collections/[id]/follow',
    requiredScope: 'collections:write:self',
  },
  { module: '~/pages/api/v1/blocks/tip', requiredScope: 'social:tip:self' },
  // NOTE: the buzz self-reads (balance/transactions/accounts/daily-compensation)
  // are host-mediated tRPC MUTATIONS now (blocks.getMyBuzz*), not withBlockScope
  // REST routes, so they have no CORS wiring to guard here.
  {
    module: '~/pages/api/v1/blocks/shared-storage/increment',
    requiredScope: 'apps:storage:shared:write',
  },
  { module: '~/pages/api/v1/blocks/shared-storage/top', requiredScope: 'apps:storage:shared:read' },
];

describe('scoped block endpoints — opaque-origin CORS wiring', () => {
  // The `await import(...)` cold-transforms a Next API page graph each; give the
  // import-bound test a generous budget (mirrors catalog-cors-wiring.test.ts).
  it(
    'every collections/tip/buzz/shared-storage endpoint opts into allowOpaqueOrigin while keeping its requiredScope',
    { timeout: 60000 },
    async () => {
      for (const { module } of ENDPOINTS) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await import(module);
      }

      expect(captured).toHaveLength(ENDPOINTS.length);

      ENDPOINTS.forEach(({ requiredScope }, i) => {
        const opts = captured[i];
        // Must opt in — else an unverified (opaque-origin) block's direct fetch
        // 405s on the CORS preflight again.
        expect(opts.allowOpaqueOrigin).toBe(true);
        // CORS-only change: the per-user authorization gate must be unchanged.
        expect(opts.requiredScope).toBe(requiredScope);
      });
    }
  );
});
