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
 *
 * enforceTokenScope runs in the publicProcedure base chain BEFORE the input parser
 * and the appDeveloperProcedure / enforceAppBlocksAuthorFlag author gate, so a
 * scope denial throws before the service is ever imported/called. Bitmask values are
 * hard-coded so a drift in the enum trips the sanity test.
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
  mockGetMyListingForEdit,
  mockGetMyListingForApp,
  mockBeginListingRevision,
  mockSubmitListingRevision,
  mockPersistListingAssetImage,
  mockIngestListingAssetFromDataUri,
} = vi.hoisted(() => ({
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppListingsEnabled: vi.fn(async () => true),
  mockResolveStoreVisibilityScope: vi.fn(async () => 'full'),
  mockGetAssetScanStatuses: vi.fn(async () => []),
  mockSetListingIcon: vi.fn(async () => ({ ok: true })),
  mockSetListingCover: vi.fn(async () => ({ ok: true })),
  mockAddListingScreenshot: vi.fn(async () => ({ ok: true })),
  mockGetMyListingForEdit: vi.fn(async () => ({ id: 'lst_1' })),
  mockGetMyListingForApp: vi.fn(async () => ({ appListingId: 'lst_1', status: 'draft' })),
  mockBeginListingRevision: vi.fn(async () => ({ shadowId: 'shd_1' })),
  mockSubmitListingRevision: vi.fn(async () => ({ ok: true })),
  mockPersistListingAssetImage: vi.fn(async () => ({ imageId: 1 })),
  mockIngestListingAssetFromDataUri: vi.fn(async () => ({ imageId: 1 })),
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
}));
vi.mock('~/server/services/blocks/offsite-listing.service', () => ({
  getMyListingForEdit: mockGetMyListingForEdit,
  getMyListingForApp: mockGetMyListingForApp,
  beginListingRevision: mockBeginListingRevision,
  submitListingRevision: mockSubmitListingRevision,
  persistListingAssetImage: mockPersistListingAssetImage,
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
  { name: 'addScreenshot', input: { listingId: 'lst_1', imageId: 1 }, mock: mockAddListingScreenshot },
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
];

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
});

describe('app-listings CLI scope gate — bitmask sanity', () => {
  it('the hard-coded bitmasks match the enum', () => {
    expect(TokenScope.Full).toBe(FULL);
    expect(TokenScope.AppBlocksSubmit).toBe(1 << 25);
    expect(
      TokenScope.UserRead | TokenScope.AppBlocksSubmit | TokenScope.AppBlocksDevTunnel
    ).toBe(CLI);
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
      await expect((caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)).resolves.toBeDefined();
      expect(mock).toHaveBeenCalledTimes(1);
    });
  }
});

describe('app-listings CLI scope gate — a Full personal API key still reaches every proc (no regression)', () => {
  for (const { name, input, mock } of PROCS) {
    it(`${name}: Full personal API key passes the scope gate (no regression)`, async () => {
      const caller = appListingsRouter.createCaller(tokenCtx(100, FULL) as never);
      await expect((caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input)).resolves.toBeDefined();
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
