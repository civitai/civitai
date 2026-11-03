import { describe, expect, it } from 'vitest';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import type { Doc } from '~/server/search/__tests__/clause-reference';
import { matches } from '~/server/search/__tests__/clause-reference';
import { parseMeiliFilter, UnsupportedSearchRequest } from '~/server/search/meili-filter';
import type { SiteSearchViewer } from '~/server/services/site-search.service';
import { viewerSearchClauses, withViewerClauses } from '~/server/services/site-search.service';
import { Availability } from '~/shared/utils/prisma/enums';

// The OpenSearch path reads the same filter strings Meilisearch receives, so what each one keeps
// must be what Meilisearch keeps. The viewer's clauses are the ones that decide what a viewer may
// see, so they are checked through the real clause builder.

const filterDocs = (filter: Parameters<typeof parseMeiliFilter>[0], docs: Doc[]) => {
  const clauses = parseMeiliFilter(filter);
  return docs.filter((doc) => clauses.every((c) => matches(doc, c))).map((doc) => doc.id);
};

const model = (id: number, overrides: Doc = {}): Doc => ({
  id,
  nsfwLevel: [NsfwLevel.PG],
  poi: false,
  minor: false,
  availability: Availability.Public,
  user: { id: 1, username: 'Someone' },
  type: 'LORA',
  tags: [{ name: 'Style' }],
  lastVersionAtUnix: 1000,
  ...overrides,
});

const models = [
  model(1),
  model(2, { nsfwLevel: [NsfwLevel.PG, NsfwLevel.R] }),
  model(3, { nsfwLevel: [NsfwLevel.X] }),
  model(4, { poi: true }),
  model(5, { availability: Availability.Private }),
  model(6, { poi: true, user: { id: 42, username: 'owner' } }),
  model(7, { type: 'Checkpoint', tags: [{ name: 'anime' }], lastVersionAtUnix: 5000 }),
];

const viewerFilter = (viewer: SiteSearchViewer, clientFilter?: string | string[]) =>
  withViewerClauses(clientFilter, viewerSearchClauses(MODELS_SEARCH_INDEX, viewer)) as string[];

describe('parseMeiliFilter: the viewer clauses /api/search adds', () => {
  it('keeps POI and private models from everyone but their owner', () => {
    const all = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;
    expect(filterDocs(viewerFilter({ showSfwFace: false, browsingLevelCap: all }), models)).toEqual(
      [1, 2, 3, 7]
    );
    expect(
      filterDocs(viewerFilter({ userId: 42, showSfwFace: false, browsingLevelCap: all }), models)
    ).toEqual([1, 2, 3, 6, 7]);
  });

  it("holds every viewer, moderators included, to the site's browsing-level cap", () => {
    const cap = NsfwLevel.PG | NsfwLevel.PG13;
    const moderator = { userId: 9, isModerator: true, showSfwFace: true, browsingLevelCap: cap };
    expect(filterDocs(viewerFilter(moderator), models)).toEqual([1, 2, 4, 5, 6, 7]);
  });

  it('cannot be widened by a client filter that ORs its way around them', () => {
    const viewer = { showSfwFace: true, browsingLevelCap: NsfwLevel.PG };
    const sneaky = 'poi = true OR nsfwLevel = 8';
    expect(filterDocs(viewerFilter(viewer, sneaky), models)).toEqual([]);
  });
});

describe('parseMeiliFilter: what the search UI sends', () => {
  it("reads the browsing-level filter and the adapter's quoted facet filters", () => {
    expect(filterDocs(['nsfwLevel=1 OR nsfwLevel=2'], models)).toEqual([1, 2, 4, 5, 6, 7]);
    expect(filterDocs([['"type"="Checkpoint"', '"type"="TextualInversion"']], models)).toEqual([7]);
  });

  it('compares strings case-insensitively, as Meilisearch does', () => {
    expect(filterDocs(["tags.name = 'ANIME'"], models)).toEqual([7]);
    expect(filterDocs(["user.username = 'someone'"], models)).toContain(1);
  });

  it('reads negated autocomplete tokens, escaped quotes, ranges, IN and TO', () => {
    expect(filterDocs(["NOT tags.name = 'Style'"], models)).toEqual([7]);
    expect(
      filterDocs(["user.username = 'o\\'brien'"], [model(8, { user: { username: "O'Brien" } })])
    ).toEqual([8]);
    expect(filterDocs(['"lastVersionAtUnix">=2000'], models)).toEqual([7]);
    expect(filterDocs(['lastVersionAtUnix 0 TO 1000'], models)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(filterDocs(['type IN [Checkpoint, VAE]'], models)).toEqual([7]);
    expect(filterDocs(['type NOT IN [LORA]'], models)).toEqual([7]);
  });

  it('honours AND over OR, and parentheses', () => {
    expect(filterDocs(['poi = true OR type = Checkpoint AND minor = false'], models)).toEqual([
      4, 6, 7,
    ]);
    expect(filterDocs(['(poi = true OR type = Checkpoint) AND user.id = 42'], models)).toEqual([6]);
  });
});

describe('parseMeiliFilter: what it refuses', () => {
  it('refuses anything outside the grammar the site sends, so Meilisearch answers it', () => {
    for (const filter of [
      '_geoRadius(1, 2, 3)',
      'name CONTAINS pony',
      'name IS NULL',
      '(poi = true',
      'poi = true poi = false',
      "name = 'unterminated",
    ])
      expect(() => parseMeiliFilter([filter]), filter).toThrow(UnsupportedSearchRequest);
  });
});
