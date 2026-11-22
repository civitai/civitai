/**
 * The `store-listing@v1` stream (`listing-stream.ts`, `apps/app-index-go/LISTINGS-READ-MODEL.md`): the
 * field mapping, the switch that keeps it dark, the relay gate, the rating exclusion of listings
 * and of each media item, and the isolation of a failed listing read.
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
import type { ListingSubListingItem } from '~/server/registry-adapter/catalog-media';
import {
  MAX_STREAM_SUB_LISTINGS,
  capSubListings,
  registryListingMedia,
  registrySubListing,
} from '~/server/registry-adapter/catalog-media';
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
import {
  buildEntities,
  listingBody,
  readableBy,
  servedSchemas,
} from '~/server/registry-adapter/entities';
import { newValidator } from '~/server/registry-adapter/json-schema';
import { Registry } from 'prom-client';
import {
  createListingStreamMetrics,
  gateListings,
  reportSubListingsCapped,
} from '~/server/registry-adapter/listing-stream';
import type { AdapterContext, Change, Entity } from '~/server/registry-adapter/protocol';
import { STORE_LISTING_SCHEMA_DOCUMENT } from '~/server/registry-adapter/schemas';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import type { StoreSubListingRow } from '~/server/services/blocks/app-sub-listing-store.service';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import {
  LISTING_COVER_WIDTH,
  LISTING_SCREENSHOT_WIDTH,
  listingCoverUrl,
  listingIconUrl,
  listingMediaEdgeUrl,
} from '~/server/services/blocks/listing-media-url';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

const LISTING = 'urn:schema:apps.civitai.com:store-listing@v1';
const APP = 'urn:schema:apps.civitai.com:app@v1';
const BASE = { baseUrl: 'https://site.example' };

const store = (over: Partial<ListingStoreFields> = {}): ListingStoreFields => ({
  id: 'apl_orbit_61',
  appBlockId: 'ab_orbit',
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
  media: [
    {
      slot: 'cover',
      host: 'any',
      url: 'https://img.example/cover-b4.png',
      nsfwLevel: NsfwLevel.PG13,
      rating: 'pg13',
    },
    {
      slot: 'screenshot',
      host: 'any',
      url: 'https://img.example/shot-c5.png',
      nsfwLevel: NsfwLevel.PG,
      rating: 'pg',
      caption: 'The dashboard',
      coverUrl: 'https://img.example/shot-c5-as-cover.png',
    },
  ],
  installCount: 29,
  createdAt: '2026-08-15T01:02:03.000Z',
  serialId: 4471,
  collaborators: [{ id: 7302, username: 'helper-w3', image: 'https://img.example/avatar-w3.png' }],
  issueTrackerUrl: 'https://orbit-support.example/issues',
  actionsRunSource: {
    repository: 'orbit-org/orbit-ci',
    tag: 'v2.0.0',
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  },
  scopes: ['models:read:self', 'ai:write:budgeted'],
  connectScopes: [],
  betaMessage: 'Orbit is still settling',
  forkable: true,
  connectClientId: null,
  forkOf: null,
  subListings: [],
  subListingsOmitted: 0,
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
    // A fork of an app outside this fixture's catalog: built directly, never narrowed here.
    store: store({ forkOf: { slug: 'parent-orbit' } }),
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
    media: [],
    installCount: 88,
    createdAt: '2026-09-30T11:12:13.000Z',
    id: 'apl_tide_92',
    appBlockId: null,
    serialId: 5583,
    collaborators: [],
    issueTrackerUrl: null,
    actionsRunSource: null,
    scopes: [],
    connectScopes: ['UserRead', 'BuzzRead'],
    betaMessage: null,
    forkable: false,
    connectClientId: 'tide-client-41',
    forkOf: null,
  }),
});

const listingSet = (sets: ReturnType<typeof buildEntities>) => sets.get(LISTING) ?? [];

describe('store-listing@v1 field mapping', () => {
  const sets = buildEntities([ONSITE, OFFSITE], { ...BASE, listings: true });

  it('an on-site listing carries its card, detail and stats fields', () => {
    const e = listingSet(sets).find((x) => x.urn === 'urn:apps.civitai.com:store-listing/orbit-b');
    expect(e?.schemas).toEqual([LISTING]);
    expect(e?.body).toEqual({
      app: 'urn:apps.civitai.com:app/orbit-b',
      id: 'apl_orbit_61',
      slug: 'orbit-b',
      name: 'Orbit Notes',
      kind: 'onsite',
      // The app entity's rating: the listing's own when known, never its block's.
      contentRating: 'pg13',
      listingContentRating: 'pg13',
      tagline: 'Notes in orbit',
      category: 'productivity-k2',
      description: 'Long-form orbit description',
      iconUrl: 'https://img.example/icon-a3.png',
      media: [
        {
          slot: 'cover',
          host: 'any',
          url: 'https://img.example/cover-b4.png',
          nsfwLevel: 2,
          rating: 'pg13',
        },
        {
          slot: 'screenshot',
          host: 'any',
          url: 'https://img.example/shot-c5.png',
          nsfwLevel: 1,
          rating: 'pg',
          caption: 'The dashboard',
          coverUrl: 'https://img.example/shot-c5-as-cover.png',
        },
      ],
      creator: { id: 5123, username: 'maker-q7', image: 'https://img.example/avatar-q7.png' },
      isBeta: true,
      isOfficial: false,
      appBlockId: 'ab_orbit',
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
      serialId: 4471,
      collaborators: [
        { id: 7302, username: 'helper-w3', image: 'https://img.example/avatar-w3.png' },
      ],
      sourceRepoUrl: 'https://git.example/orbit',
      issueTrackerUrl: 'https://orbit-support.example/issues',
      actionsRunSource: {
        repository: 'orbit-org/orbit-ci',
        tag: 'v2.0.0',
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      },
      scopes: ['models:read:self', 'ai:write:budgeted'],
      connectScopes: [],
      betaMessage: 'Orbit is still settling',
      forkable: true,
      forkOf: { slug: 'parent-orbit' },
      subListings: [],
      subListingsOmitted: 0,
    });
  });

  it('🔴 a listing with no rating of its own carries null, not its block rating, as the rating the store gates on', () => {
    const unrated: CatalogApp = {
      ...ONSITE,
      listing: { ...ONSITE.listing, contentRating: null },
      block: { ...ONSITE.block!, contentRating: 'pg13' },
    };
    const body = listingSet(buildEntities([unrated], { ...BASE, listings: true }))[0]?.body as
      | Record<string, unknown>
      | undefined;
    expect([body?.contentRating, body?.listingContentRating]).toEqual(['pg13', null]);
  });

  it('an off-site listing carries its link and no play count', () => {
    const e = listingSet(sets).find((x) => x.urn === 'urn:apps.civitai.com:store-listing/tide-log');
    expect(e?.body).toEqual({
      app: 'urn:apps.civitai.com:app/tide-log',
      id: 'apl_tide_92',
      slug: 'tide-log',
      name: 'Name of tide-log',
      kind: 'offsite',
      contentRating: 'g',
      listingContentRating: 'g',
      tagline: 'Tides, logged',
      category: 'utility-m4',
      description: null,
      iconUrl: 'https://img.example/icon-tide.png',
      media: [],
      creator: null,
      isBeta: false,
      isOfficial: true,
      externalUrl: 'https://tide-dest.example',
      connectClientId: 'tide-client-41',
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
      serialId: 5583,
      collaborators: [],
      sourceRepoUrl: null,
      issueTrackerUrl: null,
      actionsRunSource: null,
      scopes: [],
      connectScopes: ['UserRead', 'BuzzRead'],
      betaMessage: null,
      forkable: false,
      forkOf: null,
      subListings: [],
      subListingsOmitted: 0,
    });
  });

  it('every listing validates against the published listing schema, which can refuse one', () => {
    const doc = sets.get(JSON_SCHEMA_DIALECT)?.find((e) => e.urn === LISTING);
    expect(doc?.body).toBe(STORE_LISTING_SCHEMA_DOCUMENT);
    const validate = newValidator().compile(STORE_LISTING_SCHEMA_DOCUMENT);
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
    expect(listingSet(sets).map((e) => e.urn)).toEqual([
      'urn:apps.civitai.com:store-listing/tide-log',
    ]);
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
      'urn:apps.civitai.com:store-listing/orbit-b',
      'urn:apps.civitai.com:store-listing/tide-log',
    ]);
    expect(await urns(LISTING, ctx('relay-main-2'))).toEqual([]);
    expect(await urns(LISTING, ctx(null))).toEqual([]);
    const anonymous = { signal: new AbortController().signal };
    expect(await urns(LISTING, anonymous)).toEqual([]);
  });

  it('🔴 the schema stream through the gate lists the store-listing schema for a listed relay only', async () => {
    expect(await urns(JSON_SCHEMA_DIALECT, ctx('relay-exp-7'))).toContain(LISTING);
    expect(await urns(JSON_SCHEMA_DIALECT, ctx('relay-main-2'))).not.toContain(LISTING);
    expect(await urns(JSON_SCHEMA_DIALECT, ctx(null))).not.toContain(LISTING);
    // Positive control: both still read the fixed entity schemas.
    expect(await urns(JSON_SCHEMA_DIALECT, ctx('relay-main-2'))).toContain(APP);
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
    kindData: {
      kind: 'onsite',
      appBlockId: 'ab_comet_8',
      hasPage: false,
      liveUrl: 'https://c.example',
    },
  };

  it("keeps the card's store fields only when asked, and never the card's own media", () => {
    expect(listingFromCard(card).store).toBeUndefined();
    const out = listingFromCard(card, { store: true });
    expect(out.store).toEqual({
      id: 'apl_card_3',
      appBlockId: 'ab_comet_8',
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
    media: [],
    installCount: 3,
    createdAt: '2026-07-01T00:00:00.000Z',
    serialId: 902,
    collaborators: [],
    scopes: [],
    connectScopes: [],
    issueTrackerUrl: null,
    actionsRunSource: null,
    betaMessage: null,
    forkable: false,
    connectClientId: null,
    fork: { isFork: false, forkOfListingId: null },
    subListings: [],
    subListingsOmitted: 0,
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

  it('🔴 a failed listing read fails only the listing stream, and is logged', async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const apps = await readCatalog(
      deps(
        {
          loadIconUrls: async () => {
            calls.push('icons');
            return new Map([['apl_card_3', 'https://img.example/icon-z9.png']]);
          },
          loadListingExtras: async () => {
            throw new Error('extras read down');
          },
        },
        calls
      ),
      { listings: true, onError: (e) => errors.push(e) }
    );
    expect(apps.listingsFailed).toBe(true);
    expect(errors.map((e) => (e as Error).message)).toEqual(['extras read down']);
    // The reads beside it completed, and every app is still there, without store fields.
    expect(calls).toEqual(['icons']);
    expect(apps.map((a) => [a.listing.slug, a.listing.iconUrl, a.listing.store])).toEqual([
      ['comet-sketch', 'https://img.example/icon-z9.png', undefined],
      ['no-extras', null, undefined],
    ]);
  });

  it('🔴 a fork names its parent only when the parent is in the same catalog, never itself', async () => {
    const forkOf = (forkOfListingId: string | null, isFork = true) => ({
      ...extras,
      fork: { isFork, forkOfListingId },
    });
    const apps = await readCatalog(
      deps({
        listPage: async () => ({
          items: ['apl_k1', 'apl_k2', 'apl_k3', 'apl_k4', 'apl_k5'].map((id, i) => ({
            ...(listingFromCard(card, { store: true }) as CatalogListing),
            id,
            slug: `fork-case-${i + 1}`,
          })),
        }),
        loadListingExtras: async () =>
          new Map([
            // The parent is listed: named by its slug.
            ['apl_k1', forkOf('apl_k5')],
            // The parent is not in this catalog (hidden or gone): a fork, unnamed.
            ['apl_k2', forkOf('apl_outside_9')],
            // A fork whose parent pointer is gone (only the block remembers it): unnamed.
            ['apl_k3', forkOf(null)],
            // Its own parent: never named.
            ['apl_k4', forkOf('apl_k4')],
            // Not a fork, whatever its pointer says.
            ['apl_k5', forkOf('apl_k1', false)],
          ]),
      }),
      { listings: true }
    );
    expect(apps.map((a) => [a.listing.slug, a.listing.store?.forkOf])).toEqual([
      ['fork-case-1', { slug: 'fork-case-5' }],
      ['fork-case-2', { slug: null }],
      ['fork-case-3', { slug: null }],
      ['fork-case-4', { slug: null }],
      ['fork-case-5', null],
    ]);
  });
});

describe('fork parent: named only to an audience that may read the parent app', () => {
  const sets = buildEntities(
    [
      app('parent-r', 'r'),
      app('fork-of-r', 'g', { store: store({ forkOf: { slug: 'parent-r' } }) }),
      app('fork-of-g', 'g', { store: store({ forkOf: { slug: 'parent-g' } }) }),
      app('parent-g', 'g'),
    ],
    { ...BASE, listings: true }
  );
  const forkOfIn = (audience: Audience) =>
    Object.fromEntries(
      readableBy(sets, LISTING, audience).map((e) => {
        const b = e.body as { slug: string; forkOf: unknown };
        return [b.slug, b.forkOf];
      })
    );

  it('🔴 a PG audience reads the R parent as unnamed; the G parent stays named', () => {
    const got = forkOfIn(withListings(ANONYMOUS_AUDIENCE));
    expect([got['fork-of-r'], got['fork-of-g']]).toEqual([{ slug: null }, { slug: 'parent-g' }]);
  });

  it('an audience that may read R reads both parents named', () => {
    const got = forkOfIn(withListings(SERVICE_AUDIENCE));
    expect([got['fork-of-r'], got['fork-of-g']]).toEqual([
      { slug: 'parent-r' },
      { slug: 'parent-g' },
    ]);
  });
});

describe('media: every image rated on its own, narrowed per audience (red overrides carried)', () => {
  const img = (url: string, nsfwLevel: number, over: Partial<ListingMediaImage> = {}) =>
    ({
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
      ...over,
    } as ListingMediaImage);
  const media = registryListingMedia({
    icon: img('icons/own-pg13-a1', NsfwLevel.PG13),
    cover: img('covers/own-r-b2', NsfwLevel.R),
    screenshots: [
      { caption: 'cap-c3', image: img('shots/pg-c3', NsfwLevel.PG) },
      { caption: 'cap-e5', image: img('shots/x-e5', NsfwLevel.X) },
      // Fails the store's per-image moderation check: never published, at any level.
      { caption: 'cap-f6', image: img('shots/poi-f6', NsfwLevel.PG, { poi: true }) },
      { caption: 'cap-g7', image: img('shots/blocked-g7', NsfwLevel.Blocked) },
    ],
    red: { icon: null, cover: { ...img('covers/red-r-d4', NsfwLevel.R), id: 4404 } },
  });

  it('carries each image with its own level and rating, and marks the red override red-only', () => {
    expect(media).toEqual([
      {
        slot: 'icon',
        host: 'any',
        url: listingIconUrl({ url: 'icons/own-pg13-a1' }),
        nsfwLevel: 2,
        rating: 'pg13',
      },
      {
        slot: 'cover',
        host: 'any',
        url: listingCoverUrl({ url: 'covers/own-r-b2' }, null),
        nsfwLevel: 4,
        rating: 'r',
      },
      {
        slot: 'screenshot',
        host: 'any',
        url: listingMediaEdgeUrl('shots/pg-c3', LISTING_SCREENSHOT_WIDTH),
        nsfwLevel: 1,
        rating: 'pg',
        caption: 'cap-c3',
        coverUrl: listingMediaEdgeUrl('shots/pg-c3', LISTING_COVER_WIDTH),
      },
      {
        slot: 'screenshot',
        host: 'any',
        url: listingMediaEdgeUrl('shots/x-e5', LISTING_SCREENSHOT_WIDTH),
        nsfwLevel: 8,
        rating: 'x',
        caption: 'cap-e5',
        coverUrl: listingMediaEdgeUrl('shots/x-e5', LISTING_COVER_WIDTH),
      },
      {
        slot: 'cover',
        host: 'red',
        url: listingCoverUrl({ url: 'covers/red-r-d4' }, null),
        nsfwLevel: 4,
        rating: 'r',
      },
    ]);
  });

  // A PG listing carrying an R cover, an X screenshot and an R civitai.red cover override.
  const sets = buildEntities([app('pg-media-h8', 'pg', { store: store({ media }) })], {
    ...BASE,
    listings: true,
  });
  const served = (audience: Audience) =>
    readableBy(sets, LISTING, audience).map((e) => (e.body as { media: unknown[] }).media);

  it('🔴 a PG-only audience gets neither the R cover nor the red override', () => {
    expect(served(withListings(ANONYMOUS_AUDIENCE))).toEqual([[media[0], media[2]]]);
  });

  it('🔴 an R audience gets the R cover and the red override, marked red, and no X image', () => {
    const [items] = served(withListings(audienceOf({ r: true, x: false, xxx: false })));
    expect(items).toEqual([media[0], media[1], media[2], media[4]]);
    expect((items as Array<{ host: string; slot: string }>).map((m) => m.host)).toEqual([
      'any',
      'any',
      'any',
      'red',
    ]);
  });

  it('a narrowed body is a body of its own: its rev differs from the whole one', () => {
    const rev = (a: Audience) => readableBy(sets, LISTING, a)[0]?.rev;
    expect(rev(withListings(ANONYMOUS_AUDIENCE))).not.toBe(rev(withListings(SERVICE_AUDIENCE)));
    expect(rev(withListings(SERVICE_AUDIENCE))).toBe(listingSet(sets)[0].rev);
  });
});

describe('a failed listing read fails only the listing stream', () => {
  let failing = false;
  let stop = new AbortController();
  const good = buildEntities([ONSITE, OFFSITE], { ...BASE, listings: true });
  const failed = Object.assign([{ ...ONSITE, listing: { ...ONSITE.listing, store: undefined } }], {
    listingsFailed: true as const,
  });
  const adapter = gateListings(
    createPollingAdapter({
      namespace: 'apps.civitai.com',
      serves: servedSchemas({ listings: true }),
      read: async () => (failing ? buildEntities(failed, { ...BASE, listings: true }) : good),
      store: createMemorySnapshotStore(),
      pollMs: 1,
      // One poll per changes() stream: the first sleep stops it, so a missing guard fails the
      // assertion below rather than polling until the test times out.
      sleep: async () => stop.abort(),
    }),
    new Set(['relay-exp-7'])
  );
  const ctx = (signal = new AbortController().signal): AdapterContext => ({
    signal,
    audience: SERVICE_AUDIENCE,
    reader: {
      subject: 'svc:index',
      userId: null,
      clientId: 'index-c9',
      scope: 0n,
      actor: 'relay-exp-7',
    },
  });

  it('🔴 the listing stream ends unavailable with no delete; the app stream still serves', async () => {
    failing = false;
    const { cursor } = await adapter.snapshot(LISTING, ctx());
    failing = true;
    const seen: Change[] = [];
    let code: unknown;
    try {
      stop = new AbortController();
      const changes = await adapter.changes(LISTING, cursor, ctx(stop.signal));
      for await (const change of changes) seen.push(change);
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect([code, seen]).toEqual(['unavailable', []]);
    const apps = [...((await adapter.snapshot(APP, ctx())).entities as Entity[])];
    expect(apps.map((e) => e.urn)).toEqual(['urn:apps.civitai.com:app/orbit-b']);
    await expect(adapter.snapshot(LISTING, ctx())).rejects.toMatchObject({ code: 'unavailable' });
  });
});

/**
 * Sub-listings (`subListings`, LISTINGS-READ-MODEL.md slice 6): each row the store grid could show
 * becomes an item with its card's own values, built with the card's own rules (`registrySubListing`),
 * carried in its parent's body, and narrowed per audience like the media.
 */
describe('sub-listings: the card fields of every item the grid could show', () => {
  const ITEM = 'asl_01J9ZK3Q4R5S6T7V8W9X0YQ001';
  const row = (over: Partial<StoreSubListingRow> = {}): StoreSubListingRow => ({
    id: ITEM,
    title: 'Neon Drift',
    tagline: 'A racing preset',
    sub_path: 'presets/neon-drift',
    content_rating: 'r',
    author_user_id: 6411,
    author_username: 'drifter-k4',
    author_image: 'https://img.example/drifter-k4.png',
    parent_id: 'apl_gen_hub',
    parent_slug: 'gen-hub',
    parent_name: 'Gen Hub',
    parent_kind: 'onsite',
    parent_category: 'generation',
    parent_content_rating: 'pg13',
    parent_cover_url: null,
    parent_cover_nsfw_level: null,
    parent_cover_ingestion: null,
    parent_cover_needs_review: null,
    parent_cover_poi: null,
    parent_cover_minor: null,
    parent_cover_tos_violation: null,
    parent_cover_acceptable_minor: null,
    parent_cover_blocked_for: null,
    parent_cover_model_restricted: null,
    parent_icon_url: null,
    parent_icon_nsfw_level: null,
    parent_icon_ingestion: null,
    parent_icon_needs_review: null,
    parent_icon_poi: null,
    parent_icon_minor: null,
    parent_icon_tos_violation: null,
    parent_icon_acceptable_minor: null,
    parent_icon_blocked_for: null,
    parent_icon_model_restricted: null,
    parent_link_template: null,
    image_url: 'items/neon-r',
    image_nsfw_level: NsfwLevel.R,
    image_ingestion: 'Scanned',
    image_needs_review: null,
    image_poi: false,
    image_minor: false,
    image_tos_violation: false,
    image_acceptable_minor: false,
    image_blocked_for: null,
    image_model_restricted: false,
    image_public: true,
    parent_listing_id: 'apl_gen_hub',
    sort_time: '2026-10-11T12:13:14.567891Z',
    ...over,
  });

  it('an on-site item: its link under the parent run route, its rated image at cover width', () => {
    expect(registrySubListing(row())).toEqual({
      id: ITEM,
      title: 'Neon Drift',
      tagline: 'A racing preset',
      contentRating: 'r',
      // The stricter of the parent's PG-13 and the item's R.
      cardContentRating: 'r',
      author: { id: 6411, username: 'drifter-k4', image: 'https://img.example/drifter-k4.png' },
      // To the microsecond, as the grid's newest key reads it.
      sortTime: '2026-10-11T12:13:14.567891Z',
      runHref: `/apps/run/gen-hub/presets/neon-drift?sl=${ITEM}`,
      external: false,
      image: {
        url: listingMediaEdgeUrl('items/neon-r', LISTING_COVER_WIDTH),
        nsfwLevel: NsfwLevel.R,
        rating: 'r',
      },
    });
  });

  it('an unrated item under a stricter parent shows the parent rating; both unrated, none', () => {
    expect(registrySubListing(row({ content_rating: null }))?.cardContentRating).toBe('pg13');
    expect(
      registrySubListing(row({ content_rating: null, parent_content_rating: null }))
        ?.cardContentRating
    ).toBeNull();
  });

  it.each<[string, Partial<StoreSubListingRow>]>([
    ['not in a public post', { image_public: false }],
    [
      'still being scanned',
      { image_ingestion: 'Pending' as StoreSubListingRow['image_ingestion'] },
    ],
    ['flagged', { image_poi: true }],
    ['Blocked', { image_nsfw_level: NsfwLevel.Blocked }],
    ['absent', { image_url: null, image_ingestion: null }],
  ])('🔴 an item image %s is never published: the card falls back to the parent', (_n, over) => {
    const item = registrySubListing(row(over));
    expect(item?.image).toBeNull();
    // The item itself is still carried.
    expect(item?.id).toBe(ITEM);
  });

  it('an off-site item: its link is the parent link template filled in, external', () => {
    const offsite = row({
      parent_kind: 'offsite',
      sub_path: 'neon-drift',
      parent_link_template: 'https://games.example.com/play?game={id}',
    });
    expect(registrySubListing(offsite)).toMatchObject({
      runHref: 'https://games.example.com/play?game=neon-drift',
      external: true,
    });
  });

  it.each([
    null,
    'http://games.example.com/?game={id}',
    'https://games.example.com/no-placeholder',
  ])('🔴 an off-site item with link template %s has nowhere to link: not published', (template) => {
    expect(
      registrySubListing(row({ parent_kind: 'offsite', parent_link_template: template }))
    ).toBeNull();
  });

  const item = (over: Partial<ListingSubListingItem>): ListingSubListingItem => ({
    id: ITEM,
    title: 'Neon Drift',
    tagline: null,
    contentRating: null,
    cardContentRating: 'pg',
    author: { id: 6411, username: 'drifter-k4', image: null },
    sortTime: '2026-10-11T12:13:14.567891Z',
    runHref: `/apps/run/gen-hub/presets/neon-drift?sl=${ITEM}`,
    external: false,
    image: null,
    ...over,
  });
  const PG_R_IMAGE = item({
    id: 'asl_01J9ZK3Q4R5S6T7V8W9X0YQ011',
    image: { url: 'https://img.example/item-r.png', nsfwLevel: NsfwLevel.R, rating: 'r' },
  });
  const X_ITEM = item({
    id: 'asl_01J9ZK3Q4R5S6T7V8W9X0YQ012',
    contentRating: 'x',
    cardContentRating: 'x',
  });
  const XXX_ITEM = item({
    id: 'asl_01J9ZK3Q4R5S6T7V8W9X0YQ013',
    contentRating: 'xxx',
    cardContentRating: 'xxx',
  });
  const UNRATED = item({ id: 'asl_01J9ZK3Q4R5S6T7V8W9X0YQ014', cardContentRating: null });
  const sets = buildEntities(
    [
      app('hub-l5', 'pg', {
        store: store({ subListings: [PG_R_IMAGE, X_ITEM, XXX_ITEM, UNRATED] }),
      }),
    ],
    { ...BASE, listings: true }
  );
  const served = (audience: Audience) =>
    readableBy(sets, LISTING, audience).map(
      (e) => (e.body as { subListings: ListingSubListingItem[] }).subListings
    );

  it('the body carries every item as built, and validates against the published schema', () => {
    const body = listingSet(sets)[0].body as Record<string, unknown>;
    expect(body.subListings).toEqual([PG_R_IMAGE, X_ITEM, XXX_ITEM, UNRATED]);
    const validate = newValidator().compile(STORE_LISTING_SCHEMA_DOCUMENT);
    expect(validate(body)).toBe(true);
    // The schema can refuse one: an item without its link.
    const { runHref: _runHref, ...noLink } = PG_R_IMAGE;
    expect(validate({ ...body, subListings: [noLink] })).toBe(false);
  });

  it('🔴 a PG-only audience gets the PG item without its R image, and no mature or unrated item', () => {
    expect(served(withListings(ANONYMOUS_AUDIENCE))).toEqual([[{ ...PG_R_IMAGE, image: null }]]);
  });

  it('🔴 an R audience gets the R image, and still no X, XXX or unrated item', () => {
    expect(served(withListings(audienceOf({ r: true, x: false, xxx: false })))).toEqual([
      [PG_R_IMAGE],
    ]);
  });

  it('a service (every rating) gets every item whole, in the body as built', () => {
    expect(served(withListings(SERVICE_AUDIENCE))).toEqual([
      [PG_R_IMAGE, X_ITEM, XXX_ITEM, UNRATED],
    ]);
    const rev = (a: Audience) => readableBy(sets, LISTING, a)[0]?.rev;
    expect(rev(withListings(SERVICE_AUDIENCE))).toBe(listingSet(sets)[0].rev);
    // A narrowed body is a body of its own.
    expect(rev(withListings(ANONYMOUS_AUDIENCE))).not.toBe(rev(withListings(SERVICE_AUDIENCE)));
  });
});

/**
 * The per-listing cap on sub-listing items (`MAX_STREAM_SUB_LISTINGS`): a body travels as one
 * registry stream line, which app-index-go reads up to 1 MiB, so the items it embeds are bounded.
 */
describe('the sub-listing cap', () => {
  const id = (n: number) => `asl_01J9ZK3Q4R5S6T7V8W9X${String(n).padStart(6, '0')}`;
  const at = (n: number) => `2026-01-01T00:00:00.${String(n).padStart(6, '0')}Z`;
  const item = (n: number, sortTime = at(n)): ListingSubListingItem => ({
    id: id(n),
    title: `Item ${n}`,
    tagline: null,
    contentRating: null,
    cardContentRating: 'pg',
    author: { id: n, username: null, image: null },
    sortTime,
    runHref: `/apps/run/hub/i/${n}?sl=${id(n)}`,
    external: false,
    image: null,
  });

  it('is 200', () => {
    expect(MAX_STREAM_SUB_LISTINGS).toBe(200);
  });

  it('at or under the cap: every item, none left out', () => {
    const items = Array.from({ length: 200 }, (_, i) => item(i));
    expect(capSubListings(items)).toEqual({ items, omitted: 0 });
  });

  it('🔴 over it: the most recently approved are kept, in id order; the oldest left out and counted', () => {
    // In id order, with sort times running against it: item 0 is the newest.
    const items = Array.from({ length: 205 }, (_, i) => item(i, at(1000 - i)));
    const { items: kept, omitted } = capSubListings(items);
    expect(omitted).toBe(5);
    expect(kept.map((k) => k.id)).toEqual(items.slice(0, 200).map((k) => k.id));
  });

  it('a tie on the sort time keeps the higher id, so the same catalog keeps the same items', () => {
    const items = [item(1, at(5)), item(2, at(5)), item(3, at(5))];
    expect(capSubListings(items, 2).items.map((k) => k.id)).toEqual([id(2), id(3)]);
    expect(capSubListings([...items].reverse(), 2).items.map((k) => k.id)).toEqual([id(3), id(2)]);
  });

  it('🔴 a body at the cap with every item at its largest stays well under the 1 MiB stream line', () => {
    // Three UTF-8 bytes per UTF-16 unit, at every bound the store checks; a 300-character link
    // template; long avatar and image URLs.
    const big = (n: number): ListingSubListingItem => ({
      id: id(n),
      title: '€'.repeat(80),
      tagline: '€'.repeat(140),
      contentRating: 'pg13',
      cardContentRating: 'pg13',
      author: {
        id: 1_000_000_000 + n,
        username: 'u'.repeat(64),
        image: `https://image.example/${'a'.repeat(280)}`,
      },
      sortTime: at(n),
      runHref: `https://${'h'.repeat(290)}/${'i'.repeat(64)}`,
      external: true,
      image: {
        url: `https://image.example/${'b'.repeat(200)}/width=1200`,
        nsfwLevel: NsfwLevel.PG13,
        rating: 'pg13',
      },
    });
    const items = capSubListings(Array.from({ length: 250 }, (_, i) => big(i))).items;
    const body = listingBody(app('cap-probe', 'pg13'), 'urn:apps.civitai.com:app/cap-probe', {
      ...store(),
      subListings: items,
      subListingsOmitted: 50,
    });
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    expect(items).toHaveLength(200);
    // About 1.9 KB an item, 0.36 MiB for 200: under half the line, so the rest of the body has room.
    expect(bytes).toBeLessThan(512 * 1024);
    // Positive control: the uncapped items would not fit that bound.
    const uncapped = Array.from({ length: 1000 }, (_, i) => big(i));
    expect(Buffer.byteLength(JSON.stringify(uncapped), 'utf8')).toBeGreaterThan(1024 * 1024);
  });

  it('the body says how many it left out, and the schema accepts it', () => {
    const body = listingBody(app('cap-probe', 'pg'), 'urn:apps.civitai.com:app/cap-probe', {
      ...store(),
      subListingsOmitted: 7,
    });
    expect(body.subListingsOmitted).toBe(7);
    const validate = newValidator().compile(STORE_LISTING_SCHEMA_DOCUMENT);
    expect(validate(body)).toBe(true);
    expect(validate({ ...body, subListingsOmitted: -1 })).toBe(false);
  });

  it('each capped listing is counted and logged', async () => {
    const { dropped, registry } = createListingStreamMetrics(new Registry());
    const lines: string[] = [];
    const report = reportSubListingsCapped(dropped, (l) => lines.push(l), 200);
    report('apl_hub_1', 5);
    report('apl_hub_2', 3);
    expect(
      await registry.getSingleMetricAsString('registry_adapter_listing_sub_listings_dropped_total')
    ).toContain('registry_adapter_listing_sub_listings_dropped_total 8');
    expect(lines).toEqual([
      'registry-adapter: listing apl_hub_1: 5 sub-listing item(s) past the cap of 200 left out of its body',
      'registry-adapter: listing apl_hub_2: 3 sub-listing item(s) past the cap of 200 left out of its body',
    ]);
  });
});
