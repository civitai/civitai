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

// ---------------------------------------------------------------------------
// SOURCE REPOSITORY (`manifest.repository` → `AppListing.sourceRepoUrl`)
// ---------------------------------------------------------------------------

describe('resolveListingSourceRepo', () => {
  it('returns the NORMALISED link, not the manifest string verbatim', async () => {
    const { resolveListingSourceRepo } = await import('../app-listing-mapper');
    // Equality on this value decides whether an off-site edit re-enters moderator
    // review, so the mapper must emit the canonical form even when the author wrote
    // the clone URL. Three distinct hosts + spellings, so a resolver hardcoded to any
    // one literal fails.
    expect(resolveListingSourceRepo({ repository: 'https://github.com/o/r.git' })).toBe(
      'https://github.com/o/r'
    );
    expect(resolveListingSourceRepo({ repository: '  https://GITLAB.COM/o/r/  ' })).toBe(
      'https://gitlab.com/o/r'
    );
    expect(resolveListingSourceRepo({ repository: 'https://codeberg.org/o/r?x=1' })).toBe(
      'https://codeberg.org/o/r'
    );
  });

  it('absent / blank / non-string ⇒ null (a legacy row can never crash the mapper)', async () => {
    const { resolveListingSourceRepo } = await import('../app-listing-mapper');
    expect(resolveListingSourceRepo({})).toBeNull();
    expect(resolveListingSourceRepo(null)).toBeNull();
    expect(resolveListingSourceRepo(undefined)).toBeNull();
    expect(resolveListingSourceRepo({ repository: '' })).toBeNull();
    expect(resolveListingSourceRepo({ repository: '   ' })).toBeNull();
    expect(resolveListingSourceRepo({ repository: 123 })).toBeNull();
    expect(resolveListingSourceRepo({ repository: { url: 'https://github.com/o/r' } })).toBeNull();
  });

  it('🔴 a stored value the CURRENT rules reject resolves to null, not to a rendered link', async () => {
    const { resolveListingSourceRepo } = await import('../app-listing-mapper');
    // Reachable two ways: a row that predates the validator, or a later tightening of
    // the host allowlist. On a public store page the honest answer is no Source row —
    // never a link the rules in force today would refuse.
    expect(resolveListingSourceRepo({ repository: 'http://github.com/o/r' })).toBeNull();
    expect(resolveListingSourceRepo({ repository: 'https://gist.github.com/o/r' })).toBeNull();
    expect(resolveListingSourceRepo({ repository: 'https://github.com/o/r/tree/main' })).toBeNull();
  });
});

describe('🔴 sourceRepoUrl is wired into BOTH the create AND the re-sync', () => {
  // THE BUG THIS SECTION EXISTS FOR: wiring the field into `mapAppBlockToListing` only
  // sets it once, at the FIRST approve, and never re-reads it. An author who ADDS
  // `repository` in v1.1.0 never sees it; one who REMOVES it keeps serving a dead link.
  // Both builders, both directions.
  const REPO = 'https://github.com/civitai/cool-app';

  it('mapAppBlockToListing includes the normalised link when the column is available', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-mapper');
    const out = mapAppBlockToListing(
      { ...onsite, manifest: { ...(onsite.manifest as object), repository: `${REPO}.git` } },
      { sourceRepoAvailable: true }
    );
    expect(out.sourceRepoUrl).toBe(REPO);
  });

  it('buildListingScalarSync SETS a newly added link on version N+1', async () => {
    const { buildListingScalarSync } = await import('../app-listing-mapper');
    const out = buildListingScalarSync({
      manifest: { name: 'Cool App', repository: `${REPO}/` },
      blockId: 'cool-app',
      category: 'utility',
      sourceRepoAvailable: true,
    });
    expect(out.sourceRepoUrl).toBe(REPO);
  });

  it('buildListingScalarSync CLEARS the link when the key is removed from the manifest', async () => {
    const { buildListingScalarSync } = await import('../app-listing-mapper');
    const out = buildListingScalarSync({
      manifest: { name: 'Cool App' },
      blockId: 'cool-app',
      category: 'utility',
      sourceRepoAvailable: true,
    });
    // PRESENT-and-null, never absent: absent would leave the stale link on the row.
    expect(Object.keys(out)).toContain('sourceRepoUrl');
    expect(out.sourceRepoUrl).toBeNull();
  });

  it('create ⇄ re-sync agree on the same manifest (they cannot drift)', async () => {
    const { buildListingScalarSync, mapAppBlockToListing } = await import('../app-listing-mapper');
    const manifest = { ...(onsite.manifest as object), repository: `${REPO}?tab=readme` };
    const created = mapAppBlockToListing({ ...onsite, manifest }, { sourceRepoAvailable: true });
    const synced = buildListingScalarSync({
      manifest,
      blockId: onsite.blockId,
      category: onsite.category,
      sourceRepoAvailable: true,
    });
    expect(synced.sourceRepoUrl).toBe(created.sourceRepoUrl);
    expect(synced.sourceRepoUrl).toBe(REPO);
  });

  it('🔴 FAIL-SAFE DEFAULT: the key is OMITTED when the flag is absent or false', async () => {
    // `app_listings.source_repo_url` is manual-apply. Naming it in a payload the
    // database cannot satisfy throws P2022 — and BOTH call sites of these builders are
    // log-and-continue, so the throw would present as store listings silently not being
    // minted. Defaulting to omission means a caller that forgets the flag loses the new
    // field, never the pre-existing behaviour.
    const { buildListingScalarSync, mapAppBlockToListing } = await import('../app-listing-mapper');
    const manifest = { name: 'Cool App', repository: REPO };

    const noFlag = buildListingScalarSync({ manifest, blockId: 'cool-app', category: null });
    expect('sourceRepoUrl' in noFlag).toBe(false);
    expect(Object.keys(noFlag).sort()).toEqual(['category', 'description', 'name', 'tagline']);

    const explicitFalse = buildListingScalarSync({
      manifest,
      blockId: 'cool-app',
      category: null,
      sourceRepoAvailable: false,
    });
    expect('sourceRepoUrl' in explicitFalse).toBe(false);

    const created = mapAppBlockToListing({ ...onsite, manifest });
    expect('sourceRepoUrl' in created).toBe(false);
  });
});
