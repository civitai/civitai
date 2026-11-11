import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
} from '~/server/common/constants';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';
import {
  SITE_SEARCH_INDEXES,
  shapeModelHit,
  siteIndexSearch,
  siteMultiSearch,
  viewerSearchClauses,
} from '~/server/services/site-search.service';
import { NsfwLevel } from '~/server/common/enums';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

vi.mock('~/env/server', () => ({ env: { NEXT_PUBLIC_SEARCH_HOST: 'http://search.test' } }));

describe('viewerSearchClauses', () => {
  // An attribute the index does not declare filterable makes Meilisearch reject every query on it
  // with a 400, which the search UI shows as "no results".
  it('names only attributes each index declares filterable', () => {
    const filterable: Record<string, readonly string[]> = filterableAttributesByIndex;
    const checked = new Set<string>();
    for (const index of [...SITE_SEARCH_INDEXES, ...RETIRED_SEARCH_INDEXES]) {
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
    expect(checked).toContain(`${IMAGES_SEARCH_INDEX}:poi`);
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
    ];
    const shaped = shapeModelHit({ id: 3, name: 'M', images, _formatted: { images } }, comViewer);
    expect(shaped.images).toEqual([{ id: 11, nsfwLevel: NsfwLevel.PG }]);
    expect(shaped._formatted?.images).toEqual([{ id: 11, nsfwLevel: NsfwLevel.PG }]);
    expect(shapeModelHit({ id: 3, name: 'M', images }, redViewer).images).toEqual(images);
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
