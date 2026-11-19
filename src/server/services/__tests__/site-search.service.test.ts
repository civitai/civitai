import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';
import {
  SITE_SEARCH_INDEXES,
  SiteSearchError,
  collectionImageLevelFor,
  hitsNeedShaping,
  shapeModelHit,
  siteFacetSearch,
  siteIndexSearch,
  siteMultiSearch,
  viewerSearchClauses,
} from '~/server/services/site-search.service';
import type { SiteSearchViewer } from '~/server/services/site-search.service';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

vi.mock('~/env/server', () => ({ env: { NEXT_PUBLIC_SEARCH_HOST: 'http://search.test' } }));

describe('viewerSearchClauses', () => {
  // An attribute the index does not declare filterable makes Meilisearch reject every query on it
  // with a 400, which the search UI shows as "no results".
  it('names only attributes each index declares filterable', () => {
    const filterable: Record<string, readonly string[]> = filterableAttributesByIndex;
    const checked = new Set<string>();
    // `images_v6` is retired for good: image search is the semantic search, not this index.
    const restorable = RETIRED_SEARCH_INDEXES.filter((index) => index !== IMAGES_SEARCH_INDEX);
    for (const index of [...SITE_SEARCH_INDEXES, ...restorable]) {
      for (const viewer of [
        { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag },
        { userId: 42, showSfwFace: false },
      ]) {
        for (const clause of viewerSearchClauses(index, viewer)) {
          for (const [, attribute] of clause.matchAll(
            /([\w.]+)\s*(?:!=|>=|<=|=|<|>|NOT IN\b|IS NOT EMPTY\b)/g
          )) {
            expect(filterable[index], `${index}: ${attribute}`).toContain(attribute);
            checked.add(`${index}:${attribute}`);
          }
        }
      }
    }
    // Without this, a clause shape the pattern stopped matching would pass with nothing checked.
    expect(checked).toContain(`${MODELS_SEARCH_INDEX}:poi`);
    expect(checked).toContain(`${MODELS_SEARCH_INDEX}:user.id`);
    expect(checked).toContain(`${MODELS_SEARCH_INDEX}:nsfwLevel`);
    expect(checked).toContain(`${COMICS_SEARCH_INDEX}:nsfwLevel`);
  });

  it('caps a comic by every level it carries; other indexes by any of their levels', () => {
    const viewer = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
    expect(viewerSearchClauses(COMICS_SEARCH_INDEX, viewer)).toEqual([
      'nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [4, 8, 16, 32]',
    ]);
    expect(viewerSearchClauses(MODELS_SEARCH_INDEX, viewer)).toEqual([
      'poi != true',
      'availability != Private',
      'nsfwLevel=1 OR nsfwLevel=2',
    ]);
  });

  it('a retired index is not searchable', () => {
    for (const index of RETIRED_SEARCH_INDEXES) expect(SITE_SEARCH_INDEXES).not.toContain(index);
  });
});

describe('shapeModelHit', () => {
  const comViewer = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
  const redViewer = { showSfwFace: false };
  const hit = {
    id: 1,
    name: 'Red Title',
    sfwName: 'Com Title',
    _formatted: { name: 'Red Title', sfwName: '<em>Com</em> Title' },
  };

  it('a viewer shown the .com face gets it as the name, highlight included, and no .red title', () => {
    const shaped = shapeModelHit(hit, comViewer);
    expect(shaped).toMatchObject({ name: 'Com Title', _formatted: { name: '<em>Com</em> Title' } });
    expect(JSON.stringify(shaped)).not.toContain('Red Title');
  });

  it('a .red viewer keeps the .red title and is not sent the .com one', () => {
    const shaped = shapeModelHit(hit, redViewer);
    expect(shaped.name).toBe('Red Title');
    expect(JSON.stringify(shaped)).not.toContain('Com Title');
  });

  it('a model with no face is unchanged', () => {
    expect(shapeModelHit({ id: 2, name: 'Plain' }, comViewer)).toEqual({ id: 2, name: 'Plain' });
  });

  it('a capped site gets no image above its cap, in the hit or its highlight copy', () => {
    const images = [
      { id: 10, nsfwLevel: NsfwLevel.X },
      { id: 11, nsfwLevel: NsfwLevel.PG },
      { id: 12, nsfwLevel: 0 },
      { id: 13, nsfwLevel: NsfwLevel.PG | NsfwLevel.XXX },
    ];
    const shaped = shapeModelHit({ id: 3, name: 'M', images, _formatted: { images } }, comViewer);
    expect(shaped.images).toEqual([{ id: 11, nsfwLevel: NsfwLevel.PG }]);
    expect(shaped._formatted?.images).toEqual([{ id: 11, nsfwLevel: NsfwLevel.PG }]);
    expect(shapeModelHit({ id: 3, name: 'M', images }, redViewer).images).toEqual(images);
  });

  it("an uncapped site gets the hit's highlight copy as sent", () => {
    const copies = [{ id: 10, nsfwLevel: NsfwLevel.X }, { nsfwLevel: NsfwLevel.PG }];
    const shaped = shapeModelHit(
      { id: 3, name: 'M', images: [], _formatted: { images: copies } },
      redViewer
    );
    expect(shaped._formatted?.images).toEqual(copies);
  });

  it('a capped site gets no images when the hit or its copy does not send a list', () => {
    const notAList = { 0: { id: 10, nsfwLevel: NsfwLevel.X } };
    const shaped = shapeModelHit(
      { id: 3, name: 'M', images: notAList, _formatted: { images: notAList } },
      comViewer
    );
    expect(shaped.images).toEqual([]);
    expect(shaped._formatted?.images).toEqual([]);
  });
});

describe('highlight copies follow the hit', () => {
  const capped = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
  const images = [
    { id: 10, nsfwLevel: NsfwLevel.X },
    { id: 11, nsfwLevel: NsfwLevel.PG },
  ];
  // The copy's numbers arrive as strings, and its ratings are not trusted.
  const tampered = images.map((i) => ({ ...i, id: String(i.id), nsfwLevel: '1' }));
  const ids = (list: { id: unknown }[]) => list.map((i) => String(i.id));

  afterEach(() => vi.unstubAllGlobals());

  it('a model hit keeps only the copies of the images it kept', () => {
    const shaped = shapeModelHit(
      { id: 1, name: 'M', images, _formatted: { images: tampered } },
      capped
    );
    expect(ids(shaped._formatted?.images as { id: unknown }[])).toEqual(['11']);
  });

  it('a bounty hit keeps only the copies of the images it kept', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ hits: [{ id: 1, images, _formatted: { images: tampered } }] }),
            {
              status: 200,
            }
          )
      )
    );
    const { body } = await siteIndexSearch(BOUNTIES_SEARCH_INDEX, { q: 'x' }, capped);
    const [hit] = (body as { hits: { _formatted: { images: { id: unknown }[] } }[] }).hits;
    expect(ids(hit._formatted.images)).toEqual(['11']);
  });
});

describe('comic covers', () => {
  const capped = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
  const uncapped = { showSfwFace: false };
  const cover = 'https://image.test/cover.jpeg';
  const hits = [
    { id: 1, coverImageUrl: cover, coverImageNsfwLevel: NsfwLevel.R },
    { id: 2, coverImageUrl: cover, coverImageNsfwLevel: NsfwLevel.PG },
    { id: 3, coverImageUrl: cover, coverImageNsfwLevel: null },
    { id: 4, coverImageUrl: cover, coverImageNsfwLevel: NsfwLevel.PG | NsfwLevel.R },
    { id: 5, coverImageUrl: cover, coverImageNsfwLevel: NsfwLevel.PG | NsfwLevel.PG13 },
  ];
  const respond = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  const covers = (shaped: unknown) =>
    (shaped as { coverImageUrl?: string }[]).map((hit) => hit.coverImageUrl);

  afterEach(() => vi.unstubAllGlobals());

  it('a capped viewer gets no cover above the cap or unrated, in a single search', async () => {
    respond({ hits });
    const { body } = await siteIndexSearch(COMICS_SEARCH_INDEX, { q: 'x' }, capped);
    expect(covers((body as { hits: unknown }).hits)).toEqual([
      undefined,
      cover,
      undefined,
      undefined,
      cover,
    ]);
  });

  it('a capped viewer gets no cover above the cap in a multi-search', async () => {
    respond({ results: [{ indexUid: COMICS_SEARCH_INDEX, hits }] });
    const { body } = await siteMultiSearch(
      { queries: [{ indexUid: COMICS_SEARCH_INDEX, q: 'x' }] },
      capped
    );
    const [result] = (body as { results: { hits: unknown }[] }).results;
    expect(covers(result.hits)).toEqual([undefined, cover, undefined, undefined, cover]);
  });

  it('a multi-search result that does not name its index is shaped by the query it answers', async () => {
    respond({ results: [{ hits: [] }, { hits }] });
    const { body } = await siteMultiSearch(
      {
        queries: [
          { indexUid: MODELS_SEARCH_INDEX, q: 'x' },
          { indexUid: COMICS_SEARCH_INDEX, q: 'x' },
        ],
      },
      capped
    );
    const [, result] = (body as { results: { hits: unknown }[] }).results;
    expect(covers(result.hits)).toEqual([undefined, cover, undefined, undefined, cover]);
  });

  it('a capped viewer gets no cover in the highlight copy either', async () => {
    const hit = {
      id: 6,
      coverImageNsfwLevel: NsfwLevel.R,
      _formatted: { coverImageUrl: cover, name: 'C' },
    };
    respond({ hits: [hit] });
    const { body } = await siteIndexSearch(COMICS_SEARCH_INDEX, { q: 'x' }, capped);
    expect((body as { hits: { _formatted: unknown }[] }).hits[0]._formatted).toEqual({ name: 'C' });
  });

  it('an uncapped viewer keeps every cover', async () => {
    respond({ hits });
    const { body } = await siteIndexSearch(COMICS_SEARCH_INDEX, { q: 'x' }, uncapped);
    expect(covers((body as { hits: unknown }).hits)).toEqual([cover, cover, cover, cover, cover]);
  });
});

describe('bounty images', () => {
  const capped = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
  const uncapped = { showSfwFace: false };
  const pg = { id: 11, nsfwLevel: NsfwLevel.PG };
  const images = [
    { id: 10, nsfwLevel: NsfwLevel.X },
    pg,
    { id: 12, nsfwLevel: 0 },
    { id: 13, nsfwLevel: NsfwLevel.PG | NsfwLevel.XXX },
  ];
  const respond = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  const firstHit = (body: unknown) => (body as { hits: Record<string, any>[] }).hits[0];

  afterEach(() => vi.unstubAllGlobals());

  it('a capped viewer gets no bounty image above the cap or unrated, highlight included', async () => {
    // Meilisearch's highlight copy carries numbers as strings.
    const formatted = images.map((i) => ({ ...i, nsfwLevel: String(i.nsfwLevel) }));
    respond({ hits: [{ id: 1, images, _formatted: { images: formatted } }] });
    const hit = firstHit((await siteIndexSearch(BOUNTIES_SEARCH_INDEX, { q: 'x' }, capped)).body);
    expect(hit.images).toEqual([pg]);
    expect(hit._formatted.images).toEqual([{ id: 11, nsfwLevel: String(NsfwLevel.PG) }]);
  });

  it('a bounty with no image inside the cap is sent none', async () => {
    respond({ hits: [{ id: 2, images: [images[0]] }] });
    const hit = firstHit((await siteIndexSearch(BOUNTIES_SEARCH_INDEX, { q: 'x' }, capped)).body);
    expect(hit.images).toEqual([]);
  });

  it('a multi-search shapes bounty hits too', async () => {
    respond({ results: [{ indexUid: BOUNTIES_SEARCH_INDEX, hits: [{ id: 1, images }] }] });
    const { body } = await siteMultiSearch(
      { queries: [{ indexUid: BOUNTIES_SEARCH_INDEX, q: 'x' }] },
      capped
    );
    const [result] = (body as { results: { hits: Record<string, any>[] }[] }).results;
    expect(result.hits[0].images).toEqual([pg]);
  });

  it('a multi-search result that does not name its index is shaped by its query', async () => {
    respond({ results: [{ hits: [{ id: 1, images }] }] });
    const { body } = await siteMultiSearch(
      { queries: [{ indexUid: BOUNTIES_SEARCH_INDEX, q: 'x' }] },
      capped
    );
    const [result] = (body as { results: { hits: Record<string, any>[] }[] }).results;
    expect(result.hits[0].images).toEqual([pg]);
  });

  it('an uncapped viewer keeps every image', async () => {
    respond({ hits: [{ id: 1, images }] });
    const hit = firstHit((await siteIndexSearch(BOUNTIES_SEARCH_INDEX, { q: 'x' }, uncapped)).body);
    expect(hit.images).toEqual(images);
  });
});

describe('collection images', () => {
  const capped = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
  const uncapped = { showSfwFace: false };
  const pg = { id: 11, nsfwLevel: NsfwLevel.PG };
  const inCapMixed = { id: 14, nsfwLevel: NsfwLevel.PG | NsfwLevel.PG13 };
  const images = [
    { id: 10, nsfwLevel: NsfwLevel.X },
    pg,
    { id: 12, nsfwLevel: 0 },
    { id: 13, nsfwLevel: NsfwLevel.PG | NsfwLevel.XXX },
    inCapMixed,
  ];
  const srcs = ['https://image.test/a.jpeg'];
  const respond = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  const hitsOf = (body: unknown) => (body as { hits: Record<string, any>[] }).hits;

  afterEach(() => vi.unstubAllGlobals());

  it('a capped viewer gets only images inside the cap, highlight included, and no srcs', async () => {
    respond({ hits: [{ id: 1, image: null, images, srcs, _formatted: { images, srcs } }] });
    const [hit] = hitsOf(
      (await siteIndexSearch(COLLECTIONS_SEARCH_INDEX, { q: 'x' }, capped)).body
    );
    expect(hit.images).toEqual([pg, inCapMixed]);
    expect(hit._formatted.images).toEqual([pg, inCapMixed]);
    expect(hit).not.toHaveProperty('srcs');
    expect(hit._formatted).not.toHaveProperty('srcs');
  });

  it.each([
    ['above the cap', { id: 20, nsfwLevel: NsfwLevel.R }, null],
    ['a mixed rating reaching above it', { id: 21, nsfwLevel: NsfwLevel.PG | NsfwLevel.X }, null],
    ['unrated', { id: 22, nsfwLevel: 0 }, null],
    ['inside the cap', pg, pg],
  ])('a capped viewer gets a cover %s as %o', async (_label, cover, expected) => {
    respond({ hits: [{ id: 1, image: cover, images: [] }] });
    const [hit] = hitsOf(
      (await siteIndexSearch(COLLECTIONS_SEARCH_INDEX, { q: 'x' }, capped)).body
    );
    expect(hit.image).toEqual(expected);
  });

  it('the highlight copy keeps only what the hit kept, whatever ratings it carries', async () => {
    const over = { id: 20, nsfwLevel: NsfwLevel.R };
    // The copy's numbers arrive as strings, and its ratings are not trusted.
    const formatted = images.map((i) => ({ ...i, id: String(i.id), nsfwLevel: '1' }));
    respond({
      hits: [
        {
          id: 1,
          image: over,
          images,
          _formatted: { image: { ...over, nsfwLevel: '1' }, images: formatted, srcs },
        },
      ],
    });
    const [hit] = hitsOf(
      (await siteIndexSearch(COLLECTIONS_SEARCH_INDEX, { q: 'x' }, capped)).body
    );
    expect(hit._formatted.images.map((i: { id: string }) => i.id)).toEqual(['11', '14']);
    expect(hit._formatted.image).toBeNull();
    expect(hit._formatted).not.toHaveProperty('srcs');
  });

  it('a multi-search shapes collection hits too', async () => {
    respond({ results: [{ hits: [{ id: 1, images, srcs }] }] });
    const { body } = await siteMultiSearch(
      { queries: [{ indexUid: COLLECTIONS_SEARCH_INDEX, q: 'x' }] },
      capped
    );
    const [result] = (body as { results: { hits: Record<string, any>[] }[] }).results;
    expect(result.hits[0].images).toEqual([pg, inCapMixed]);
    expect(result.hits[0]).not.toHaveProperty('srcs');
  });

  describe("a signed-in viewer's own level where the site caps nothing", () => {
    const atPg = { showSfwFace: false, collectionImageLevel: NsfwLevel.PG };

    it('gets no cover, item image or srcs above that level, highlight included', async () => {
      const over = { id: 20, nsfwLevel: NsfwLevel.R };
      respond({
        hits: [{ id: 1, image: over, images, srcs, _formatted: { image: over, images, srcs } }],
      });
      const [hit] = hitsOf(
        (await siteIndexSearch(COLLECTIONS_SEARCH_INDEX, { q: 'x' }, atPg)).body
      );
      expect(hit.image).toBeNull();
      expect(hit.images).toEqual([pg]);
      expect(hit).not.toHaveProperty('srcs');
      expect(hit._formatted.image).toBeNull();
      expect(hit._formatted).not.toHaveProperty('srcs');
    });

    it('keeps a cover within that level', async () => {
      respond({ hits: [{ id: 1, image: pg, images: [pg] }] });
      const [hit] = hitsOf(
        (await siteIndexSearch(COLLECTIONS_SEARCH_INDEX, { q: 'x' }, atPg)).body
      );
      expect(hit.image).toEqual(pg);
    });

    it('a multi-search shapes the collection query by it, and leaves other indexes alone', async () => {
      const over = { id: 20, nsfwLevel: NsfwLevel.R };
      const bountyImages = [{ id: 30, nsfwLevel: NsfwLevel.X }];
      respond({
        results: [
          { indexUid: COLLECTIONS_SEARCH_INDEX, hits: [{ id: 1, image: over, images, srcs }] },
          { indexUid: BOUNTIES_SEARCH_INDEX, hits: [{ id: 2, images: bountyImages }] },
        ],
      });
      const { body } = await siteMultiSearch(
        {
          queries: [
            { indexUid: COLLECTIONS_SEARCH_INDEX, q: 'x' },
            { indexUid: BOUNTIES_SEARCH_INDEX, q: 'x' },
          ],
        },
        atPg
      );
      const [collections, bounties] = (body as { results: { hits: Record<string, any>[] }[] })
        .results;
      expect(collections.hits[0].image).toBeNull();
      expect(bounties.hits[0].images).toEqual(bountyImages);
    });

    it('collectionImageLevelFor: only a signed-in non-moderator below every level, with no cap', () => {
      const base = {
        browsingLevelCap: undefined,
        signedIn: true,
        isModerator: false,
        viewerBrowsingLevel: NsfwLevel.PG,
      };
      expect(collectionImageLevelFor(base)).toBe(NsfwLevel.PG);
      expect(collectionImageLevelFor({ ...base, viewerBrowsingLevel: allBrowsingLevelsFlag })).toBe(
        undefined
      );
      expect(collectionImageLevelFor({ ...base, isModerator: true })).toBeUndefined();
      expect(collectionImageLevelFor({ ...base, signedIn: false })).toBeUndefined();
      expect(
        collectionImageLevelFor({ ...base, browsingLevelCap: sfwBrowsingLevelsFlag })
      ).toBeUndefined();
    });
  });

  it('an uncapped viewer keeps every image, the cover and srcs', async () => {
    const cover = { id: 20, nsfwLevel: NsfwLevel.R };
    respond({ hits: [{ id: 1, image: cover, images, srcs }] });
    const [hit] = hitsOf(
      (await siteIndexSearch(COLLECTIONS_SEARCH_INDEX, { q: 'x' }, uncapped)).body
    );
    expect(hit).toMatchObject({ image: cover, images, srcs });
  });
});

describe('passthrough (site-search-passthrough)', () => {
  const capped: SiteSearchViewer = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
  const uncapped: SiteSearchViewer = { showSfwFace: false };
  const on = { passthrough: true };
  // Spacing and a \u escape that a parse and re-serialize would both rewrite, so only the
  // upstream bytes themselves can equal this.
  const upstream =
    '{ "hits" : [ { "id" : 1, "username" : "caf\\u00e9" } ], "estimatedTotalHits" : 1 }\n';
  const respondRaw = (text: string, status = 200) => {
    const fetchMock = vi.fn(async () => new Response(text, { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => vi.unstubAllGlobals());

  it('hitsNeedShaping: models always; comics, bounties, collections, articles and users only under a cap; others never', () => {
    for (const viewer of [capped, uncapped]) {
      expect(hitsNeedShaping(MODELS_SEARCH_INDEX, viewer)).toBe(true);
      expect(hitsNeedShaping(TOOLS_SEARCH_INDEX, viewer)).toBe(false);
    }
    for (const index of [
      COMICS_SEARCH_INDEX,
      BOUNTIES_SEARCH_INDEX,
      COLLECTIONS_SEARCH_INDEX,
      ARTICLES_SEARCH_INDEX,
      USERS_SEARCH_INDEX,
    ]) {
      expect(hitsNeedShaping(index, capped), index).toBe(true);
      expect(hitsNeedShaping(index, uncapped), index).toBe(false);
    }
  });

  it('an index whose hits are never shaped is sent as the exact upstream bytes', async () => {
    respondRaw(upstream);
    const response = await siteIndexSearch(TOOLS_SEARCH_INDEX, { q: 'x' }, capped, on);
    expect(response.status).toBe(200);
    expect(response.body).toBeUndefined();
    expect(response.raw?.toString('utf8')).toBe(upstream);
  });

  it('with passthrough off, the same response is parsed, as before', async () => {
    respondRaw(upstream);
    const response = await siteIndexSearch(TOOLS_SEARCH_INDEX, { q: 'x' }, capped);
    expect(response.raw).toBeUndefined();
    expect(response.body).toEqual({
      hits: [{ id: 1, username: 'caf\u00e9' }],
      estimatedTotalHits: 1,
    });
  });

  it('model hits are always shaped, passthrough or not: no sfwName reaches the viewer', async () => {
    respondRaw(JSON.stringify({ hits: [{ id: 1, name: 'Red', sfwName: 'Com' }] }));
    const response = await siteIndexSearch(MODELS_SEARCH_INDEX, { q: 'x' }, uncapped, on);
    expect(response.raw).toBeUndefined();
    expect(response.body).toEqual({ hits: [{ id: 1, name: 'Red' }] });
  });

  it("a capped viewer's comic hits are shaped; an uncapped viewer's pass through", async () => {
    const cover = 'https://image.test/cover.jpeg';
    const comic = JSON.stringify({
      hits: [{ id: 1, coverImageUrl: cover, coverImageNsfwLevel: NsfwLevel.R }],
    });
    respondRaw(comic);
    const shaped = await siteIndexSearch(COMICS_SEARCH_INDEX, { q: 'x' }, capped, on);
    expect(shaped.raw).toBeUndefined();
    expect(shaped.body).toEqual({ hits: [{ id: 1, coverImageNsfwLevel: NsfwLevel.R }] });

    respondRaw(comic);
    const passed = await siteIndexSearch(COMICS_SEARCH_INDEX, { q: 'x' }, uncapped, on);
    expect(passed.raw?.toString('utf8')).toBe(comic);
  });

  it('a multi-search passes through only when no query in it is shaped', async () => {
    const multi = '{ "results" : [ { "indexUid" : "a", "hits" : [] } ] }';
    respondRaw(multi);
    const passed = await siteMultiSearch(
      {
        queries: [
          { indexUid: USERS_SEARCH_INDEX, q: 'x' },
          { indexUid: ARTICLES_SEARCH_INDEX, q: 'x' },
        ],
      },
      uncapped,
      on
    );
    expect(passed.raw?.toString('utf8')).toBe(multi);

    respondRaw(
      JSON.stringify({
        results: [
          { indexUid: USERS_SEARCH_INDEX, hits: [] },
          { indexUid: MODELS_SEARCH_INDEX, hits: [{ id: 1, name: 'Red', sfwName: 'Com' }] },
        ],
      })
    );
    const shaped = await siteMultiSearch(
      {
        queries: [
          { indexUid: USERS_SEARCH_INDEX, q: 'x' },
          { indexUid: MODELS_SEARCH_INDEX, q: 'x' },
        ],
      },
      uncapped,
      on
    );
    expect(shaped.raw).toBeUndefined();
    const [, models] = (shaped.body as { results: { hits: Record<string, unknown>[] }[] }).results;
    expect(models.hits[0]).not.toHaveProperty('sfwName');
  });

  it('a facet search passes through', async () => {
    const facets = '{ "facetHits" : [ { "value" : "LORA", "count" : 3 } ], "facetQuery" : null }';
    respondRaw(facets);
    const response = await siteFacetSearch(
      MODELS_SEARCH_INDEX,
      { facetName: 'type', facetQuery: null },
      capped,
      on
    );
    expect(response.raw?.toString('utf8')).toBe(facets);
  });

  it('an empty or cut-off 200 is the same 502 it is with passthrough off, not a 200', async () => {
    for (const options of [on, {}])
      for (const body of ['{"hits": [', '', '  \n']) {
        respondRaw(body);
        const error = await siteIndexSearch(USERS_SEARCH_INDEX, { q: 'x' }, capped, options).catch(
          (e: unknown) => e
        );
        expect(error, JSON.stringify(body)).toBeInstanceOf(SiteSearchError);
        expect((error as SiteSearchError).status, JSON.stringify(body)).toBe(502);
      }
  });

  it('a rejected query (4xx) is parsed and returned as before, never passed through', async () => {
    const rejection = { message: 'bad filter', code: 'invalid_search_filter' };
    respondRaw(JSON.stringify(rejection), 400);
    const response = await siteIndexSearch(USERS_SEARCH_INDEX, { q: 'x' }, capped, on);
    expect(response.status).toBe(400);
    expect(response.raw).toBeUndefined();
    expect(response.body).toEqual(rejection);
  });
});

describe('user avatars in hits', () => {
  const capped = { showSfwFace: true, browsingLevelCap: sfwBrowsingLevelsFlag };
  const uncapped = { showSfwFace: false };
  const pic = (nsfwLevel: number) => ({ id: 5, url: 'pic-url', nsfwLevel });
  const image = 'unrated-url';
  const respond = (body: unknown) => {
    const raw = JSON.stringify(body);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(raw, { status: 200 }))
    );
    return raw;
  };
  const hitOf = (body: unknown) => (body as { hits: Record<string, any>[] }).hits[0];
  const userOf = (index: string, hit: Record<string, any>) =>
    index === USERS_SEARCH_INDEX ? hit : hit.user;
  const docFor = (index: string, nsfwLevel: number) => {
    const user = { id: 2, username: 'u', image, profilePicture: pic(nsfwLevel) };
    const doc = index === USERS_SEARCH_INDEX ? { ...user } : { id: 1, user };
    return { ...doc, _formatted: structuredClone(doc) };
  };
  const indexes = [
    MODELS_SEARCH_INDEX,
    ARTICLES_SEARCH_INDEX,
    BOUNTIES_SEARCH_INDEX,
    COLLECTIONS_SEARCH_INDEX,
    COMICS_SEARCH_INDEX,
    USERS_SEARCH_INDEX,
  ];

  afterEach(() => vi.unstubAllGlobals());

  it.each(indexes)(
    '%s: a capped viewer gets no unrated image and no picture outside the cap, highlight included',
    async (index) => {
      for (const level of [NsfwLevel.X, 0, NsfwLevel.PG | NsfwLevel.R]) {
        respond({ hits: [docFor(index, level)] });
        const hit = hitOf((await siteIndexSearch(index, { q: 'x' }, capped)).body);
        for (const user of [userOf(index, hit), userOf(index, hit._formatted)]) {
          expect(user.image, `${level}`).toBeNull();
          expect(user.profilePicture, `${level}`).toBeNull();
          expect(user.username).toBe('u');
        }
      }
    }
  );

  it.each(indexes)(
    '%s: a capped viewer keeps a picture inside the cap, but not the unrated image',
    async (index) => {
      respond({ hits: [docFor(index, NsfwLevel.PG | NsfwLevel.PG13)] });
      const hit = hitOf((await siteIndexSearch(index, { q: 'x' }, capped)).body);
      expect(userOf(index, hit).profilePicture).toEqual(pic(NsfwLevel.PG | NsfwLevel.PG13));
      expect(userOf(index, hit).image).toBeNull();
    }
  );

  // The caller chooses which fields come back and how the highlight copy is written.
  it.each(indexes)(
    '%s: a capped viewer gets no avatar whose rating is missing or unreadable, or in-cap only in the copy',
    async (index) => {
      const withPicture = (doc: Record<string, any>, raw: unknown, copy: unknown) => {
        userOf(index, doc).profilePicture = raw;
        userOf(index, doc._formatted).profilePicture = copy;
        return doc;
      };
      const { nsfwLevel: _, ...unrated } = pic(NsfwLevel.PG);
      const cases = [
        withPicture(docFor(index, NsfwLevel.PG), unrated, unrated),
        withPicture(
          docFor(index, NsfwLevel.PG),
          { ...unrated, nsfwLevel: 'pg' },
          { ...unrated, nsfwLevel: 'pg' }
        ),
        withPicture(docFor(index, NsfwLevel.PG), pic(NsfwLevel.X), { ...unrated, nsfwLevel: '1' }),
      ];
      for (const [i, doc] of cases.entries()) {
        respond({ hits: [doc] });
        const hit = hitOf((await siteIndexSearch(index, { q: 'x' }, capped)).body);
        for (const user of [userOf(index, hit), userOf(index, hit._formatted)]) {
          expect(user.image, `case ${i}`).toBeNull();
          expect(user.profilePicture, `case ${i}`).toBeNull();
        }
      }
    }
  );

  it.each(indexes)('%s: a capped response whose hits are not a list sends none', async (index) => {
    respond({ hits: { 0: docFor(index, NsfwLevel.X) } });
    const body = (await siteIndexSearch(index, { q: 'x' }, capped)).body as { hits: unknown };
    expect(body.hits).toEqual([]);
  });

  // Author-less documents (a deleted user) carry no user object.
  it.each(indexes.filter((index) => index !== USERS_SEARCH_INDEX))(
    '%s: a capped hit with no user, or a null one, comes back unchanged',
    async (index) => {
      const hits = [
        { id: 1 },
        { id: 2, user: null },
        { id: 3, user: null, _formatted: { id: '3' } },
      ];
      respond({ hits });
      const body = (await siteIndexSearch(index, { q: 'x' }, capped)).body as {
        hits: Record<string, unknown>[];
      };
      expect(body.hits.map(({ id, user, _formatted }) => ({ id, user, _formatted }))).toEqual(
        hits.map(({ id, user, _formatted }: Record<string, unknown>) => ({ id, user, _formatted }))
      );
    }
  );

  it.each(indexes)('%s: an uncapped viewer gets the avatar as indexed', async (index) => {
    const doc = docFor(index, NsfwLevel.X);
    respond({ hits: [doc] });
    const hit = hitOf((await siteIndexSearch(index, { q: 'x' }, uncapped)).body);
    expect(userOf(index, hit)).toEqual(userOf(index, doc));
  });
});
