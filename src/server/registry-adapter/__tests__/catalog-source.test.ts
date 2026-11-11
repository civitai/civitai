import { describe, expect, it } from 'vitest';
import type {
  CatalogApprovedRequest,
  CatalogBlock,
  CatalogListing,
  CatalogReadDeps,
} from '~/server/registry-adapter/catalog-source';
import {
  MAX_CATALOG_PAGES,
  listingFromCard,
  readCatalog,
} from '~/server/registry-adapter/catalog-source';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import { buildEntities } from '~/server/registry-adapter/entities';

const listing = (over: Partial<CatalogListing>): CatalogListing => ({
  id: 'apl_one',
  slug: 'orbit-notes',
  kind: 'onsite',
  name: 'Orbit Notes',
  tagline: null,
  category: null,
  contentRating: 'x',
  creatorUsername: 'maker-k',
  appBlockId: 'ab_orbit',
  externalUrl: null,
  ...over,
});

const block: CatalogBlock = {
  id: 'ab_orbit',
  blockId: 'orbit-notes',
  version: '1.1.0',
  status: 'approved',
  contentRating: 'x',
  manifest: { blockId: 'orbit-notes', version: '1.1.0' },
};

const approved = (id: string, version: string, reviewedAt: string): CatalogApprovedRequest => ({
  id,
  appBlockId: 'ab_orbit',
  version,
  manifest: { blockId: 'orbit-notes', version },
  bundleSha256: null,
  commitSha: null,
  sourceCommit: null,
  reviewedAt: new Date(reviewedAt),
});

function deps(over: Partial<CatalogReadDeps> & { calls?: string[] } = {}): CatalogReadDeps {
  const calls = over.calls ?? [];
  return {
    resolveScope: async () => 'full',
    listPage: async () => {
      calls.push('listPage');
      return { items: [listing({})] };
    },
    loadBlocks: async () => [block],
    loadApproved: async () => [
      approved('pubreq_late', '1.1.0', '2026-09-20T00:00:00Z'),
      approved('pubreq_early', '1.0.0', '2026-08-01T00:00:00Z'),
    ],
    loadSourceRepoUrls: async () => new Map(),
    loadForkParents: async () => new Map(),
    loadIconUrls: async () => new Map(),
    ...over,
  };
}

const appUrns = (apps: Awaited<ReturnType<typeof readCatalog>>) =>
  (
    buildEntities(apps, { baseUrl: 'https://site.example' }).get(
      'urn:schema:apps.civitai.com:app@v1'
    ) ?? []
  ).map((e) => e.urn);

describe('listingFromCard', () => {
  // Typed against the real card, so a change to the card's shape fails the test typecheck.
  const card = (kindData: ListingCard['kindData']): ListingCard => ({
    id: 'apl_card_9',
    slug: 'comet-sketch',
    kind: kindData.kind,
    name: 'Comet Sketch',
    tagline: 'Sketch comets',
    category: 'art-k2',
    contentRating: 'r',
    iconUrl: 'https://img.example/comet.png',
    coverUrl: 'https://img.example/comet-cover.png',
    creator: { id: 4411, username: 'comet-maker', image: null },
    recommend: { recommendedCount: 3, notRecommendedCount: 1, recommendPct: 0.75 },
    reviewCount: 4,
    isBeta: false,
    openCount: 17,
    restrictedAudience: null,
    kindData,
  });

  it('an on-site card names its block, and no link', () => {
    expect(
      listingFromCard(
        card({
          kind: 'onsite',
          appBlockId: 'ab_comet_3',
          hasPage: true,
          liveUrl: 'https://comet.example',
        })
      )
    ).toEqual({
      id: 'apl_card_9',
      slug: 'comet-sketch',
      kind: 'onsite',
      name: 'Comet Sketch',
      tagline: 'Sketch comets',
      category: 'art-k2',
      contentRating: 'r',
      creatorUsername: 'comet-maker',
      appBlockId: 'ab_comet_3',
      externalUrl: null,
    });
  });

  it("🔴 never carries the store card's icon, whose ceiling follows the reader's levels", () => {
    const out = listingFromCard(
      card({
        kind: 'onsite',
        appBlockId: 'ab_comet_3',
        hasPage: true,
        liveUrl: 'https://c.example',
      })
    );
    expect(JSON.stringify(out)).not.toContain('comet.png');
  });

  it('an off-site card names its link, and no block; the creator id never leaves', () => {
    const out = listingFromCard(
      card({ kind: 'offsite', externalUrl: 'https://comet-off.example' })
    );
    expect([out.kind, out.appBlockId, out.externalUrl]).toEqual([
      'offsite',
      null,
      'https://comet-off.example',
    ]);
    expect(JSON.stringify(out)).not.toContain('4411');
  });
});

describe('readCatalog — the public-catalog decision comes first', () => {
  it('🔴 a `none` scope (kill switch thrown) yields zero app entities and reads nothing', async () => {
    const calls: string[] = [];
    const apps = await readCatalog(deps({ resolveScope: async () => 'none', calls }));
    expect(apps).toEqual([]);
    expect(appUrns(apps)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('positive control: the same reads with a `full` scope yield the app', async () => {
    const calls: string[] = [];
    const apps = await readCatalog(deps({ calls }));
    expect(appUrns(apps)).toEqual(['urn:apps.civitai.com:app/orbit-notes']);
    expect(calls).toEqual(['listPage']);
  });

  it('the scope it resolved is the scope every page is read with', async () => {
    const seen: string[] = [];
    await readCatalog(
      deps({
        resolveScope: async () => 'public-external',
        listPage: async (scope) => {
          seen.push(scope);
          return { items: [] };
        },
      })
    );
    expect(seen).toEqual(['public-external']);
  });

  it('pages until there is no next cursor', async () => {
    const pages: Array<string | undefined> = [];
    const apps = await readCatalog(
      deps({
        listPage: async (_scope, cursor) => {
          pages.push(cursor);
          return cursor === undefined
            ? { items: [listing({})], nextCursor: 'page-two-k8' }
            : {
                items: [
                  listing({
                    id: 'apl_two',
                    slug: 'tide-log',
                    kind: 'offsite',
                    appBlockId: null,
                    externalUrl: 'https://tide.example',
                  }),
                ],
              };
        },
      })
    );
    expect(pages).toEqual([undefined, 'page-two-k8']);
    expect(apps.map((a) => a.listing.slug)).toEqual(['orbit-notes', 'tide-log']);
  });

  it('🔴 a catalog that never ends fails instead of being served truncated', async () => {
    let calls = 0;
    const err = await readCatalog(
      deps({
        // Ends by itself past the bound, so a removed bound fails on the count below
        // instead of hanging the run.
        listPage: async () => {
          calls++;
          if (calls > MAX_CATALOG_PAGES + 5) return { items: [] };
          return { items: [], nextCursor: `page-${calls}` };
        },
      })
    ).catch((x: Error) => x);
    expect(String(err)).toContain(`exceeded ${MAX_CATALOG_PAGES} pages`);
    expect(calls).toBe(MAX_CATALOG_PAGES);
  });

  it('joins each on-site listing to its block and its approved requests, in review order', async () => {
    const [app] = await readCatalog(deps());
    expect(app.block?.blockId).toBe('orbit-notes');
    expect(app.approved.map((r) => r.id)).toEqual(['pubreq_early', 'pubreq_late']);
  });

  it('an off-site listing carries no block and no releases', async () => {
    const [app] = await readCatalog(
      deps({
        listPage: async () => ({
          items: [
            listing({
              kind: 'offsite',
              appBlockId: 'ab_orbit',
              externalUrl: 'https://tide.example',
            }),
          ],
        }),
      })
    );
    expect([app.block, app.approved, app.listing.externalUrl]).toEqual([
      null,
      [],
      'https://tide.example',
    ]);
  });
});

describe('readCatalog — the published icon', () => {
  it('is the gated icon the icon lookup returns for each listing, and null when it has none', async () => {
    const apps = await readCatalog(
      deps({
        listPage: async () => ({
          items: [
            listing({ id: 'apl_icon_1', slug: 'icon-one', kind: 'offsite', appBlockId: null }),
            listing({ id: 'apl_icon_2', slug: 'icon-two', kind: 'offsite', appBlockId: null }),
          ],
        }),
        loadIconUrls: async () => new Map([['apl_icon_1', 'https://img.example/icon-one.png']]),
      })
    );
    expect(apps.map((a) => [a.listing.slug, a.listing.iconUrl])).toEqual([
      ['icon-one', 'https://img.example/icon-one.png'],
      ['icon-two', null],
    ]);
  });
});

describe('readCatalog — one query per lookup, never one per listing', () => {
  it('🔴 asks for source repos and fork parents once each, with every listing id', async () => {
    const calls: string[][] = [];
    await readCatalog(
      deps({
        listPage: async () => ({
          items: [
            listing({ id: 'apl_batch_1', slug: 'batch-one', kind: 'offsite', appBlockId: null }),
            listing({ id: 'apl_batch_2', slug: 'batch-two', kind: 'offsite', appBlockId: null }),
            listing({ id: 'apl_batch_3', slug: 'batch-three', kind: 'offsite', appBlockId: null }),
          ],
        }),
        loadSourceRepoUrls: async (ids) => {
          calls.push(['repo', ...ids]);
          return new Map();
        },
        loadForkParents: async (ids) => {
          calls.push(['fork', ...ids]);
          return new Map();
        },
      })
    );
    expect(calls.sort()).toEqual([
      ['fork', 'apl_batch_1', 'apl_batch_2', 'apl_batch_3'],
      ['repo', 'apl_batch_1', 'apl_batch_2', 'apl_batch_3'],
    ]);
  });
});

describe('readCatalog — forkOf names a parent only when the parent is in the same public catalog', () => {
  // Pairwise-distinct slugs and ids, none equal to the default listing's.
  const parent = listing({
    id: 'apl_lumen_parent',
    slug: 'lumen-parent',
    kind: 'offsite',
    appBlockId: null,
  });
  const forkOfPublic = listing({
    id: 'apl_lumen_fork',
    slug: 'lumen-fork',
    kind: 'offsite',
    appBlockId: null,
  });
  const forkOfHidden = listing({
    id: 'apl_shade_fork',
    slug: 'shade-fork',
    kind: 'offsite',
    appBlockId: null,
  });
  const FORKS: Record<string, string> = {
    apl_lumen_fork: 'apl_lumen_parent',
    apl_shade_fork: 'apl_hidden_parent_77',
  };

  async function read(items: CatalogListing[]) {
    const asked: string[] = [];
    const apps = await readCatalog(
      deps({
        listPage: async () => ({ items }),
        loadForkParents: async (ids) => {
          asked.push(...ids);
          return new Map(ids.flatMap((id) => (FORKS[id] ? [[id, FORKS[id]]] : [])));
        },
      })
    );
    return {
      forkOf: Object.fromEntries(apps.map((a) => [a.listing.slug, a.listing.forkOf])),
      asked,
    };
  }

  it('🔴 a public parent is named by its slug', async () => {
    const { forkOf } = await read([parent, forkOfPublic]);
    expect(forkOf).toEqual({ 'lumen-parent': null, 'lumen-fork': 'lumen-parent' });
  });

  it('🔴 a parent outside the catalog is omitted, and its id is never looked up', async () => {
    const { forkOf, asked } = await read([parent, forkOfHidden]);
    expect(forkOf).toEqual({ 'lumen-parent': null, 'shade-fork': null });
    expect(asked.sort()).toEqual(['apl_lumen_parent', 'apl_shade_fork']);
  });

  it('a parent that leaves the catalog stops being named', async () => {
    const { forkOf } = await read([forkOfPublic]);
    expect(forkOf).toEqual({ 'lumen-fork': null });
  });

  it("an on-site parent is named by its block's slug, as its app entity is", async () => {
    const onsiteParent = listing({ id: 'apl_lumen_parent', slug: 'lumen-listing-slug' });
    const { forkOf } = await read([onsiteParent, forkOfPublic]);
    expect(forkOf['lumen-fork']).toBe('orbit-notes');
  });
});
