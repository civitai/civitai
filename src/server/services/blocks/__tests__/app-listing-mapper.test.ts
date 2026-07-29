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
  manifest: { name: 'Cool App', description: 'A cool app', tagline: 'The coolest app' },
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
      tagline: 'The coolest app',
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

  it('falls back to slug for name and null description/tagline when the manifest lacks them', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    const data = mapAppBlockToListing({ ...onsite, manifest: {} });
    expect(data.name).toBe('cool-app');
    expect(data.description).toBeNull();
    expect(data.tagline).toBeNull();
  });

  it('maps a whitespace-only manifest tagline to null (never a blank store tagline)', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    const data = mapAppBlockToListing({
      ...onsite,
      manifest: { name: 'Cool App', tagline: '   \n ' },
    });
    expect(data.tagline).toBeNull();
  });

  it('trims a manifest tagline before it reaches the listing', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    const data = mapAppBlockToListing({
      ...onsite,
      manifest: { name: 'Cool App', tagline: '  Padded pitch  ' },
    });
    expect(data.tagline).toBe('Padded pitch');
  });

  it('carries the tagline onto an off-site (external-link) listing too', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    const data = mapAppBlockToListing({
      ...offsite,
      manifest: { name: 'Ext App', tagline: 'Elsewhere' },
    });
    expect(data.kind).toBe('offsite');
    expect(data.tagline).toBe('Elsewhere');
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

  it('resolveListingTagline returns the trimmed string or null (blank/absent/non-string => null)', async () => {
    const { resolveListingTagline } = await import('../app-listing-mapper');
    expect(resolveListingTagline({ tagline: '  one-liner  ' })).toBe('one-liner');
    expect(resolveListingTagline({ tagline: '   ' })).toBeNull();
    expect(resolveListingTagline({})).toBeNull();
    expect(resolveListingTagline(null)).toBeNull();
    expect(resolveListingTagline({ tagline: 123 })).toBeNull();
  });
});

describe('buildListingScalarSync (approve-time copy re-sync)', () => {
  it('returns EXACTLY the manifest-governed scalar set — nothing curated', async () => {
    const { buildListingScalarSync } = await import('../app-listing-mapper');
    const out = buildListingScalarSync({
      manifest: { name: ' New Name ', description: ' New desc ', tagline: ' New pitch ' },
      blockId: 'cool-app',
      category: 'utility',
    });
    // The exact key set matters: anything extra here would be written by the
    // approve re-sync and could clobber a curated/mod-owned column.
    expect(Object.keys(out).sort()).toEqual(['category', 'description', 'name', 'tagline']);
    expect(out).toEqual({
      name: 'New Name',
      description: 'New desc',
      tagline: 'New pitch',
      category: 'utility',
    });
  });

  it('agrees with mapAppBlockToListing for the same manifest (create ⇄ re-sync cannot drift)', async () => {
    const { buildListingScalarSync, mapAppBlockToListing } = await import('../app-listing-mapper');
    const created = mapAppBlockToListing(onsite);
    const synced = buildListingScalarSync({
      manifest: onsite.manifest,
      blockId: onsite.blockId,
      category: onsite.category,
    });
    expect(synced).toEqual({
      name: created.name,
      description: created.description ?? null,
      tagline: created.tagline ?? null,
      category: created.category ?? null,
    });
  });

  it('takes category from the caller (AppBlock.category), NOT the manifest — mod curation survives', async () => {
    const { buildListingScalarSync } = await import('../app-listing-mapper');
    const out = buildListingScalarSync({
      // The manifest says "games"; a moderator curated "analytics" onto the
      // AppBlock, and that is what the caller passes.
      manifest: { name: 'Cool App', category: 'games' },
      blockId: 'cool-app',
      category: 'analytics',
    });
    expect(out.category).toBe('analytics');
  });

  it('nulls a cleared description/tagline and falls back to the slug for a missing name', async () => {
    const { buildListingScalarSync } = await import('../app-listing-mapper');
    expect(
      buildListingScalarSync({ manifest: {}, blockId: 'cool-app', category: null })
    ).toEqual({ name: 'cool-app', description: null, tagline: null, category: null });
  });
});
