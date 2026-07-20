import { describe, expect, it, vi } from 'vitest';

/**
 * App Store Listings (W13) — the SHARED AppBlock→AppListing mapper.
 *
 * This is the single source of truth for the listing shape, imported by BOTH
 * `app-listing-backfill.service` and `publish-request.service.approveRequest`.
 * These tests pin the exact create-payload shape so the two call sites can never
 * silently drift. `newAppListingId` is stubbed deterministic so assertions don't
 * depend on the ULID.
 */

const { ids } = vi.hoisted(() => ({ ids: { n: 0 } }));

vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_test_${++ids.n}`,
}));

type Ab = {
  id: string;
  blockId: string;
  manifest: unknown;
  contentRating: string;
  category: string | null;
  featured: boolean;
  featuredOrder: number | null;
  externalUrl: string | null;
  app: { userId: number } | null;
};

const onsite: Ab = {
  id: 'ab_1',
  blockId: 'cool-app',
  manifest: { name: 'Cool App', description: 'A cool app' },
  contentRating: 'pg',
  category: 'utility',
  featured: true,
  featuredOrder: 2,
  externalUrl: null,
  app: { userId: 42 },
};

const offsite: Ab = {
  id: 'ab_2',
  blockId: 'ext-app',
  manifest: { name: 'Ext App' },
  contentRating: 'g',
  category: null,
  featured: false,
  featuredOrder: null,
  externalUrl: 'https://ext.example.com/launch',
  app: { userId: 7 },
};

describe('mapAppBlockToListing (shared)', () => {
  it('maps an on-site AppBlock to the full approved-listing payload', async () => {
    ids.n = 0;
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    expect(mapAppBlockToListing(onsite)).toEqual({
      id: 'apl_test_1',
      kind: 'onsite',
      slug: 'cool-app',
      name: 'Cool App',
      description: 'A cool app',
      iconId: null,
      coverId: null,
      category: 'utility',
      status: 'approved',
      contentRating: 'pg',
      externalUrl: null,
      connectClientId: null,
      appBlockId: 'ab_1',
      featured: true,
      featuredOrder: 2,
      userId: 42,
    });
  });

  it('maps an external-link AppBlock to an off-site listing (externalUrl copied, no connectClientId)', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    const data = mapAppBlockToListing(offsite);
    expect(data.kind).toBe('offsite');
    expect(data.externalUrl).toBe('https://ext.example.com/launch');
    expect(data.connectClientId).toBeNull();
    expect(data.appBlockId).toBe('ab_2');
  });

  it('always yields status=approved (the store read filter) for an approved AppBlock', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    expect(mapAppBlockToListing(onsite).status).toBe('approved');
    expect(mapAppBlockToListing(offsite).status).toBe('approved');
  });

  it('falls back to slug for name and null description when the manifest lacks them', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    const data = mapAppBlockToListing({ ...onsite, manifest: {} });
    expect(data.name).toBe('cool-app');
    expect(data.description).toBeNull();
  });

  it('throws on a null owner (misuse — the callers guard this)', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    expect(() => mapAppBlockToListing({ ...onsite, app: null })).toThrow(/no resolvable owner/);
  });
});

describe('resolveListingName / resolveListingDescription (shared)', () => {
  it('resolveListingName prefers a trimmed manifest.name, else the blockId', async () => {
    const { resolveListingName } = await import('../app-listing-mapper');
    expect(resolveListingName({ name: '  Cool App  ' }, 'slug')).toBe('Cool App');
    expect(resolveListingName({ name: '  ' }, 'slug')).toBe('slug');
    expect(resolveListingName({}, 'slug')).toBe('slug');
    expect(resolveListingName(null, 'slug')).toBe('slug');
    expect(resolveListingName({ name: 123 }, 'slug')).toBe('slug');
  });

  it('resolveListingDescription returns the trimmed string or null (blank => null)', async () => {
    const { resolveListingDescription } = await import('../app-listing-mapper');
    expect(resolveListingDescription({ description: '  hi  ' })).toBe('hi');
    expect(resolveListingDescription({ description: '   ' })).toBeNull();
    expect(resolveListingDescription({})).toBeNull();
    expect(resolveListingDescription(null)).toBeNull();
  });
});
