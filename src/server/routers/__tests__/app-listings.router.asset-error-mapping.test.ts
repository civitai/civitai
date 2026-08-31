import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * 🔴 The OWNER ASSET procs must map typed service errors, like every other proc here.
 *
 * WHY THIS SUITE EXISTS. Under LAZY shadow-revision minting each of the six asset
 * mutations calls `resolveOwnerAssetEditTarget` → `beginListingRevision`, which throws
 * `OffsiteRequestError` — a plain `Error` subclass, NOT a `TRPCError`. These six procs
 * were the only mutations in this router with no `mapOffsiteError` wrapper, because
 * before lazy minting they could not reach that code at all. The reachable trigger is
 * an ordinary status race: a moderator delists (or the owner withdraws) the listing
 * between the client's read and this write, so `beginListingRevision` throws
 * `INVALID_REVISION` / `'failed to open a revision draft'` — and the owner got an
 * opaque 500 with a generic message instead of the typed, actionable one.
 *
 * Drives the REAL router via `createCaller`, so the wrapper wiring (not a mock)
 * decides. The services are mocked so importing the router never drags in Prisma.
 */

const {
  mockSetIcon,
  mockSetCover,
  mockAddScreenshot,
  mockReorder,
  mockUpdateCaption,
  mockRemoveScreenshot,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
} = vi.hoisted(() => ({
  mockSetIcon: vi.fn(async () => ({ status: 'attached', iconId: 5 })),
  mockSetCover: vi.fn(async () => ({ status: 'attached', coverId: 6 })),
  mockAddScreenshot: vi.fn(async () => ({ status: 'attached', id: 'apls_1', order: 0 })),
  mockReorder: vi.fn(async () => ({ reordered: 1 })),
  mockUpdateCaption: vi.fn(async () => ({ id: 'apls_1' })),
  mockRemoveScreenshot: vi.fn(async () => ({ removed: 'apls_1' })),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksAuthorEnabled: vi.fn(),
}));

vi.mock('~/server/services/blocks/app-listing-assets.service', () => ({
  setListingIcon: mockSetIcon,
  setListingCover: mockSetCover,
  addListingScreenshot: mockAddScreenshot,
  reorderListingScreenshots: mockReorder,
  updateListingScreenshotCaption: mockUpdateCaption,
  removeListingScreenshot: mockRemoveScreenshot,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // `appDeveloperProcedure` gates on `getFeatureFlags(ctx).appBlocksAuthor`; the
  // asset procs are `protectedProcedure` + the author FLAG middleware, but the router
  // module graph still evaluates this.
  return { ...actual, getFeatureFlags: () => ({ appBlocksAuthor: true }) };
});
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

/**
 * A typed `OffsiteRequestError`-shaped throwable, WITHOUT importing the (mocked)
 * service. The router duck-types on `name === 'OffsiteRequestError'` + a string
 * `code`, so this exercises the real mapping path — the same fixture the other
 * router suites use.
 */
function offsiteErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'OffsiteRequestError', code });
}

const owner = { id: 2, isModerator: false, tier: 'free', username: 'dev', onboarding: 0x1f };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
});

/** Every asset proc, with a valid input and the service mock it routes to. */
const ASSET_PROCS = [
  {
    name: 'setIcon' as const,
    input: { listingId: 'apl_1', imageId: 5 },
    mock: mockSetIcon,
  },
  {
    name: 'setCover' as const,
    input: { listingId: 'apl_1', imageId: 5 },
    mock: mockSetCover,
  },
  {
    name: 'addScreenshot' as const,
    input: { listingId: 'apl_1', imageId: 5 },
    mock: mockAddScreenshot,
  },
  {
    name: 'reorderScreenshots' as const,
    input: { listingId: 'apl_1', orderedIds: ['apls_1'] },
    mock: mockReorder,
  },
  {
    name: 'updateScreenshotCaption' as const,
    input: { screenshotId: 'apls_1', caption: 'hi' },
    mock: mockUpdateCaption,
  },
  {
    name: 'removeScreenshot' as const,
    input: { screenshotId: 'apls_1' },
    mock: mockRemoveScreenshot,
  },
];

function call(name: (typeof ASSET_PROCS)[number]['name'], input: unknown) {
  const caller = appListingsRouter.createCaller(fakeCtx(owner) as never);
  return (caller[name] as (i: unknown) => Promise<unknown>)(input);
}

describe('owner asset procs — typed service errors are MAPPED, never leaked as a 500', () => {
  it.each(ASSET_PROCS)(
    '$name: a lazy-mint INVALID_REVISION surfaces as BAD_REQUEST with the real message',
    async ({ name, input, mock }) => {
      // The reachable race: a mod delists the listing between the client's read and
      // this write, so `beginListingRevision` refuses to open a revision draft.
      mock.mockRejectedValueOnce(
        offsiteErr('INVALID_REVISION', 'only an approved listing can be revised') as never
      );

      const err = await call(name, input).then(
        () => null,
        (e: unknown) => e
      );

      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('BAD_REQUEST');
      // The actionable message survives — this is the whole point of mapping.
      expect((err as TRPCError).message).toBe('only an approved listing can be revised');
    }
  );

  it.each(ASSET_PROCS)(
    '$name: a typed NOT_FOUND maps to NOT_FOUND',
    async ({ name, input, mock }) => {
      mock.mockRejectedValueOnce(offsiteErr('NOT_FOUND', 'listing not found') as never);
      const err = await call(name, input).then(
        () => null,
        (e: unknown) => e
      );
      expect((err as TRPCError).code).toBe('NOT_FOUND');
    }
  );

  it.each(ASSET_PROCS)(
    '$name: a typed NOT_OWNED maps to FORBIDDEN',
    async ({ name, input, mock }) => {
      mock.mockRejectedValueOnce(
        offsiteErr('NOT_OWNED', 'you can only manage your own listings') as never
      );
      const err = await call(name, input).then(
        () => null,
        (e: unknown) => e
      );
      expect((err as TRPCError).code).toBe('FORBIDDEN');
    }
  );

  it.each(ASSET_PROCS)(
    '$name: a TRPCError the service already shaped passes through UNCHANGED',
    async ({ name, input, mock }) => {
      // The asset validators + the fail-closed row-id re-map already throw TRPCErrors;
      // wrapping must not re-code or re-word them.
      const shaped = new TRPCError({ code: 'BAD_REQUEST', message: 'Icon must be square' });
      mock.mockRejectedValueOnce(shaped as never);
      const err = await call(name, input).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBe(shaped);
    }
  );

  it.each(ASSET_PROCS)(
    '$name: an UNEXPECTED infra failure is a generic 500 — no raw message leak',
    async ({ name, input, mock }) => {
      mock.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 10.0.0.7:5432 pgbouncer-pooler-nvme0') as never
      );
      const err = await call(name, input).then(
        () => null,
        (e: unknown) => e
      );
      expect((err as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
      expect((err as TRPCError).message).not.toMatch(/ECONNREFUSED|pgbouncer/);
    }
  );

  it.each(ASSET_PROCS)(
    '$name: the happy path is untouched by the wrapper',
    async ({ name, input, mock }) => {
      await expect(call(name, input)).resolves.toBeDefined();
      expect(mock).toHaveBeenCalledTimes(1);
    }
  );
});
