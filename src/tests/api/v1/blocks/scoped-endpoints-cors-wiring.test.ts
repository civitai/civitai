import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

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
  // Same: tip.ts, shared-storage/increment.ts and all six shared-storage WRITE
  // routes take the audit-detail stash as a named import.
  stashBlockActionDetail: () => undefined,
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
  // The restored `blocks/buzz.ts` imports this one (per-pool projection).
  getUserBuzzAccounts: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({ handleEndpointError: vi.fn() }));
// The four workflow routes' delegation seam. Stubbed so importing them does not
// drag the tRPC caller factory / blocks.router graph in at module eval — the same
// reason every other heavy import here is stubbed. Never invoked (this file only
// captures the options literal).
vi.mock('~/server/services/blocks/block-workflow-rest', () => ({
  blockWorkflowBearer: vi.fn(),
  blockWorkflowCaller: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', async () => {
  // ASYNC factory purely so the value schema below can be a REAL zod object.
  // `append.ts` / `update.ts` do `z.object({ value: sharedValueInput })` at
  // module scope, and a `vi.fn()` there throws during the import under test —
  // the same failure mode the numeric bounds note below describes.
  const z = await import('zod');
  return {
    assertValidCounterKey: vi.fn(),
    incrementSharedCounter: vi.fn(),
    getTopSharedCounters: vi.fn(),
    listSharedRows: vi.fn(),
    getSharedRow: vi.fn(),
    getSharedCounts: vi.fn(),
    appendSharedRow: vi.fn(),
    updateSharedRow: vi.fn(),
    voteSharedRow: vi.fn(),
    unvoteSharedRow: vi.fn(),
    withdrawSharedRow: vi.fn(),
    reportSharedRow: vi.fn(),
    // The shared read routes import these BOUNDS at module scope to build their zod
    // schemas, so the mock has to carry real numbers — `undefined` would make
    // `z.string().max(undefined)` throw during the import under test.
    SHARED_KEY_MAX: 64,
    SHARED_PREFIX_MAX: 64,
    SHARED_CURSOR_MAX: 200,
    SHARED_LIST_LIMIT_MAX: 100,
    SHARED_LIST_LIMIT_DEFAULT: 50,
    SHARED_COUNTS_KEYS_MAX: 100,
    SHARED_REASON_MAX: 500,
    sharedValueInput: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(4096).optional(),
      data: z.unknown().optional(),
    }),
  };
});

// The endpoint → expected requiredScope contract. Import order fixes the
// `captured` index; asserting the scope proves the CORS change didn't drop it.
/**
 * ⚠️ `allowOpaqueOrigin` is per-entry, NOT a constant, because it is not uniform:
 * `me.ts` declares a requiredScope and does NOT opt in. That is recorded here, not
 * changed — flipping a live route's CORS posture is not this file's business — but
 * it does mean "every scoped endpoint opts in" was never true, and a check written
 * on that assumption would have had to either lie or drag `me.ts` into a behaviour
 * change to stay green. Pinning the CURRENT value in both directions keeps the
 * derived set honest AND makes a silent flip on any of them fail.
 */
const ENDPOINTS: Array<{ module: string; requiredScope: string; allowOpaqueOrigin: boolean }> = [
  {
    module: '~/pages/api/v1/blocks/collections/index',
    requiredScope: 'collections:read:self',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/collections/[id]/index',
    requiredScope: 'collections:read:self',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/collections/[id]/follow',
    requiredScope: 'collections:write:self',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/tip',
    requiredScope: 'social:tip:self',
    allowOpaqueOrigin: true,
  },
  // The BALANCE self-read is a withBlockScope REST route again — restored so a
  // block can direct-fetch it without a page host in the middle — so it DOES
  // have CORS wiring to guard here. The other three buzz self-reads
  // (transactions / accounts / daily-compensation) remain host-mediated tRPC
  // MUTATIONS (blocks.getMyBuzz*) with no REST route and nothing to guard.
  {
    module: '~/pages/api/v1/blocks/buzz',
    requiredScope: 'buzz:read:self',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/increment',
    requiredScope: 'apps:storage:shared:write',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/top',
    requiredScope: 'apps:storage:shared:read',
    allowOpaqueOrigin: true,
  },
  // The shared READ surface. Same opaque-origin argument as top.ts: an UNVERIFIED
  // block direct-fetches these with `Origin: null`, so without allowOpaqueOrigin
  // every one of them 405s on the preflight before the Bearer gate is ever reached.
  {
    module: '~/pages/api/v1/blocks/shared-storage/list',
    requiredScope: 'apps:storage:shared:read',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/item',
    requiredScope: 'apps:storage:shared:read',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/counts',
    requiredScope: 'apps:storage:shared:read',
    allowOpaqueOrigin: true,
  },
  // The shared WRITE surface. Same opaque-origin argument again, and it bites
  // HARDER here than on the reads: a block whose feed renders but whose submit
  // button 405s on the preflight reads as an app bug, so a missing opt-in would
  // be diagnosed anywhere except here. The scope is the WRITE scope on all six —
  // that half of each entry is the authorization claim, not a transport one, and
  // a route that silently downgraded to `:read` would still pass a CORS-only
  // check.
  {
    module: '~/pages/api/v1/blocks/shared-storage/append',
    requiredScope: 'apps:storage:shared:write',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/update',
    requiredScope: 'apps:storage:shared:write',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/vote',
    requiredScope: 'apps:storage:shared:write',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/unvote',
    requiredScope: 'apps:storage:shared:write',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/withdraw',
    requiredScope: 'apps:storage:shared:write',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/shared-storage/report',
    requiredScope: 'apps:storage:shared:write',
    allowOpaqueOrigin: true,
  },
  // Added by the DERIVED check below, which found it ABSENT: tip-allowance has
  // declared `requiredScope` + `allowOpaqueOrigin` since it was written and was
  // never listed here. It is the exact miss this file exists to prevent, and it
  // sat unnoticed because the list was purely hand-maintained.
  {
    module: '~/pages/api/v1/blocks/tip-allowance',
    requiredScope: 'social:tip:self',
    allowOpaqueOrigin: true,
  },
  // 🔴 ALSO found ABSENT by the derived check, and the reason `allowOpaqueOrigin`
  // is a per-entry field: `me.ts` declares `requiredScope: 'user:read:self'` and
  // does NOT opt into opaque origins, so an UNVERIFIED block's direct fetch of the
  // viewer self-read 405s on the preflight. Recorded as-is rather than "fixed"
  // here — changing a live route's CORS posture is a behaviour change that belongs
  // in its own change with its own reasoning, not a side effect of widening a
  // ledger. The pin is what makes the current posture visible and a silent flip
  // loud. (me.ts's own header says "CORS: handled in withBlockScope from
  // BLOCK_ALLOWED_ORIGINS", which is consistent with omission rather than intent.)
  { module: '~/pages/api/v1/blocks/me', requiredScope: 'user:read:self', allowOpaqueOrigin: false },
  // The WORKFLOW surface. Same opaque-origin argument as the shared writes, and it
  // bites hardest of all here: a block whose catalog renders but whose Generate
  // button 405s on the preflight is the most confusing failure this platform can
  // produce, and it would be diagnosed anywhere except in a missing CORS opt-in.
  // The scope half of each entry is the authorization claim — all four take
  // `ai:write:budgeted`, INCLUDING the two reads, because that is the scope their
  // bridge twins assert, and a route that silently downgraded to something weaker
  // would still pass a CORS-only check.
  {
    module: '~/pages/api/v1/blocks/workflows/submit',
    requiredScope: 'ai:write:budgeted',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/workflows/estimate',
    requiredScope: 'ai:write:budgeted',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/workflows/poll',
    requiredScope: 'ai:write:budgeted',
    allowOpaqueOrigin: true,
  },
  {
    module: '~/pages/api/v1/blocks/workflows/cancel',
    requiredScope: 'ai:write:budgeted',
    allowOpaqueOrigin: true,
  },
];

/**
 * 🔴 THE LIST ABOVE WAS PURELY DECLARATIVE, WHICH MADE THIS FILE INERT FOR ANY
 * ROUTE THAT NEVER JOINED IT. Measured: deleting an entry left the suite GREEN —
 * every assertion iterates ENDPOINTS, so a scoped route that simply omits itself
 * is not "unguarded", it is INVISIBLE. That is the failure mode of a ledger with
 * no derived counterpart, and it is worse than no ledger, because the file's
 * header reads as coverage of "the scoped block endpoints" as a class.
 *
 * So: derive the population from the source tree and assert set equality both
 * directions. A route is in scope here when its OPTIONS LITERAL declares a
 * `requiredScope` — the same thing every assertion below checks — which is why
 * `me.ts`, `images.ts`, `models.ts` and `generation-resources.ts` are correctly
 * out (they declare none; their CORS wiring is `catalog-cors-wiring.test.ts`'s
 * job) and `v1/models/[id].ts` is out (it is not under `v1/blocks`).
 *
 * Comments are stripped first. Without that, `images.ts` and `models.ts` — whose
 * prose says "No requiredScope" — would be pulled in by their own documentation,
 * which is the prose-satisfies-a-code-assertion shape this repo has been bitten
 * by repeatedly.
 */
const BLOCKS_API_ROOT = path.join(process.cwd(), 'src/pages/api/v1/blocks');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

/** Every `v1/blocks` route whose withBlockScope options literal declares a requiredScope. */
function scopedRoutesFromSource(): Array<{ module: string; requiredScope: string }> {
  return walk(BLOCKS_API_ROOT)
    .map((full) => {
      const scope = /(?:^|[{,\s])requiredScope:\s*'([^']+)'/.exec(
        stripComments(readFileSync(full, 'utf8'))
      );
      if (!scope) return null;
      const rel = path
        .relative(BLOCKS_API_ROOT, full)
        .split(path.sep)
        .join('/')
        .replace(/\.ts$/, '');
      return { module: `~/pages/api/v1/blocks/${rel}`, requiredScope: scope[1] };
    })
    .filter((x): x is { module: string; requiredScope: string } => x !== null)
    .sort((a, b) => a.module.localeCompare(b.module));
}

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

      ENDPOINTS.forEach(({ module, requiredScope, allowOpaqueOrigin }, i) => {
        const opts = captured[i];
        // Pinned per entry, not asserted uniformly true: every route here EXCEPT
        // me.ts opts in, and an unverified (opaque-origin) block's direct fetch of
        // one that stops opting in 405s on the CORS preflight again.
        expect(opts.allowOpaqueOrigin ?? false, `${module} allowOpaqueOrigin`).toBe(
          allowOpaqueOrigin
        );
        // CORS-only change: the per-user authorization gate must be unchanged.
        expect(opts.requiredScope, `${module} requiredScope`).toBe(requiredScope);
      });
    }
  );

  it('the walk finds the scoped routes (positive control)', () => {
    // Report the pair, never the zero: an fs walk that matched nothing would make
    // the set comparison below a vacuous pass on two empty arrays.
    const derived = scopedRoutesFromSource();
    expect(derived.length).toBeGreaterThanOrEqual(10);
    expect(derived.map((d) => d.module)).toContain(
      '~/pages/api/v1/blocks/shared-storage/increment'
    );
    // And the comment strip must actually bite: models.ts documents "No
    // requiredScope" in prose and must NOT be pulled in by its own doc comment.
    expect(derived.map((d) => d.module)).not.toContain('~/pages/api/v1/blocks/models');
  });

  it('ENDPOINTS IS every scoped v1/blocks route — both directions', () => {
    expect(
      ENDPOINTS.map(({ module, requiredScope }) => ({ module, requiredScope })).sort((a, b) =>
        a.module.localeCompare(b.module)
      ),
      'A v1/blocks route declares a requiredScope but is not in ENDPOINTS above (or vice ' +
        'versa). Every assertion in this file iterates ENDPOINTS, so a scoped route absent ' +
        'from it is not merely unasserted — it is invisible, and dropping ' +
        '`allowOpaqueOrigin: true` from it would break the unverified-block fetch with this ' +
        'whole suite green. Add it, with its scope.'
    ).toEqual(scopedRoutesFromSource());
  });
});
