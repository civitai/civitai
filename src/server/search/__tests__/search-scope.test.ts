import { describe, expect, it } from 'vitest';
import { ArticlesSearchIndexSortBy } from '~/components/Search/parsers/article.parser';
import { BountiesSearchIndexSortBy } from '~/components/Search/parsers/bounties.parser';
import { CollectionsSearchIndexSortBy } from '~/components/Search/parsers/collection.parser';
import { ComicsSearchIndexSortBy } from '~/components/Search/parsers/comic.parser';
import { ModelSearchIndexSortBy } from '~/components/Search/parsers/model.parser';
import { ToolsSearchIndexSortBy } from '~/components/Search/parsers/tool.parser';
import { UsersSearchIndexSortBy } from '~/components/Search/parsers/user.parser';
import { NsfwLevel } from '~/server/common/enums';
import type { SearchIndex, SearchQueryInput } from '~/server/schema/search.schema';
import { searchQuerySchema } from '~/server/schema/search.schema';
import type { SearchViewer } from '~/server/search/search-scope';
import type { Doc } from '~/server/search/__tests__/clause-reference';
import { matches } from '~/server/search/__tests__/clause-reference';
import { searchClauses, sortFromLegacySortBy } from '~/server/search/search-scope';
import { Availability } from '~/shared/utils/prisma/enums';

const search = (input: SearchQueryInput, viewer: SearchViewer, docs: Doc[]) => {
  const clauses = searchClauses(searchQuerySchema.parse(input), viewer);
  return docs.filter((doc) => clauses.every((c) => matches(doc, c))).map((doc) => doc.id);
};

const model = (id: number, overrides: Doc = {}): Doc => ({
  id,
  nsfwLevel: [NsfwLevel.PG],
  poi: false,
  availability: Availability.Public,
  user: { id: 1, username: 'someone' },
  type: 'LORA',
  tags: [{ name: 'style' }],
  ...overrides,
});

const models = [
  model(1),
  model(2, { nsfwLevel: [NsfwLevel.PG, NsfwLevel.R] }),
  model(3, { nsfwLevel: [NsfwLevel.X] }),
  model(4, { poi: true }),
  model(5, { availability: Availability.Private }),
  model(6, { poi: true, availability: Availability.Private, user: { id: 42, username: 'owner' } }),
  model(7, { nsfwLevel: [NsfwLevel.XXX], user: { id: 42, username: 'owner' } }),
];

const PG_R = NsfwLevel.PG | NsfwLevel.R;
const ALL = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;

describe('search scope', () => {
  it('serves an anonymous viewer only public, non-POI content at the public level by default', () => {
    expect(search({ index: 'models' }, {}, models)).toEqual([1, 2]);
  });

  it('never serves content above the browsing level the viewer chose', () => {
    expect(search({ index: 'models', browsingLevel: NsfwLevel.PG }, {}, models)).toEqual([1, 2]);
    expect(search({ index: 'models', browsingLevel: NsfwLevel.X }, {}, models)).toEqual([3]);
  });

  it('narrows a chosen level to the site cap, and serves nothing when the choice is wholly above it', () => {
    const viewer = { browsingLevelCap: PG_R };
    expect(search({ index: 'models', browsingLevel: ALL }, viewer, models)).toEqual([1, 2]);
    expect(search({ index: 'models', browsingLevel: NsfwLevel.X }, viewer, models)).toEqual([]);
  });

  it('lets an owner find their own POI and private models, and nobody else', () => {
    const owner = { userId: 42 };
    expect(search({ index: 'models', browsingLevel: ALL }, owner, models)).toEqual([1, 2, 3, 6, 7]);
    expect(search({ index: 'models', browsingLevel: ALL }, { userId: 7 }, models)).toEqual([
      1, 2, 3, 7,
    ]);
  });

  it('lifts POI and privacy for moderators but keeps the site cap', () => {
    const moderator = { userId: 99, isModerator: true, browsingLevelCap: PG_R };
    expect(search({ index: 'models', browsingLevel: ALL }, moderator, models)).toEqual([
      1, 2, 4, 5, 6,
    ]);
  });

  it('applies the query filters on top of the viewer scope, not instead of it', () => {
    const docs = [...models, model(8, { poi: true, tags: [{ name: 'anime' }] })];
    expect(search({ index: 'models', filters: { tags: ['anime'] } }, {}, docs)).toEqual([]);
    expect(search({ index: 'models', filters: { excludeTags: ['style'] } }, {}, docs)).toEqual([]);
  });

  it('refuses a query that tries to pass engine syntax or scope fields', () => {
    const attempts = [
      { index: 'models', filters: { filter: 'poi = true OR id > 0' } },
      { index: 'models', filters: { poi: true } },
      { index: 'models', sort: 'models_v9:metrics.downloadCount:desc' },
      { index: 'images' },
    ];
    for (const attempt of attempts)
      expect(searchQuerySchema.safeParse(attempt).success, JSON.stringify(attempt)).toBe(false);
  });
});

describe('sortFromLegacySortBy', () => {
  const legacy: [SearchIndex, readonly string[]][] = [
    ['models', ModelSearchIndexSortBy],
    ['articles', ArticlesSearchIndexSortBy],
    ['users', UsersSearchIndexSortBy],
    ['collections', CollectionsSearchIndexSortBy],
    ['bounties', BountiesSearchIndexSortBy],
    ['tools', ToolsSearchIndexSortBy],
    ['comics', ComicsSearchIndexSortBy],
  ];

  it('maps every sort the current search UI can put in a URL to a distinct new sort', () => {
    for (const [index, sortBys] of legacy) {
      const mapped = sortBys.map((sortBy) => sortFromLegacySortBy(index, sortBy));
      expect(mapped, index).not.toContain(undefined);
      expect(new Set(mapped).size, index).toBe(sortBys.length);
    }
  });

  it('maps the old bounties "Newest" option to newest, not to the oldest-first order it served', () => {
    expect(sortFromLegacySortBy('bounties', 'bounties_v3:createdAt')).toBe('newest');
  });

  it('maps a sort from an older index version and refuses one for another index', () => {
    expect(sortFromLegacySortBy('models', 'models_v8:metrics.downloadCount:desc')).toBe(
      'mostDownloaded'
    );
    expect(sortFromLegacySortBy('models', 'articles_v5:createdAt:desc')).toBeUndefined();
    expect(sortFromLegacySortBy('models', 'models_v9:metrics.nope:desc')).toBeUndefined();
  });
});
