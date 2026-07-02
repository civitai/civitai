import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  validateListingImage,
  type ListingImageMeta,
} from '~/server/schema/blocks/app-listing.schema';

/**
 * App Store Listings (W13 P1) — asset pipeline service tests.
 *
 * Covers: per-asset validation (type/size/aspect/count), the mandatory-asset
 * gate, the screenshot CRUD (cap/reorder/caption/remove re-pack), and the asset
 * backfill orchestration. The standalone-URL verify-runner autogen + the SVG-
 * placeholder screenshot fallback are DISABLED, so the backfill only migrates
 * GENUINE dev-uploaded bundle screenshots and otherwise leaves screenshots empty
 * / cover null (→ the card's category-glyph placeholder); icon generation still
 * runs. Also: cover=first-screenshot, idempotency, no-clobber, dryRun, per-row
 * failed[] isolation. All DB/network/native deps are mocked or injected — no real
 * Prisma/S3/sharp/verify-runner.
 */

const { mockDb, ids } = vi.hoisted(() => ({
  mockDb: {
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      update: vi.fn(async (args: { data: unknown }) => ({ ...(args as object) })),
    },
    image: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appListingScreenshot: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      count: vi.fn(async (..._a: unknown[]): Promise<number> => 0),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      update: vi.fn(async (args: { where: unknown; data: unknown }) => args.data),
      delete: vi.fn(async (..._a: unknown[]) => ({})),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  },
  ids: { n: 0 },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingScreenshotId: () => `apls_test_${++ids.n}`,
}));

const owner = { id: 42, isModerator: false } as never;
const otherUser = { id: 99, isModerator: false } as never;
const mod = { id: 7, isModerator: true } as never;

function resetDb() {
  ids.n = 0;
  mockDb.appListing.findUnique.mockReset().mockResolvedValue(null);
  mockDb.appListing.findMany.mockReset().mockResolvedValue([]);
  mockDb.appListing.update.mockReset().mockResolvedValue({});
  mockDb.image.findUnique.mockReset().mockResolvedValue(null);
  mockDb.appListingScreenshot.findUnique.mockReset().mockResolvedValue(null);
  mockDb.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
  mockDb.appListingScreenshot.count.mockReset().mockResolvedValue(0);
  mockDb.appListingScreenshot.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
  mockDb.appListingScreenshot.createMany.mockReset().mockResolvedValue({ count: 0 });
  mockDb.appListingScreenshot.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
  mockDb.appListingScreenshot.delete.mockReset().mockResolvedValue({});
  mockDb.$transaction.mockReset().mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
}

// ---------------------------------------------------------------------------
// validateListingImage
// ---------------------------------------------------------------------------

describe('validateListingImage', () => {
  const base: ListingImageMeta = { type: 'image', width: 512, height: 512, mimeType: 'image/png', sizeBytes: 100_000 };

  it('accepts a square png icon', () => {
    expect(validateListingImage(base, 'icon').ok).toBe(true);
  });

  it('rejects a non-image (video) asset for every kind', () => {
    const video = { ...base, type: 'video' };
    for (const kind of ['icon', 'cover', 'screenshot'] as const) {
      const r = validateListingImage(video, kind);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects an unsupported mime type', () => {
    const r = validateListingImage({ ...base, mimeType: 'image/gif' }, 'icon');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('unsupported image type') });
  });

  it('rejects an oversized icon (size cap)', () => {
    const r = validateListingImage({ ...base, sizeBytes: 5 * 1024 * 1024 }, 'icon');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('bytes') });
  });

  it('rejects a non-square icon (aspect)', () => {
    const r = validateListingImage({ ...base, width: 512, height: 256 }, 'icon');
    expect(r.ok).toBe(false);
  });

  it('rejects a too-small icon (min dimension)', () => {
    const r = validateListingImage({ ...base, width: 64, height: 64 }, 'icon');
    expect(r.ok).toBe(false);
  });

  it('accepts a 16:9 landscape cover, rejects a portrait cover', () => {
    expect(validateListingImage({ ...base, width: 1280, height: 720 }, 'cover').ok).toBe(true);
    expect(validateListingImage({ ...base, width: 720, height: 1280 }, 'cover').ok).toBe(false);
  });

  it('rejects a cover narrower than the min width', () => {
    const r = validateListingImage({ ...base, width: 480, height: 320 }, 'cover');
    expect(r.ok).toBe(false);
  });

  it('accepts a normal screenshot, rejects a tiny one and a too-wide one', () => {
    expect(validateListingImage({ ...base, width: 1280, height: 720 }, 'screenshot').ok).toBe(true);
    expect(validateListingImage({ ...base, width: 200, height: 200 }, 'screenshot').ok).toBe(false);
    expect(validateListingImage({ ...base, width: 2600, height: 400 }, 'screenshot').ok).toBe(false);
  });

  it('rejects unknown/zero dimensions', () => {
    expect(validateListingImage({ ...base, width: null, height: null }, 'icon').ok).toBe(false);
    expect(validateListingImage({ ...base, width: 0, height: 0 }, 'cover').ok).toBe(false);
  });

  it('skips size/mime checks when those fields are absent (older Image rows)', () => {
    const r = validateListingImage({ type: 'image', width: 512, height: 512 }, 'icon');
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mandatory-asset gate
// ---------------------------------------------------------------------------

describe('checkListingAssetsComplete / assertListingAssetsComplete', () => {
  it('is complete only with icon AND cover AND >=1 screenshot', async () => {
    const { checkListingAssetsComplete } = await import('../app-listing-assets.service');
    expect(checkListingAssetsComplete({ iconId: 1, coverId: 2, screenshotCount: 3 })).toEqual({
      complete: true,
    });
  });

  it('reports every missing combination', async () => {
    const { checkListingAssetsComplete } = await import('../app-listing-assets.service');
    expect(checkListingAssetsComplete({ iconId: null, coverId: 2, screenshotCount: 1 })).toEqual({
      complete: false,
      missing: ['icon'],
    });
    expect(checkListingAssetsComplete({ iconId: 1, coverId: null, screenshotCount: 1 })).toEqual({
      complete: false,
      missing: ['cover'],
    });
    expect(checkListingAssetsComplete({ iconId: 1, coverId: 2, screenshotCount: 0 })).toEqual({
      complete: false,
      missing: ['screenshots'],
    });
    expect(checkListingAssetsComplete({ iconId: null, coverId: null, screenshotCount: 0 })).toEqual({
      complete: false,
      missing: ['icon', 'cover', 'screenshots'],
    });
  });

  it('assert throws with the missing list, passes when complete', async () => {
    const { assertListingAssetsComplete } = await import('../app-listing-assets.service');
    expect(() => assertListingAssetsComplete({ iconId: null, coverId: null, screenshotCount: 0 })).toThrow(
      /icon, cover, screenshots/
    );
    expect(() => assertListingAssetsComplete({ iconId: 1, coverId: 2, screenshotCount: 1 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('seededHue is deterministic + in range', async () => {
    const { seededHue } = await import('../app-listing-assets.service');
    expect(seededHue('cool-app')).toBe(seededHue('cool-app'));
    expect(seededHue('cool-app')).toBeGreaterThanOrEqual(0);
    expect(seededHue('cool-app')).toBeLessThan(360);
    expect(seededHue('a')).not.toBe(seededHue('b'));
  });

  it('appInitial picks first alphanumeric, uppercased, falls back to slug/?', async () => {
    const { appInitial } = await import('../app-listing-assets.service');
    expect(appInitial('Cool App', 'slug')).toBe('C');
    expect(appInitial('  ', 'slug')).toBe('S');
    expect(appInitial('', '')).toBe('?');
    expect(appInitial('123abc', 'x')).toBe('1');
  });

  it('pickLogoPrefillUrl normalises http(s), rejects otherwise', async () => {
    const { pickLogoPrefillUrl } = await import('../app-listing-assets.service');
    expect(pickLogoPrefillUrl('  https://ex.com/a.png ')).toBe('https://ex.com/a.png');
    expect(pickLogoPrefillUrl('ftp://ex.com/a')).toBeNull();
    expect(pickLogoPrefillUrl('javascript:alert(1)')).toBeNull();
    expect(pickLogoPrefillUrl(null)).toBeNull();
    expect(pickLogoPrefillUrl(undefined)).toBeNull();
  });

  it('SVG builders emit valid-looking svg with the initial + escaped name', async () => {
    const { buildPlaceholderIconSvg, buildPlaceholderCoverSvg } = await import(
      '../app-listing-assets.service'
    );
    const icon = buildPlaceholderIconSvg({ slug: 'cool-app', category: 'games', name: 'Cool App' });
    expect(icon).toContain('<svg');
    expect(icon).toContain('>C<');
    const cover = buildPlaceholderCoverSvg({ slug: 'x', category: null, name: 'A & B <x>' });
    expect(cover).toContain('<svg');
    expect(cover).toContain('A &amp; B &lt;x&gt;');
    expect(cover).not.toContain('<x>');
  });

  it('chooseScreenshotSource: existing → migrate(real only) → none', async () => {
    const { chooseScreenshotSource } = await import('../app-listing-assets.service');
    const base = {
      id: 'apl_1', kind: 'onsite', slug: 's', name: 'n', category: null, contentRating: null, userId: 1,
      iconId: null, coverId: null, appBlockId: 'ab_1', appBlockScreenshots: null,
      screenshots: [] as { imageId: number | null; order: number }[],
    };
    // existing rows → nothing to do.
    expect(chooseScreenshotSource({ ...base, screenshots: [{ imageId: 5, order: 0 }] })).toEqual({
      mode: 'existing',
    });
    // genuine dev-uploaded bundle screenshots → migrate them.
    expect(
      chooseScreenshotSource({ ...base, appBlockScreenshots: [{ key: 'k1' }, { key: 'k2' }] })
    ).toEqual({ mode: 'migrate', count: 2 });
    // autogenerated:true skeleton captures are NOT real screenshots → skipped;
    // migrate count reflects only the genuine dev upload.
    expect(
      chooseScreenshotSource({
        ...base,
        appBlockScreenshots: [{ key: 'skeleton', autogenerated: true }, { key: 'real' }],
      })
    ).toEqual({ mode: 'migrate', count: 1 });
    // ONLY skeleton autogen captures → nothing real to migrate → none.
    expect(
      chooseScreenshotSource({
        ...base,
        appBlockScreenshots: [{ key: 'skeleton', autogenerated: true }],
      })
    ).toEqual({ mode: 'none' });
    // on-site with no bundle screenshots → none (autogen removed).
    expect(chooseScreenshotSource({ ...base, appBlockScreenshots: [] })).toEqual({ mode: 'none' });
    // off-site → none (placeholder-screenshot fallback removed).
    expect(
      chooseScreenshotSource({ ...base, kind: 'offsite', appBlockId: null })
    ).toEqual({ mode: 'none' });
  });

  it('realDevBundleScreenshots keeps only string-keyed, non-autogenerated records', async () => {
    const { realDevBundleScreenshots } = await import('../app-listing-assets.service');
    expect(realDevBundleScreenshots(null)).toEqual([]);
    expect(realDevBundleScreenshots('nope')).toEqual([]);
    expect(
      realDevBundleScreenshots([
        { key: 'a' },
        { key: 'b', autogenerated: true },
        { key: 123 },
        { nope: true },
        { key: 'c', autogenerated: false },
      ])
    ).toEqual([{ key: 'a' }, { key: 'c', autogenerated: false }]);
  });
});

// ---------------------------------------------------------------------------
// creator asset management (mocked DB)
// ---------------------------------------------------------------------------

describe('screenshot CRUD', () => {
  beforeEach(resetDb);

  const listingRow = {
    id: 'apl_1', kind: 'onsite', slug: 's', name: 'n', category: null, contentRating: null, userId: 42,
    iconId: null, coverId: null,
  };
  // A safe-to-publish image: scan-complete + PG (NsfwLevel.PG === 1).
  const validScreenshotImage = {
    id: 500, userId: 42, type: 'image', width: 1280, height: 720, mimeType: 'image/png',
    metadata: { size: 100_000 }, ingestion: 'Scanned', nsfwLevel: 1,
  };

  it('addScreenshot appends at the next order and enforces owner + validation', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.image.findUnique.mockResolvedValue(validScreenshotImage);
    mockDb.appListingScreenshot.findMany.mockResolvedValue([{ order: 2 }]);
    mockDb.appListingScreenshot.count.mockResolvedValue(3);
    const { addListingScreenshot } = await import('../app-listing-assets.service');
    const res = await addListingScreenshot({ listingId: 'apl_1', imageId: 500 }, owner);
    expect(res.order).toBe(3);
    expect(mockDb.appListingScreenshot.create).toHaveBeenCalledTimes(1);
    const arg = (mockDb.appListingScreenshot.create.mock.calls[0][0] as { data: { order: number } }).data;
    expect(arg.order).toBe(3);
  });

  it('addScreenshot rejects a non-owner non-mod', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    const { addListingScreenshot } = await import('../app-listing-assets.service');
    await expect(addListingScreenshot({ listingId: 'apl_1', imageId: 500 }, otherUser)).rejects.toThrow(
      /do not own/
    );
  });

  it('addScreenshot enforces the ≤8 cap (rejects the 9th)', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.image.findUnique.mockResolvedValue(validScreenshotImage);
    mockDb.appListingScreenshot.findMany.mockResolvedValue([{ order: 7 }]);
    mockDb.appListingScreenshot.count.mockResolvedValue(8);
    const { addListingScreenshot } = await import('../app-listing-assets.service');
    await expect(addListingScreenshot({ listingId: 'apl_1', imageId: 500 }, owner)).rejects.toThrow(
      /at most 8/
    );
    expect(mockDb.appListingScreenshot.create).not.toHaveBeenCalled();
  });

  it('addScreenshot rejects an invalid image (aspect) before writing', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.image.findUnique.mockResolvedValue({ ...validScreenshotImage, width: 100, height: 100 });
    const { addListingScreenshot } = await import('../app-listing-assets.service');
    await expect(addListingScreenshot({ listingId: 'apl_1', imageId: 500 }, owner)).rejects.toThrow();
    expect(mockDb.appListingScreenshot.create).not.toHaveBeenCalled();
  });

  it('setIcon rejects a non-square image and accepts a square one', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    const { setListingIcon } = await import('../app-listing-assets.service');
    mockDb.image.findUnique.mockResolvedValue({ id: 9, userId: 42, type: 'image', width: 512, height: 200, mimeType: 'image/png', metadata: {}, ingestion: 'Scanned', nsfwLevel: 1 });
    await expect(setListingIcon({ listingId: 'apl_1', imageId: 9 }, owner)).rejects.toThrow();
    mockDb.image.findUnique.mockResolvedValue({ id: 9, userId: 42, type: 'image', width: 512, height: 512, mimeType: 'image/png', metadata: {}, ingestion: 'Scanned', nsfwLevel: 1 });
    const res = await setListingIcon({ listingId: 'apl_1', imageId: 9 }, owner);
    expect(res.iconId).toBe(9);
    expect(mockDb.appListing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { iconId: 9 } })
    );
  });

  it('reorderScreenshots requires an exact permutation and writes contiguous orders', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.appListingScreenshot.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const { reorderListingScreenshots } = await import('../app-listing-assets.service');
    // Wrong set → reject.
    await expect(
      reorderListingScreenshots({ listingId: 'apl_1', orderedIds: ['a', 'b'] }, owner)
    ).rejects.toThrow(/exactly/);
    // Correct permutation → 3 contiguous updates.
    const res = await reorderListingScreenshots(
      { listingId: 'apl_1', orderedIds: ['c', 'a', 'b'] },
      owner
    );
    expect(res.reordered).toBe(3);
    expect(mockDb.appListingScreenshot.update).toHaveBeenCalledTimes(3);
    const orders = mockDb.appListingScreenshot.update.mock.calls.map(
      (c) => (c[0] as { where: { id: string }; data: { order: number } })
    );
    expect(orders.map((o) => [o.where.id, o.data.order])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('updateScreenshotCaption enforces ownership via the parent listing', async () => {
    mockDb.appListingScreenshot.findUnique.mockResolvedValue({
      id: 'a', appListing: { userId: 42 },
    });
    const { updateListingScreenshotCaption } = await import('../app-listing-assets.service');
    await updateListingScreenshotCaption({ screenshotId: 'a', caption: 'hi' }, owner);
    expect(mockDb.appListingScreenshot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a' }, data: { caption: 'hi' } })
    );
    // non-owner rejected
    await expect(
      updateListingScreenshotCaption({ screenshotId: 'a', caption: 'x' }, otherUser)
    ).rejects.toThrow(/do not own/);
  });

  it('removeScreenshot deletes then re-packs remaining orders contiguously', async () => {
    mockDb.appListingScreenshot.findUnique.mockResolvedValue({
      id: 'b', appListingId: 'apl_1', appListing: { userId: 42 },
    });
    mockDb.appListingScreenshot.findMany.mockResolvedValue([{ id: 'a' }, { id: 'c' }]);
    const { removeListingScreenshot } = await import('../app-listing-assets.service');
    const res = await removeListingScreenshot({ screenshotId: 'b' }, owner);
    expect(res.removed).toBe('b');
    expect(mockDb.appListingScreenshot.delete).toHaveBeenCalledWith({ where: { id: 'b' } });
    const orders = mockDb.appListingScreenshot.update.mock.calls.map(
      (c) => c[0] as { where: { id: string }; data: { order: number } }
    );
    expect(orders.map((o) => [o.where.id, o.data.order])).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
  });

  it('setIcon rejects an Image owned by a DIFFERENT user (confused-deputy IDOR)', async () => {
    // Caller owns the LISTING but attaches an Image belonging to someone else.
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.image.findUnique.mockResolvedValue({
      id: 9, userId: 99, type: 'image', width: 512, height: 512, mimeType: 'image/png',
      metadata: {}, ingestion: 'Scanned', nsfwLevel: 1,
    });
    const { setListingIcon } = await import('../app-listing-assets.service');
    await expect(setListingIcon({ listingId: 'apl_1', imageId: 9 }, owner)).rejects.toThrow(
      /do not own this image/
    );
    expect(mockDb.appListing.update).not.toHaveBeenCalled();
  });

  it('addScreenshot rejects an Image owned by a DIFFERENT user (confused-deputy IDOR)', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.image.findUnique.mockResolvedValue({ ...validScreenshotImage, userId: 99 });
    const { addListingScreenshot } = await import('../app-listing-assets.service');
    await expect(
      addListingScreenshot({ listingId: 'apl_1', imageId: 500 }, owner)
    ).rejects.toThrow(/do not own this image/);
    expect(mockDb.appListingScreenshot.create).not.toHaveBeenCalled();
  });

  it('setIcon rejects an Image that is not scan-complete (ingestion !== Scanned)', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.image.findUnique.mockResolvedValue({
      id: 9, userId: 42, type: 'image', width: 512, height: 512, mimeType: 'image/png',
      metadata: {}, ingestion: 'Pending', nsfwLevel: 1,
    });
    const { setListingIcon } = await import('../app-listing-assets.service');
    await expect(setListingIcon({ listingId: 'apl_1', imageId: 9 }, owner)).rejects.toThrow(
      /not approved for publishing/
    );
    expect(mockDb.appListing.update).not.toHaveBeenCalled();
  });

  it('addScreenshot rejects an Image above the listing content rating (null rating → SFW)', async () => {
    // Listing has no contentRating → fail-closed PG ceiling; image is R (NsfwLevel.R === 4).
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.image.findUnique.mockResolvedValue({ ...validScreenshotImage, nsfwLevel: 4 });
    const { addListingScreenshot } = await import('../app-listing-assets.service');
    await expect(
      addListingScreenshot({ listingId: 'apl_1', imageId: 500 }, owner)
    ).rejects.toThrow(/exceeds the listing/);
    expect(mockDb.appListingScreenshot.create).not.toHaveBeenCalled();
  });

  it('addScreenshot accepts a mature image when the listing rating allows it (r → R)', async () => {
    mockDb.appListing.findUnique.mockResolvedValue({ ...listingRow, contentRating: 'r' });
    mockDb.image.findUnique.mockResolvedValue({ ...validScreenshotImage, nsfwLevel: 4 });
    mockDb.appListingScreenshot.findMany.mockResolvedValue([]);
    mockDb.appListingScreenshot.count.mockResolvedValue(0);
    const { addListingScreenshot } = await import('../app-listing-assets.service');
    const res = await addListingScreenshot({ listingId: 'apl_1', imageId: 500 }, owner);
    expect(res.order).toBe(0);
    expect(mockDb.appListingScreenshot.create).toHaveBeenCalledTimes(1);
  });

  it('reorderScreenshots rejects a same-length but FOREIGN id set', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(listingRow);
    mockDb.appListingScreenshot.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const { reorderListingScreenshots } = await import('../app-listing-assets.service');
    // Same length (3) but 'z' is not a member → reject (not just the length case).
    await expect(
      reorderListingScreenshots({ listingId: 'apl_1', orderedIds: ['a', 'b', 'z'] }, owner)
    ).rejects.toThrow(/exactly/);
    expect(mockDb.appListingScreenshot.update).not.toHaveBeenCalled();
  });

  it('removeScreenshot rejects a non-owner of the parent listing', async () => {
    mockDb.appListingScreenshot.findUnique.mockResolvedValue({
      id: 'b', appListingId: 'apl_1', appListing: { userId: 42 },
    });
    const { removeListingScreenshot } = await import('../app-listing-assets.service');
    await expect(removeListingScreenshot({ screenshotId: 'b' }, otherUser)).rejects.toThrow(
      /do not own/
    );
    expect(mockDb.appListingScreenshot.delete).not.toHaveBeenCalled();
  });

  it('completeness ignores a null-imageId screenshot row (deleted Image → SetNull)', async () => {
    mockDb.appListing.findUnique.mockResolvedValue({ ...listingRow, iconId: 1, coverId: 2 });
    // One screenshot row, but its Image was deleted (imageId → null).
    mockDb.appListingScreenshot.findMany.mockResolvedValue([
      { id: 's1', imageId: null, order: 0, caption: null },
    ]);
    const { getListingAssets } = await import('../app-listing-assets.service');
    const res = await getListingAssets({ listingId: 'apl_1' }, owner);
    expect(res.completeness).toEqual({ complete: false, missing: ['screenshots'] });
  });

  it('getAssets returns assets + a completeness verdict (mod override reads any listing)', async () => {
    mockDb.appListing.findUnique.mockResolvedValue({ ...listingRow, userId: 111, iconId: 1, coverId: 2 });
    mockDb.appListingScreenshot.findMany.mockResolvedValue([
      { id: 's1', imageId: 10, order: 0, caption: null },
    ]);
    const { getListingAssets } = await import('../app-listing-assets.service');
    const res = await getListingAssets({ listingId: 'apl_1' }, mod);
    expect(res.completeness).toEqual({ complete: true });
    expect(res.screenshots).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// placeholder backfill (injected deps + mocked DB)
// ---------------------------------------------------------------------------

describe('backfillListingAssets', () => {
  beforeEach(resetDb);

  function makeDeps() {
    return {
      migrateBlockScreenshots: vi.fn(async () => [201, 202]),
      autogenScreenshot: vi.fn(async () => 301 as number | null),
      generatePlaceholderScreenshot: vi.fn(async () => 401),
      generateIcon: vi.fn(async () => 501),
    };
  }

  function row(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'apl_x', kind: 'onsite', slug: 's', name: 'n', category: 'games', userId: 42,
      iconId: null, coverId: null, appBlockId: 'ab_x',
      appBlock: { screenshots: null }, screenshots: [],
      ...over,
    };
  }

  it('migrates AppBlock.screenshots → Image rows, sets cover=first, generates icon', async () => {
    mockDb.appListing.findMany.mockResolvedValue([
      row({ appBlock: { screenshots: [{ key: 'k1' }, { key: 'k2' }] } }),
    ]);
    const deps = makeDeps();
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);

    expect(deps.migrateBlockScreenshots).toHaveBeenCalledTimes(1);
    expect(deps.autogenScreenshot).not.toHaveBeenCalled();
    expect(deps.generatePlaceholderScreenshot).not.toHaveBeenCalled();
    expect(deps.generateIcon).toHaveBeenCalledTimes(1);
    expect(res.screenshotsCreated).toBe(2);
    expect(res.bySource.migrated).toBe(2);
    expect(res.coversSet).toBe(1);
    expect(res.iconsCreated).toBe(1);
    // createMany got the 2 migrated image ids in order.
    const createManyArg = mockDb.appListingScreenshot.createMany.mock.calls[0][0] as {
      data: { imageId: number; order: number }[];
    };
    expect(createManyArg.data.map((d) => [d.imageId, d.order])).toEqual([
      [201, 0],
      [202, 1],
    ]);
    // cover set to first migrated image.
    expect(mockDb.appListing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { coverId: 201 } })
    );
    expect(mockDb.appListing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { iconId: 501 } })
    );
  });

  it('on-site with NO bundle screenshots → leaves screenshots empty + cover null, still generates icon', async () => {
    mockDb.appListing.findMany.mockResolvedValue([row({ appBlock: { screenshots: [] } })]);
    const deps = makeDeps();
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);
    // autogen + placeholder are disabled — no screenshot produced.
    expect(deps.migrateBlockScreenshots).not.toHaveBeenCalled();
    expect(deps.autogenScreenshot).not.toHaveBeenCalled();
    expect(deps.generatePlaceholderScreenshot).not.toHaveBeenCalled();
    expect(mockDb.appListingScreenshot.createMany).not.toHaveBeenCalled();
    expect(res.screenshotsCreated).toBe(0);
    expect(res.bySource).toEqual({ migrated: 0, autogen: 0, placeholder: 0 });
    // No screenshot → cover stays null (→ card glyph placeholder).
    expect(res.coversSet).toBe(0);
    // Icon generation STILL runs.
    expect(deps.generateIcon).toHaveBeenCalledTimes(1);
    expect(res.iconsCreated).toBe(1);
    expect(res.processed).toBe(1);
    expect(mockDb.appListing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { iconId: 501 } })
    );
    // cover was NEVER set.
    expect(mockDb.appListing.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ coverId: expect.anything() }) })
    );
  });

  it('on-site whose ONLY bundle screenshots are skeleton autogen captures → migrates nothing (empty + cover null)', async () => {
    mockDb.appListing.findMany.mockResolvedValue([
      row({ appBlock: { screenshots: [{ key: 'skeleton', autogenerated: true }] } }),
    ]);
    const deps = makeDeps();
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);
    expect(deps.migrateBlockScreenshots).not.toHaveBeenCalled();
    expect(mockDb.appListingScreenshot.createMany).not.toHaveBeenCalled();
    expect(res.screenshotsCreated).toBe(0);
    expect(res.coversSet).toBe(0);
    expect(res.iconsCreated).toBe(1); // icon still generated
  });

  it('on-site with a MIX migrates ONLY the genuine dev screenshot (skeleton filtered)', async () => {
    mockDb.appListing.findMany.mockResolvedValue([
      row({ appBlock: { screenshots: [{ key: 'skeleton', autogenerated: true }, { key: 'real' }] } }),
    ]);
    const deps = makeDeps();
    // migrateBlockScreenshots receives only the filtered real record.
    deps.migrateBlockScreenshots.mockResolvedValue([201]);
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);
    expect(deps.migrateBlockScreenshots).toHaveBeenCalledTimes(1);
    const migrateArg = deps.migrateBlockScreenshots.mock.calls[0][0] as {
      blockScreenshots: { key: string }[];
    };
    expect(migrateArg.blockScreenshots).toEqual([{ key: 'real' }]);
    expect(res.bySource.migrated).toBe(1);
    expect(res.screenshotsCreated).toBe(1);
    expect(res.coversSet).toBe(1); // cover = the migrated screenshot
  });

  it('off-site listing (no appBlock) → no screenshot, cover null, icon generated', async () => {
    mockDb.appListing.findMany.mockResolvedValue([
      row({ kind: 'offsite', appBlockId: null, appBlock: null }),
    ]);
    const deps = makeDeps();
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);
    expect(deps.migrateBlockScreenshots).not.toHaveBeenCalled();
    expect(deps.autogenScreenshot).not.toHaveBeenCalled();
    expect(deps.generatePlaceholderScreenshot).not.toHaveBeenCalled();
    expect(res.screenshotsCreated).toBe(0);
    expect(res.coversSet).toBe(0);
    expect(res.iconsCreated).toBe(1);
  });

  it('is idempotent — an already-complete listing is skipped, no deps called', async () => {
    mockDb.appListing.findMany.mockResolvedValue([
      row({ iconId: 1, coverId: 2, screenshots: [{ imageId: 10, order: 0 }] }),
    ]);
    const deps = makeDeps();
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);
    expect(res.skippedComplete).toBe(1);
    expect(res.processed).toBe(0);
    expect(deps.generateIcon).not.toHaveBeenCalled();
    expect(mockDb.appListingScreenshot.createMany).not.toHaveBeenCalled();
  });

  it('does not clobber creator assets — only fills the missing ones', async () => {
    // Has an icon + screenshots already, but no cover. Only the cover is filled.
    mockDb.appListing.findMany.mockResolvedValue([
      row({ iconId: 77, coverId: null, screenshots: [{ imageId: 88, order: 0 }] }),
    ]);
    const deps = makeDeps();
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);
    expect(deps.generateIcon).not.toHaveBeenCalled(); // icon untouched
    expect(mockDb.appListingScreenshot.createMany).not.toHaveBeenCalled(); // screenshots untouched
    expect(res.coversSet).toBe(1);
    expect(mockDb.appListing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { coverId: 88 } }) // cover = existing first screenshot
    );
    expect(res.iconsCreated).toBe(0);
  });

  it('dryRun computes counts and writes nothing / calls no deps', async () => {
    mockDb.appListing.findMany.mockResolvedValue([
      row({ appBlock: { screenshots: [{ key: 'k1' }] } }),
    ]);
    const deps = makeDeps();
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({ dryRun: true }, deps);
    expect(res.dryRun).toBe(true);
    expect(res.processed).toBe(1);
    expect(res.screenshotsCreated).toBe(1);
    expect(res.iconsCreated).toBe(1);
    expect(res.coversSet).toBe(1);
    expect(deps.migrateBlockScreenshots).not.toHaveBeenCalled();
    expect(deps.generateIcon).not.toHaveBeenCalled();
    expect(mockDb.appListingScreenshot.createMany).not.toHaveBeenCalled();
    expect(mockDb.appListing.update).not.toHaveBeenCalled();
  });

  it('isolates a per-row failure into failed[] and continues the batch', async () => {
    // Both rows have a genuine dev screenshot to migrate; the first row's
    // migrate throws (poison), the second succeeds.
    mockDb.appListing.findMany.mockResolvedValue([
      row({ id: 'apl_bad', appBlock: { screenshots: [{ key: 'k1' }] } }),
      row({ id: 'apl_ok', appBlock: { screenshots: [{ key: 'k2' }] } }),
    ]);
    const deps = makeDeps();
    deps.migrateBlockScreenshots
      .mockRejectedValueOnce(new Error('minio exploded'))
      .mockResolvedValue([201]);
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    const res = await backfillListingAssets({}, deps);
    expect(res.failed).toEqual([{ listingId: 'apl_bad', error: 'minio exploded' }]);
    expect(res.processed).toBe(1); // the second row still processed
  });

  it('forwards limit as take to findMany', async () => {
    mockDb.appListing.findMany.mockResolvedValue([]);
    const { backfillListingAssets } = await import('../app-listing-assets.service');
    await backfillListingAssets({ limit: 5 }, makeDeps());
    const arg = mockDb.appListing.findMany.mock.calls[0][0] as { take?: number; where: unknown };
    expect(arg.take).toBe(5);
    expect(arg.where).toEqual({ status: 'approved' });
  });
});
