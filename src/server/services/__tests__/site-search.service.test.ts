import { describe, expect, it } from 'vitest';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';
import {
  SITE_SEARCH_INDEXES,
  shapeModelHit,
  viewerSearchClauses,
} from '~/server/services/site-search.service';
import { NsfwLevel } from '~/server/common/enums';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

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
          for (const [, attribute] of clause.matchAll(/([\w.]+)\s*(?:!=|>=|<=|=|<|>)/g)) {
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
