/**
 * The `listing@v1` stream (`listing-stream.ts`, `apps/app-index-go/LISTINGS-READ-MODEL.md`): the
 * field mapping, the switch that keeps it dark, the relay gate, and the rating exclusion.
 *
 * Fixture values are pairwise distinct, so a mapping that reads the wrong field changes a literal.
 */
import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type { Audience } from '~/server/registry-adapter/audience';
import {
  ANONYMOUS_AUDIENCE,
  SERVICE_AUDIENCE,
  audienceOf,
  withListings,
} from '~/server/registry-adapter/audience';
import { registryListingMedia } from '~/server/registry-adapter/catalog-media';
import type {
  CatalogListing,
  CatalogReadDeps,
  ListingExtras,
  ListingStoreFields,
} from '~/server/registry-adapter/catalog-source';
import { listingFromCard, readCatalog } from '~/server/registry-adapter/catalog-source';
import { JSON_SCHEMA_DIALECT } from '~/server/registry-adapter/collection-schema';
import { createPollingAdapter } from '~/server/registry-adapter/cursor';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { buildEntities, readableBy, servedSchemas } from '~/server/registry-adapter/entities';
import { newValidator } from '~/server/registry-adapter/json-schema';
import { gateListings } from '~/server/registry-adapter/listing-stream';
import type { AdapterContext, Entity } from '~/server/registry-adapter/protocol';
import { LISTING_SCHEMA_DOCUMENT } from '~/server/registry-adapter/schemas';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import {
  LISTING_COVER_WIDTH,
  LISTING_SCREENSHOT_WIDTH,
  listingCoverUrl,
  listingMediaEdgeUrl,
} from '~/server/services/blocks/listing-media-url';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

const LISTING = 'urn:schema:apps.civitai.com:listing@v1';
const APP = 'urn:schema:apps.civitai.com:app@v1';
const BASE = { baseUrl: 'https://site.example' };

const store = (over: Partial<ListingStoreFields> = {}): ListingStoreFields => ({
  creator: { id: 5123, username: 'maker-q7', image: 'https://img.example/avatar-q7.png' },
  recommend: { recommendedCount: 7, notRecommendedCount: 3, recommendPct: 0.7 },
  reviewCount: 10,
  isBeta: true,
  isOfficial: false,
  openCount: 41,
  updatedAt: '2026-11-02T09:08:07.000Z',
  hasPage: true,
  liveUrl: 'https://orbit-b.apps.example',
  description: 'Long-form orbit description',
  coverUrl: 'https://img.example/cover-b4.png',
  screenshots: [{ url: 'https://img.example/shot-c5.png', caption: 'The dashboard' }],
  installCount: 29,
  createdAt: '2026-08-15T01:02:03.000Z',
  ...over,
});

const app = (
  slug: string,
  rating: string | null,
  over: Partial<CatalogApp['listing']> = {}
): CatalogApp => ({
  listing: {
    slug,
    kind: 'offsite',
    name: `Name of ${slug}`,
    tagline: null,
    category: null,
    contentRating: rating,
    iconUrl: null,
    creatorUsername: null,
    externalUrl: `https://${slug}.example`,
    sourceRepoUrl: null,
    forkOf: null,
    store: store(),
    ...over,
  },
  block: null,
  approved: [],
});

const ONSITE: CatalogApp = {
  listing: {
    slug: 'orbit-listing-slug',
    kind: 'onsite',
    name: 'Orbit Notes',
    tagline: 'Notes in orbit',
    category: 'productivity-k2',
    contentRating: 'pg13',
    iconUrl: 'https://img.example/icon-a3.png',
    creatorUsername: 'maker-q7',
    externalUrl: null,
    sourceRepoUrl: 'https://git.example/orbit',
    forkOf: null,
    store: store(),
  },
  block: {
    id: 'ab_orbit',
    blockId: 'orbit-b',
    version: '2.0.0',
    status: 'approved',
    contentRating: 'r',
    manifest: { blockId: 'orbit-b', version: '2.0.0' },
  },
  approved: [],
};

const OFFSITE = app('tide-log', 'g', {
  tagline: 'Tides, logged',
  category: 'utility-m4',
  iconUrl: 'https://img.example/icon-tide.png',
  externalUrl: 'https://tide-dest.example',
  store: store({
    creator: null,
    recommend: { recommendedCount: 2, notRecommendedCount: 5, recommendPct: null },
    reviewCount: 6,
    isBeta: false,
    isOfficial: true,
    // The card already sends null off-site; a stray count must still never be published.
    openCount: 13,
    updatedAt: null,
    hasPage: false,
    liveUrl: null,
    description: null,
    coverUrl: null,
    screenshots: [],
    installCount: 88,
    createdAt: '2026-09-30T11:12:13.000Z',
  }),
});

const listingSet = (sets: ReturnType<typeof buildEntities>) => sets.get(LISTING) ?? [];

describe('listing@v1 field mapping', () => {
  const sets = buildEntities([ONSITE, OFFSITE], { ...BASE, listings: true });

  it('an on-site listing carries its card, detail and stats fields', () => {
    const e = listingSet(sets).find((x) => x.urn === 'urn:apps.civitai.com:listing/orbit-b');
    expect(e?.schemas).toEqual([LISTING]);
    expect(e?.body).toEqual({
      app: 'urn:apps.civitai.com:app/orbit-b',
      slug: 'orbit-b',
      name: 'Orbit Notes',
      kind: 'onsite',
      // The app entity's rating: the listing's own when known, never its block's.
      contentRating: 'pg13',
      tagline: 'Notes in orbit',
      category: 'productivity-k2',
      description: 'Long-form orbit description',
      iconUrl: 'https://img.example/icon-a3.png',
      coverUrl: 'https://img.example/cover-b4.png',
      screenshots: [{ url: 'https://img.example/shot-c5.png', caption: 'The dashboard' }],
      creator: { id: 5123, username: 'maker-q7', image: 'https://img.example/avatar-q7.png' },
      isBeta: true,
      isOfficial: false,
      hasPage: true,
      liveUrl: 'https://orbit-b.apps.example',
      stats: {
        recommendedCount: 7,
        notRecommendedCount: 3,
        recommendPct: 0.7,
        reviewCount: 10,
        openCount: 41,
        installCount: 29,
      },
      createdAt: '2026-08-15T01:02:03.000Z',
      updatedAt: '2026-11-02T09:08:07.000Z',
    });
  });

  it('an off-site listing carries its link and no play count', () => {
    const e = listingSet(sets).find((x) => x.urn === 'urn:apps.civitai.com:listing/tide-log');
    expect(e?.body).toEqual({
      app: 'urn:apps.civitai.com:app/tide-log',
      slug: 'tide-log',
      name: 'Name of tide-log',
      kind: 'offsite',
      contentRating: 'g',
      tagline: 'Tides, logged',
      category: 'utility-m4',
      description: null,
      iconUrl: 'https://img.example/icon-tide.png',
      coverUrl: null,
      screenshots: [],
      creator: null,
      isBeta: false,
      isOfficial: true,
      externalUrl: 'https://tide-dest.example',
      stats: {
        recommendedCount: 2,
        notRecommendedCount: 5,
        recommendPct: null,
        reviewCount: 6,
        openCount: null,
        installCount: 88,
      },
      createdAt: '2026-09-30T11:12:13.000Z',
      updatedAt: null,
    });
  });

  it('every listing validates against the published listing schema, which can refuse one', () => {
    const doc = sets.get(JSON_SCHEMA_DIALECT)?.find((e) => e.urn === LISTING);
    expect(doc?.body).toBe(LISTING_SCHEMA_DOCUMENT);
    const validate = newValidator().compile(LISTING_SCHEMA_DOCUMENT);
    const bodies = listingSet(sets).map((e) => e.body as Record<string, unknown>);
    expect(bodies.map((b) => [b.slug, validate(b)])).toEqual([
      ['orbit-b', true],
      ['tide-log', true],
    ]);
    const { stats: _stats, ...noStats } = bodies[0];
    expect(validate(noStats)).toBe(false);
  });
});

describe('the switch: off by default, nothing about listings exists', () => {
  it('🔴 off: no listing stream, no listing schema document, the same served schemas', () => {
    const sets = buildEntities([ONSITE, OFFSITE], BASE);
    expect(sets.has(LISTING)).toBe(false);
    expect((sets.get(JSON_SCHEMA_DIALECT) ?? []).map((e) => e.urn)).not.toContain(LISTING);
    expect(servedSchemas()).toEqual([
      'https://json-schema.org/draft/2020-12/schema',
      'urn:schema:apps.civitai.com:app@v1',
      'urn:schema:apps.civitai.com:app-release@v1',
      'urn:schema:apps.civitai.com:service@v1',
    ]);
  });

  it('on: the listing schema is served as well', () => {
    expect(servedSchemas({ listings: true })).toContain(LISTING);
  });

  it('🔴 an app with no store fields read publishes its app entity and no listing', () => {
    const skipped: string[] = [];
    const sets = buildEntities([app('bare-app', 'g', { store: undefined }), OFFSITE], {
      ...BASE,
      listings: true,
      onSkip: (r) => skipped.push(r),
    });
    expect(listingSet(sets).map((e) => e.urn)).toEqual(['urn:apps.civitai.com:listing/tide-log']);
    expect((sets.get(APP) ?? []).map((e) => e.urn)).toContain('urn:apps.civitai.com:app/bare-app');
    expect(skipped).toEqual(['listing of bare-app skipped: no store fields were read']);
  });

  it('🔴 seam: the listings are exactly the app entities, so nothing outside the public catalog is listed', () => {
    const unapproved: CatalogApp = {
      ...ONSITE,
      listing: { ...ONSITE.listing, slug: 'held-app' },
      block: { ...ONSITE.block!, blockId: 'held-app', status: 'pending' },
    };
    const sets = buildEntities([ONSITE, OFFSITE, unapproved], { ...BASE, listings: true });
    const appUrns = (sets.get(APP) ?? []).map((e) => e.urn).sort();
    const listed = listingSet(sets)
      .map((e) => (e.body as { app: string }).app)
      .sort();
    expect(listed).toEqual(appUrns);
    expect(listed).toEqual([
      'urn:apps.civitai.com:app/held-app',
      'urn:apps.civitai.com:app/orbit-b',
      'urn:apps.civitai.com:app/tide-log',
    ]);
  });
});

describe('rating exclusion: a listing reaches exactly the audiences its app does', () => {
  const sets = buildEntities(
    [
      app('rated-g', 'g'),
      app('rated-r', 'r'),
      app('rated-x', 'x'),
      app('rated-xxx', 'xxx'),
      app('rated-none', null),
    ],
    { ...BASE, listings: true }
  );
  const slugs = (audience: Audience) =>
    readableBy(sets, LISTING, audience).map((e) => (e.body as { slug: string }).slug);

  it.each<[string, Audience, string[]]>([
    ['anonymous', withListings(ANONYMOUS_AUDIENCE), ['rated-g']],
    [
      'R and X, no XXX',
      withListings(audienceOf({ r: true, x: true, xxx: false })),
      ['rated-g', 'rated-r', 'rated-x'],
    ],
    [
      'every rating (a service)',
      withListings(SERVICE_AUDIENCE),
      ['rated-g', 'rated-r', 'rated-x', 'rated-xxx', 'rated-none'],
    ],
  ])('%s', (_name, audience, expected) => {
    expect(slugs(audience)).toEqual(expected);
  });

  it('🔴 an audience not admitted to listings reads none, and no listing schema document', () => {
    expect(slugs(SERVICE_AUDIENCE)).toEqual([]);
    const schemaUrns = (a: Audience) => readableBy(sets, JSON_SCHEMA_DIALECT, a).map((e) => e.urn);
    expect(schemaUrns(SERVICE_AUDIENCE)).not.toContain(LISTING);
    expect(schemaUrns(withListings(ANONYMOUS_AUDIENCE))).toContain(LISTING);
  });
});

describe('the relay gate (REGISTRY_ADAPTER_LISTING_RELAYS)', () => {
  const adapter = gateListings(
    createPollingAdapter({
      namespace: 'apps.civitai.com',
      serves: servedSchemas({ listings: true }),
      read: async () => buildEntities([ONSITE, OFFSITE], { ...BASE, listings: true }),
      store: createMemorySnapshotStore(),
      pollMs: 1,
      sleep: async () => undefined,
    }),
    new Set(['relay-exp-7'])
  );
  const ctx = (actor: string | null): AdapterContext => ({
    signal: new AbortController().signal,
    audience: SERVICE_AUDIENCE,
    // A service token; `actor` null is one sent directly, by no relay.
    reader: { subject: 'svc:index', userId: null, clientId: 'index-c9', scope: 0n, actor },
  });
  const urns = async (schema: string, c: AdapterContext) =>
    [...((await adapter.snapshot(schema, c)).entities as Entity[])].map((e) => e.urn);

  it('🔴 a listed relay reads the listings; another relay, a direct token and anonymous read none', async () => {
    expect(await urns(LISTING, ctx('relay-exp-7'))).toEqual([
      'urn:apps.civitai.com:listing/orbit-b',
      'urn:apps.civitai.com:listing/tide-log',
    ]);
    expect(await urns(LISTING, ctx('relay-main-2'))).toEqual([]);
    expect(await urns(LISTING, ctx(null))).toEqual([]);
    const anonymous = { signal: new AbortController().signal };
    expect(await urns(LISTING, anonymous)).toEqual([]);
  });

  it('🔴 a cursor issued through the gate is cursor_expired outside it', async () => {
    const { cursor } = await adapter.snapshot(LISTING, ctx('relay-exp-7'));
    await expect(adapter.changes(LISTING, cursor, ctx('relay-main-2'))).rejects.toMatchObject({
      code: 'cursor_expired',
    });
  });

  it('the app stream is the same through the gate: the same cursor for a listed relay', async () => {
    const listed = await adapter.snapshot(APP, ctx('relay-exp-7'));
    const other = await adapter.snapshot(APP, ctx('relay-main-2'));
    expect(listed.cursor).toBe(other.cursor);
  });
});

describe('the listing read', () => {
  const card: ListingCard = {
    id: 'apl_card_3',
    slug: 'comet-sketch',
    kind: 'onsite',
    name: 'Comet Sketch',
    tagline: null,
    category: null,
    contentRating: 'pg',
    iconUrl: 'https://img.example/card-icon.png',
    coverUrl: 'https://img.example/card-cover.png',
    creator: { id: 6620, username: 'comet-maker', image: null },
    recommend: { recommendedCount: 9, notRecommendedCount: 2, recommendPct: 0.82 },
    reviewCount: 11,
    isBeta: false,
    isOfficial: true,
    openCount: 57,
    updatedAt: '2026-10-10T10:10:10.000Z',
    restrictedAudience: null,
    kindData: { kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: 'https://c.example' },
  };

  it("keeps the card's store fields only when asked, and never the card's own media", () => {
    expect(listingFromCard(card).store).toBeUndefined();
    const out = listingFromCard(card, { store: true });
    expect(out.store).toEqual({
      creator: { id: 6620, username: 'comet-maker', image: null },
      recommend: { recommendedCount: 9, notRecommendedCount: 2, recommendPct: 0.82 },
      reviewCount: 11,
      isBeta: false,
      isOfficial: true,
      openCount: 57,
      updatedAt: '2026-10-10T10:10:10.000Z',
      hasPage: false,
      liveUrl: 'https://c.example',
    });
    expect(JSON.stringify(out)).not.toContain('card-cover');
  });

  const extras: ListingExtras = {
    description: 'desc-e1',
    coverUrl: 'https://img.example/e-cover.png',
    screenshots: [],
    installCount: 3,
    createdAt: '2026-07-01T00:00:00.000Z',
  };
  const deps = (over: Partial<CatalogReadDeps>, calls: string[] = []): CatalogReadDeps => ({
    resolveScope: async () => 'full',
    listPage: async () => ({
      items: [
        listingFromCard(card, { store: true }),
        {
          ...(listingFromCard(card, { store: true }) as CatalogListing),
          id: 'apl_no_extras',
          slug: 'no-extras',
        },
      ],
    }),
    loadBlocks: async () => [],
    loadApproved: async () => [],
    loadSourceRepoUrls: async () => new Map(),
    loadForkParents: async () => new Map(),
    loadIconUrls: async () => new Map(),
    loadListingExtras: async (ids) => {
      calls.push(`extras:${ids.join(',')}`);
      return new Map([['apl_card_3', extras]]);
    },
    ...over,
  });

  it('on: card fields joined with the extras; a listing missing its extras carries none', async () => {
    const calls: string[] = [];
    const apps = await readCatalog(deps({}, calls), { listings: true });
    expect(calls).toEqual(['extras:apl_card_3,apl_no_extras']);
    expect(
      apps.map((a) => [a.listing.slug, a.listing.store?.description, a.listing.store?.reviewCount])
    ).toEqual([
      ['comet-sketch', 'desc-e1', 11],
      ['no-extras', undefined, undefined],
    ]);
  });

  it('🔴 off: the extras are never read and no app carries store fields', async () => {
    const calls: string[] = [];
    const apps = await readCatalog(deps({}, calls));
    expect(calls).toEqual([]);
    expect(apps.map((a) => a.listing.store)).toEqual([undefined, undefined]);
  });

  it('on with no listing read wired refuses, rather than publish listings without media', async () => {
    await expect(
      readCatalog(deps({ loadListingExtras: undefined }), { listings: true })
    ).rejects.toThrow('the listing stream is on but the catalog has no listing read');
  });
});

describe('registryListingMedia — no image above the listing rating', () => {
  const img = (url: string, nsfwLevel: number): ListingMediaImage => ({
    url,
    nsfwLevel,
    ingestion: 'Scanned',
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
    modelRestricted: false,
  });
  const shots = [
    { caption: 'mature shot', image: img('shots/r-f6', NsfwLevel.R) },
    { caption: 'safe shot', image: img('shots/pg-g7', NsfwLevel.PG) },
  ];

  it('🔴 a PG listing drops its R cover and R screenshot; the cover falls back to the PG one', () => {
    expect(
      registryListingMedia({
        contentRating: 'pg',
        cover: img('covers/r-h8', NsfwLevel.R),
        screenshots: shots,
      })
    ).toEqual({
      coverUrl: listingMediaEdgeUrl('shots/pg-g7', LISTING_COVER_WIDTH),
      screenshots: [
        { url: listingMediaEdgeUrl('shots/pg-g7', LISTING_SCREENSHOT_WIDTH), caption: 'safe shot' },
      ],
    });
  });

  it('an R listing keeps its R media, in stored order', () => {
    const out = registryListingMedia({
      contentRating: 'r',
      cover: img('covers/r-h8', NsfwLevel.R),
      screenshots: shots,
    });
    expect(out.screenshots.map((s) => s.caption)).toEqual(['mature shot', 'safe shot']);
    expect(out.coverUrl).toBe(listingCoverUrl({ url: 'covers/r-h8' }, null));
  });
});
