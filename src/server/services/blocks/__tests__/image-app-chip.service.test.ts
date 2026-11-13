/**
 * The IMAGE detail page's "Published with <app>" chip — `readImageAppChip`.
 *
 * What only this file can see (the decision itself is pinned by the post chip's
 * logic tests, which this surface shares rather than copies):
 *
 *  - the image's OWN marker (`Image.metadata.blockPublishedAppId`) resolves to the
 *    same chip the post page would render for that app — including for a bare
 *    image with no post;
 *  - the ORDER: scope gate → `image.get`'s visibility + media rules → marker read
 *    keyed on the AUTHORISED row's id → app read;
 *  - FAIL-OPEN: a throwing read returns `null` instead of failing the page's query.
 *
 * 🔴 RED WITHOUT THE CHANGE: before it, `image-app-chip.service.ts` did not exist,
 * so this file fails at import; and no read of `Image.metadata` fed any chip, so
 * the "marker present → chip" case below had no code path that could produce it.
 */
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveStoreVisibilityScope, mockAssertVisible, mockCanSeeMedia } = vi.hoisted(() => {
  // Set before the static imports: `server-domain.ts` builds its domain map from
  // `process.env` at import time (see `post-app-chip.service.test.ts`).
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return {
    mockResolveStoreVisibilityScope: vi.fn(async (..._a: unknown[]): Promise<string> => 'full'),
    mockAssertVisible: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
    mockCanSeeMedia: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  };
});

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveStoreVisibilityScope: mockResolveStoreVisibilityScope,
}));
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertImageVisibleToViewer: mockAssertVisible,
}));
vi.mock('~/server/utils/image-media-visibility', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  viewerCanSeeImageMedia: mockCanSeeMedia,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { postAppChipQuery } from '~/server/services/blocks/post-app-chip.logic';
import { readImageAppChip } from '~/server/services/blocks/image-app-chip.service';

// Pairwise distinct, so a mutant reading the marker for the wrong id cannot pass.
const IMAGE_ID = 145511044;
const AUTHORISED_ROW_ID = 145511045;
const OWNER_ID = 4242;
const MARKER = 'appblk-character-sheet-studio';
const HOST = 'civitai.com';
const USER = { id: 77, isModerator: false } as never;
const ctx = { user: USER, features: {}, req: { headers: { host: HOST } } } as never;

const approvedAppRow = {
  name: 'Character Sheet Studio Client',
  appBlocks: [
    {
      status: 'approved',
      currentVersionDeployedAt: new Date('2026-09-01T00:00:00.000Z'),
      appListing: {
        slug: 'character-sheet-studio',
        name: 'Character Sheet Studio',
        status: 'approved',
        kind: 'onsite',
        contentRating: 'pg',
        revisionOfId: null,
        icon: null,
      },
    },
  ],
};

/** The row `assertImageVisibleToViewer` returns: a bare image, no post. */
const visibleRow = { id: AUTHORISED_ROW_ID, userId: OWNER_ID, nsfwLevel: 1, postId: null };

const read = () => readImageAppChip({ imageId: IMAGE_ID, ctx, host: HOST });

beforeEach(() => {
  mockResolveStoreVisibilityScope.mockReset();
  mockResolveStoreVisibilityScope.mockResolvedValue('full');
  mockAssertVisible.mockReset();
  mockAssertVisible.mockResolvedValue(visibleRow);
  mockCanSeeMedia.mockReset();
  mockCanSeeMedia.mockResolvedValue(true);
  // Shared singleton, reset per FILE — clear so call counts are per test.
  dbMock.dbRead.image.findUnique.mockReset();
  dbMock.dbRead.image.findUnique.mockResolvedValue({ metadata: { blockPublishedAppId: MARKER } });
  dbMock.dbRead.oauthClient.findUnique.mockReset();
  dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(approvedAppRow);
});

describe('marker present → the chip', () => {
  it('resolves an app-published bare image to the linked chip', async () => {
    await expect(read()).resolves.toEqual({
      slug: 'character-sheet-studio',
      name: 'Character Sheet Studio',
      iconUrl: null,
    });
  });

  it('authorises THIS viewer first, then reads the marker by the AUTHORISED row id', async () => {
    await read();
    expect(mockAssertVisible).toHaveBeenCalledWith({
      id: IMAGE_ID,
      userId: 77,
      isModerator: false,
    });
    expect(mockCanSeeMedia).toHaveBeenCalledWith(ctx, visibleRow);
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledWith({
      where: { id: AUTHORISED_ROW_ID },
      select: { metadata: true },
    });
    // The shared allowlisted app read, for the marker the IMAGE carried.
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledWith(postAppChipQuery(MARKER));
  });

  it('shares the post resolver: a lifecycle-refused app renders unlinked, without icon', async () => {
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({
      ...approvedAppRow,
      appBlocks: [{ ...approvedAppRow.appBlocks[0], status: 'suspended' }],
    });
    await expect(read()).resolves.toEqual({
      slug: null,
      name: 'Character Sheet Studio',
      iconUrl: null,
    });
  });
});

describe('marker absent → null', () => {
  it('returns null and issues NO app read for an image with no marker', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ metadata: { width: 512 } });
    await expect(read()).resolves.toBeNull();
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledTimes(0);
  });

  it('ignores the UPLOADED provenance key — it credits published output only', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ metadata: { blockUploadedAppId: MARKER } });
    await expect(read()).resolves.toBeNull();
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledTimes(0);
  });
});

describe('gates that run before any marker is read', () => {
  it('a viewer the store does not admit costs no image read at all', async () => {
    mockResolveStoreVisibilityScope.mockResolvedValue('none');
    await expect(read()).resolves.toBeNull();
    expect(mockAssertVisible).toHaveBeenCalledTimes(0);
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledTimes(0);
    expect(dbMock.dbRead.oauthClient.findUnique).toHaveBeenCalledTimes(0);
  });

  it('an image this viewer cannot open answers null, without reading its marker', async () => {
    mockAssertVisible.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
    await expect(read()).resolves.toBeNull();
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledTimes(0);
  });

  it('an image whose media image.get would withhold gets no chip either', async () => {
    mockCanSeeMedia.mockResolvedValue(false);
    await expect(read()).resolves.toBeNull();
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledTimes(0);
  });
});

describe('resolver throws → null (fail-open; the page query still answers)', () => {
  it('the marker read throws', async () => {
    dbMock.dbRead.image.findUnique.mockRejectedValue(new Error('replica gone'));
    await expect(read()).resolves.toBeNull();
  });

  it('the visibility check fails with something other than NOT_FOUND', async () => {
    mockAssertVisible.mockRejectedValue(new Error('connection reset'));
    await expect(read()).resolves.toBeNull();
  });

  it('the app read throws', async () => {
    dbMock.dbRead.oauthClient.findUnique.mockRejectedValue(new Error('column does not exist'));
    await expect(read()).resolves.toBeNull();
  });

  it('the scope resolver throws', async () => {
    mockResolveStoreVisibilityScope.mockRejectedValue(new Error('flipt unreachable'));
    await expect(read()).resolves.toBeNull();
  });
});
