import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APP LISTING MEDIA — OAuth token-scope gate on the listing-media authoring procs
 * the civitai CLI drives (civitai/cli#186).
 *
 * These procs were UN-annotated, so `enforceTokenScope` (trpc.ts base chain)
 * implicitly required `TokenScope.Full` and 403'd the CLI's scoped OAuth login
 * token. Each is now `.meta({ requiredScope: TokenScope.AppBlocksSubmit })` — a bit
 * that token already carries. This locks the resulting matrix (mirrors
 * blocks.router.devTunnel.test.ts):
 *
 *   - Full personal API key (33554431)     → passes the scope gate (NO regression;
 *                                             enforceTokenScope early-returns on Full,
 *                                             even though Full excludes AppBlocksSubmit).
 *   - CLI OAuth token (UserRead|AppBlocksSubmit|AppBlocksDevTunnel = 100663297)
 *                                           → passes the scope gate.
 *   - A scoped token WITHOUT AppBlocksSubmit (UserRead|AppBlocksDevTunnel = 67108865)
 *                                           → FORBIDDEN at the scope gate (message
 *                                             mentions "scope"), never reaches the proc.
 *   - A COOKIE SESSION (apiKeyId null, tokenScope Full)
 *                                           → passes the scope gate (NO regression).
 *
 * enforceTokenScope runs in the publicProcedure base chain BEFORE the input parser
 * and the appDeveloperProcedure / enforceAppBlocksAuthorFlag author gate, so a
 * scope denial throws before the service is ever imported/called. Bitmask values are
 * hard-coded so a drift in the enum trips the sanity test.
 *
 * ## 🔴 THE DOCTOR SURFACE (this PR) — `listMine` / `updateListing` / `updateRevisionDraft`
 *
 * `civitai app doctor` reads a listing's problems and fixes them. THREE more procs were
 * annotated for it, and the two writes are the first WRITES in this set that are not media
 * attachments, so the matrix below runs over them identically rather than being taken on
 * trust from the media procs.
 *
 * 🔴 A FOURTH — `getAssets` — WAS ANNOTATED AND THE ANNOTATION WAS THEN WITHDRAWN, as a
 * product decision, because its service gate bypasses for moderators and it added nothing
 * the other annotated procs do not already carry. It now lives in {@link
 * UNANNOTATED_PROCS} and is asserted to REFUSE the scoped token. That is deliberate: the
 * refusal is the only thing that distinguishes "the annotation was correctly withdrawn"
 * from "the case was deleted", and both look the same in a pass count.
 *
 * 🔴 WHICH ARMS ARE REGRESSION COVERAGE AND WHICH ARE INVARIANT GUARDS, stated because a
 * green arm proves different things in the two cases:
 *   - `CLI OAuth token → admitted` is RED at `origin/main` for the three new procs (they
 *     were un-annotated, so `enforceTokenScope` implicitly demanded Full and 403'd).
 *     That arm is the regression coverage for this change.
 *   - `getAssets → REFUSED` is RED against the intermediate branch tip that annotated it,
 *     and green both at `origin/main` and at HEAD. It guards the WITHDRAWAL.
 *   - `Full personal API key → admitted`, `cookie session → admitted` and
 *     `scoped token without AppBlocksSubmit → refused` are GREEN at `origin/main` for
 *     every proc, new and old. They are INVARIANT GUARDS: they pin that widening the
 *     gate did not withdraw a credential that already worked, and did not open the gate
 *     to a token that should still be refused. Neither is regression coverage for the
 *     admission this PR adds; both are what makes "correctly scoped" distinguishable
 *     from "gate removed".
 */

const {
  mockIsAppBlocksAuthorEnabled,
  mockIsAppBlocksEnabled,
  mockIsAppListingsEnabled,
  mockResolveStoreVisibilityScope,
  mockGetAssetScanStatuses,
  mockSetListingIcon,
  mockSetListingCover,
  mockAddListingScreenshot,
  mockReorderListingScreenshots,
  mockUpdateListingScreenshotCaption,
  mockRemoveListingScreenshot,
  mockGetMyListingForEdit,
  mockGetMyListingForApp,
  mockBeginListingRevision,
  mockSubmitListingRevision,
  mockPersistListingAssetImage,
  mockIngestListingAssetFromDataUri,
  mockGetListingAssets,
  mockListMyAppListings,
  mockUpdateListing,
  mockUpdateRevisionDraft,
} = vi.hoisted(() => ({
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppListingsEnabled: vi.fn(async () => true),
  mockResolveStoreVisibilityScope: vi.fn(async () => 'full'),
  mockGetAssetScanStatuses: vi.fn(async () => []),
  mockSetListingIcon: vi.fn(async () => ({ ok: true })),
  mockSetListingCover: vi.fn(async () => ({ ok: true })),
  mockAddListingScreenshot: vi.fn(async () => ({ ok: true })),
  mockReorderListingScreenshots: vi.fn(async () => ({ ok: true })),
  mockUpdateListingScreenshotCaption: vi.fn(async () => ({ ok: true })),
  mockRemoveListingScreenshot: vi.fn(async () => ({ ok: true })),
  mockGetMyListingForEdit: vi.fn(async () => ({ id: 'lst_1' })),
  mockGetMyListingForApp: vi.fn(async () => ({ appListingId: 'lst_1', status: 'draft' })),
  mockBeginListingRevision: vi.fn(async () => ({ shadowId: 'shd_1' })),
  mockSubmitListingRevision: vi.fn(async () => ({ ok: true })),
  mockPersistListingAssetImage: vi.fn(async () => ({ imageId: 1 })),
  mockIngestListingAssetFromDataUri: vi.fn(async () => ({ imageId: 1 })),
  // The doctor surface (this PR). Return shapes are only ever asserted as "defined" —
  // what these mocks are FOR is proving the scope gate let the call through to them.
  mockGetListingAssets: vi.fn(async () => ({ listingId: 'lst_1', completeness: {} })),
  mockListMyAppListings: vi.fn(async () => [{ appListingId: 'lst_1', problems: [] }]),
  mockUpdateListing: vi.fn(async () => ({ listingId: 'lst_1', requiresReview: false })),
  mockUpdateRevisionDraft: vi.fn(async () => ({ shadowId: 'shd_1' })),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppListingsEnabled: mockIsAppListingsEnabled,
  resolveStoreVisibilityScope: mockResolveStoreVisibilityScope,
}));
vi.mock('~/server/services/blocks/app-listing-assets.service', () => ({
  getAssetScanStatuses: mockGetAssetScanStatuses,
  setListingIcon: mockSetListingIcon,
  setListingCover: mockSetListingCover,
  addListingScreenshot: mockAddListingScreenshot,
  reorderListingScreenshots: mockReorderListingScreenshots,
  updateListingScreenshotCaption: mockUpdateListingScreenshotCaption,
  removeListingScreenshot: mockRemoveListingScreenshot,
  getListingAssets: mockGetListingAssets,
}));
vi.mock('~/server/services/blocks/offsite-listing.service', () => ({
  getMyListingForEdit: mockGetMyListingForEdit,
  getMyListingForApp: mockGetMyListingForApp,
  beginListingRevision: mockBeginListingRevision,
  submitListingRevision: mockSubmitListingRevision,
  persistListingAssetImage: mockPersistListingAssetImage,
  updateListing: mockUpdateListing,
  updateRevisionDraft: mockUpdateRevisionDraft,
}));
vi.mock('~/server/services/blocks/app-access.service', () => ({
  listMyAppListings: mockListMyAppListings,
}));
vi.mock('~/server/services/blocks/listing-meta.service', () => ({
  ingestListingAssetFromDataUri: mockIngestListingAssetFromDataUri,
}));
// Rate limiters on some procs (submitListingRevision / persistAssetImage /
// ingestAssetFromDataUri) → pass-through so no redis is touched. The scope gate runs
// in the base chain BEFORE these anyway; this just keeps the PASS path off redis.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function authedCtx(userId: number, isModerator = true) {
  return {
    acceptableOrigin: true,
    user: { id: userId, isModerator, onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

// A token-authenticated caller (apiKeyId set) carrying `scope`. isModerator stays
// true so the author gate is satisfied and the ONLY thing under test is the scope gate.
function tokenCtx(userId: number, scope: number) {
  return { ...authedCtx(userId, true), apiKeyId: 999, tokenScope: scope };
}

const FULL = 33554431; // TokenScope.Full — a Full personal API key
const CLI = 1 | (1 << 25) | (1 << 26); // UserRead|AppBlocksSubmit|AppBlocksDevTunnel = 100663297
const NO_SUBMIT = 1 | (1 << 26); // UserRead|AppBlocksDevTunnel = 67108865 — scoped, lacks AppBlocksSubmit

// The listing-media authoring procs annotated for CLI reach + a schema-valid input +
// the service mock each should reach once the scope gate passes.
const PROCS: { name: string; input: unknown; mock: ReturnType<typeof vi.fn> }[] = [
  { name: 'getAssetScanStatuses', input: { imageIds: [1] }, mock: mockGetAssetScanStatuses },
  { name: 'setIcon', input: { listingId: 'lst_1', imageId: 1 }, mock: mockSetListingIcon },
  { name: 'setCover', input: { listingId: 'lst_1', imageId: 1 }, mock: mockSetListingCover },
  {
    name: 'addScreenshot',
    input: { listingId: 'lst_1', imageId: 1 },
    mock: mockAddListingScreenshot,
  },
  {
    name: 'reorderScreenshots',
    input: { listingId: 'lst_1', orderedIds: ['ss_1'] },
    mock: mockReorderListingScreenshots,
  },
  {
    name: 'updateScreenshotCaption',
    input: { screenshotId: 'ss_1', caption: 'Grid view' },
    mock: mockUpdateListingScreenshotCaption,
  },
  { name: 'removeScreenshot', input: { screenshotId: 'ss_1' }, mock: mockRemoveListingScreenshot },
  { name: 'getMyListingForEdit', input: { listingId: 'lst_1' }, mock: mockGetMyListingForEdit },
  { name: 'getMyListingForApp', input: { appBlockId: 'apb_1' }, mock: mockGetMyListingForApp },
  { name: 'beginListingRevision', input: { listingId: 'lst_1' }, mock: mockBeginListingRevision },
  { name: 'submitListingRevision', input: { shadowId: 'shd_1' }, mock: mockSubmitListingRevision },
  {
    name: 'persistAssetImage',
    input: { url: '123e4567-e89b-12d3-a456-426614174000', width: 512, height: 512 },
    mock: mockPersistListingAssetImage,
  },
  {
    name: 'ingestAssetFromDataUri',
    input: { dataUri: 'data:image/png;base64,AAAA', kind: 'icon' },
    mock: mockIngestListingAssetFromDataUri,
  },
  // ---- `civitai app doctor` (this PR) ----------------------------------------
  // The READ the doctor reports from…
  { name: 'listMine', input: undefined, mock: mockListMyAppListings },
  // …and the two WRITES that fix what it reports. The patch names `tagline`
  // deliberately: `empty-tagline` is one of the advisory codes, so this input is the
  // literal repair the doctor's own output asks for.
  {
    name: 'updateListing',
    input: { listingId: 'lst_1', patch: { tagline: 'Fixed by the doctor' } },
    mock: mockUpdateListing,
  },
  {
    name: 'updateRevisionDraft',
    input: { shadowId: 'shd_1', patch: { description: 'Fixed by the doctor' } },
    mock: mockUpdateRevisionDraft,
  },
];

/**
 * 🔴 PROCS THAT ARE DELIBERATELY **NOT** ANNOTATED, asserted as such.
 *
 * `getAssets` was annotated during the `civitai app doctor` work and the annotation was
 * WITHDRAWN as a product decision: its service gate
 * (`app-listing-assets::loadOwnedListing`) short-circuits the ownership check for
 * moderators, so admitting a scoped OAuth token would let a third-party app a moderator
 * authorised inherit cross-listing asset reads — and it bought nothing, because every
 * datum `app doctor` wanted is already on procs in PROCS above (`listMine.problems[]`,
 * `getMyListingForEdit` / `getMyListingForApp` per-screenshot rows,
 * `getAssetScanStatuses` per-image scan state).
 *
 * 🔴 A DELETED TEST AND A CORRECT REVERT LOOK IDENTICAL FROM THE PASS COLUMN. Without an
 * explicit REFUSAL assertion the suite cannot tell "the annotation was withdrawn" from
 * "someone dropped the case", so the withdrawal is pinned behaviourally here: a scoped
 * OAuth token must 403 at the scope gate, while a Full key and a cookie session must
 * still get through (they take the exact-equality early return and were never affected).
 */
const UNANNOTATED_PROCS: { name: string; input: unknown; mock: ReturnType<typeof vi.fn> }[] = [
  { name: 'getAssets', input: { listingId: 'lst_1' }, mock: mockGetListingAssets },
];

/**
 * The procs this PR annotated. Named as a set so the `at origin/main this arm is RED`
 * claim in the header has a machine-readable referent, and so a future annotation that
 * forgets to extend PROCS is visible as a missing member rather than as silence.
 */
const DOCTOR_PROCS = ['listMine', 'updateListing', 'updateRevisionDraft'];

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
});

describe('app-listings CLI scope gate — bitmask sanity', () => {
  it('the hard-coded bitmasks match the enum', () => {
    expect(TokenScope.Full).toBe(FULL);
    expect(TokenScope.AppBlocksSubmit).toBe(1 << 25);
    expect(TokenScope.UserRead | TokenScope.AppBlocksSubmit | TokenScope.AppBlocksDevTunnel).toBe(
      CLI
    );
    expect(TokenScope.UserRead | TokenScope.AppBlocksDevTunnel).toBe(NO_SUBMIT);
    // Full deliberately EXCLUDES AppBlocksSubmit — the reason the early-return, not
    // hasFlag(Full, AppBlocksSubmit), is what preserves the Full-personal-key path.
    expect((TokenScope.Full & TokenScope.AppBlocksSubmit) === TokenScope.AppBlocksSubmit).toBe(
      false
    );
  });
});

describe('app-listings CLI scope gate — the CLI OAuth token reaches every annotated proc', () => {
  for (const { name, input, mock } of PROCS) {
    it(`${name}: CLI OAuth token (AppBlocksSubmit) passes the scope gate and reaches the proc`, async () => {
      const caller = appListingsRouter.createCaller(tokenCtx(100, CLI) as never);
      await expect(
        (caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)
      ).resolves.toBeDefined();
      expect(mock).toHaveBeenCalledTimes(1);
    });
  }
});

/**
 * 🔴 THE WITHDRAWN ANNOTATION, ASSERTED AS A REFUSAL.
 *
 * `getAssets` must be back to its base behaviour: a scoped OAuth token gets FORBIDDEN at
 * the scope gate and the service is never reached, because an un-annotated proc
 * implicitly requires `TokenScope.Full`. RED against the branch tip where it was still
 * annotated, green once the `.meta(...)` is gone — which is what makes this a check on
 * the revert rather than a restatement of it.
 */
describe('🔴 app-listings CLI scope gate — a DELIBERATELY un-annotated proc still refuses the CLI token', () => {
  for (const { name, input, mock } of UNANNOTATED_PROCS) {
    it(`${name}: CLI OAuth token (AppBlocksSubmit) is REFUSED — the annotation was withdrawn`, async () => {
      const caller = appListingsRouter.createCaller(tokenCtx(100, CLI) as never);
      await expect(
        (caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('scope'),
      });
      expect(mock).not.toHaveBeenCalled();
    });

    it(`${name}: a scoped token without AppBlocksSubmit is refused too`, async () => {
      const caller = appListingsRouter.createCaller(tokenCtx(100, NO_SUBMIT) as never);
      await expect(
        (caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mock).not.toHaveBeenCalled();
    });
  }

  it('🔴 the withdrawn proc is NOT also sitting in the annotated set', () => {
    // Belt-and-braces on the two tables above: a proc listed in BOTH would be asserted
    // to admit and to refuse the same credential, and whichever ran last would decide.
    const annotated = new Set(PROCS.map((p) => p.name));
    for (const { name } of UNANNOTATED_PROCS) {
      expect(annotated.has(name), `${name} is in PROCS and UNANNOTATED_PROCS`).toBe(false);
    }
  });
});

describe('app-listings CLI scope gate — a Full personal API key still reaches every proc (no regression)', () => {
  // 🔴 INCLUDES THE UN-ANNOTATED PROC. `getAssets` worked for a Full key before this PR
  // and must still work after the annotation was withdrawn — the withdrawal is about the
  // scoped OAuth token ONLY. Dropping it from this arm would let a revert that broke the
  // Full-key path pass unnoticed.
  for (const { name, input, mock } of [...PROCS, ...UNANNOTATED_PROCS]) {
    it(`${name}: Full personal API key passes the scope gate (no regression)`, async () => {
      const caller = appListingsRouter.createCaller(tokenCtx(100, FULL) as never);
      await expect(
        (caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)
      ).resolves.toBeDefined();
      expect(mock).toHaveBeenCalledTimes(1);
    });
  }
});

describe('app-listings CLI scope gate — a scoped token lacking AppBlocksSubmit is rejected', () => {
  for (const { name, input, mock } of PROCS) {
    it(`${name}: scoped token without AppBlocksSubmit → FORBIDDEN at the scope gate, never reaches the proc`, async () => {
      const caller = appListingsRouter.createCaller(tokenCtx(100, NO_SUBMIT) as never);
      await expect(
        (caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('scope'),
      });
      expect(mock).not.toHaveBeenCalled();
    });
  }
});

/**
 * 🔴 THE COOKIE-SESSION ARM — the credential this PR could plausibly have BROKEN.
 *
 * A browser request carries no token at all: `createContext` reads
 * `req.context?.tokenScope` and defaults to `TokenScope.Full` when it is absent, with
 * `apiKeyId`/`subject` undefined. `runEnforceTokenScope` then takes the
 * `ctx.tokenScope !== TokenScope.Full` EXACT-EQUALITY early return, so `requiredScope` —
 * the only thing `.meta()` changes — is never compared against anything. That is the
 * mechanism behind "this meta can only ADMIT", and this arm is what makes the claim
 * observable rather than a reading of the source.
 *
 * INVARIANT GUARD, not regression coverage: green at `origin/main` too, by construction.
 */
describe('app-listings CLI scope gate — a COOKIE SESSION still reaches every proc (no regression)', () => {
  // 🔴 INCLUDES THE UN-ANNOTATED PROC, for the same reason as the Full-key arm: the
  // browser reaches `getAssets` through the exact-equality early return, and withdrawing
  // an annotation must not disturb that. This is the arm that would catch a "revert" that
  // accidentally added a gate instead of removing one.
  for (const { name, input, mock } of [...PROCS, ...UNANNOTATED_PROCS]) {
    it(`${name}: cookie session (no token) passes the scope gate`, async () => {
      // apiKeyId null + tokenScope Full = exactly what `createContext` builds for a
      // browser request. NOT `tokenCtx`, which sets apiKeyId — the distinction is the
      // point of this arm.
      const caller = appListingsRouter.createCaller(authedCtx(100) as never);
      await expect(
        (caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)
      ).resolves.toBeDefined();
      expect(mock).toHaveBeenCalledTimes(1);
    });
  }
});

describe('🔴 app-listings CLI scope gate — the doctor procs are IN the matrix', () => {
  /**
   * A ledger, not a formality. Every arm above iterates PROCS, so a proc annotated in the
   * router but never added here is covered by NOTHING while the file still reports a long
   * green list. This fails if a doctor proc goes missing from the matrix.
   */
  it('every proc this PR annotated is exercised by all four credential arms', () => {
    const covered = new Set(PROCS.map((p) => p.name));
    for (const name of DOCTOR_PROCS) {
      expect(covered.has(name), `${name} is annotated but absent from PROCS`).toBe(true);
    }
  });
});
