import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAutoLabel } from '../routes/trainingFlow';
import {
  buildTagExcluder,
  JUNK_TAGS,
  loadTagCategories,
  type TagCategories,
} from './autolabel-exclude';

const categories: TagCategories = {
  character: new Set(['hatsune miku']),
  source: new Set(['vocaloid', 'hat']),
};
const defaults = { never: JUNK_TAGS, categories, excludeCharacter: true, excludeSource: true };
const tagsAfter = (tags: string[], opts: Parameters<typeof buildTagExcluder>[0]) =>
  mergeAutoLabel({ tags: [], caption: '' }, { tags }, 'tag', 'replace', buildTagExcluder(opts))
    .tags;

// Raw tagger output keeps `_`; the excluder folds it to match the space-form lists.
const creatorCase = [
  'lowres',
  'best_quality',
  'hatsune_miku',
  'vocaloid',
  'oekaki',
  '1girl',
  'boyshort_panties',
];

describe('auto-label exclusion', () => {
  it('drops junk, character and source-material tags by default, and a typed entry catches its longer forms', () => {
    expect(tagsAfter(creatorCase, { ...defaults, never: [...JUNK_TAGS, 'boyshorts'] })).toEqual([
      '1girl',
    ]);
  });

  it('keeps character and source-material tags with both switches off, still dropping junk', () => {
    expect(
      tagsAfter(creatorCase, { ...defaults, excludeCharacter: false, excludeSource: false })
    ).toEqual(['hatsune_miku', 'vocaloid', '1girl', 'boyshort_panties']);
  });

  it('lets a junk tag through once its chip is removed', () => {
    const never = JUNK_TAGS.filter((t) => t !== 'official art');
    expect(tagsAfter(['official_art', 'lowres'], { ...defaults, never })).toEqual(['official_art']);
  });

  it('matches junk and category names exactly: they never prefix-drop a longer general tag', () => {
    expect(
      tagsAfter(['hat', 'hat ribbon', 'parody', 'parody of x', 'lowres', 'lowres scan'], defaults)
    ).toEqual(['hat ribbon', 'parody of x', 'lowres scan']);
  });

  it('the shipped category map names real tagger characters and sources', async () => {
    const real = await loadTagCategories();
    expect(real.character.has('hatsune miku')).toBe(true);
    expect(real.source.has('vocaloid')).toBe(true);
    expect(real.character.has('1girl') || real.source.has('1girl')).toBe(false);
  });
});

describe('loadTagCategories', () => {
  afterEach(() => {
    vi.doUnmock('./data/tag-categories.json');
    vi.resetModules();
  });

  it('retries after a failed chunk load instead of caching the failure', async () => {
    vi.resetModules();
    vi.doMock('./data/tag-categories.json', () => {
      throw new Error('chunk load failed');
    });
    const { loadTagCategories: load } = await import('./autolabel-exclude');
    await expect(load()).rejects.toThrow();
    vi.doUnmock('./data/tag-categories.json');
    const cats = await load();
    expect(cats.character.has('hatsune miku')).toBe(true);
  });
});
