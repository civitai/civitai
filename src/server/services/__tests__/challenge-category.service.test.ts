import { describe, expect, it } from 'vitest';

// No ~/server/db/client mock on purpose: the service imports it lazily and falls back to the
// preset constants when the import/query fails, which is exactly the pre-seed behavior these
// tests pin down. (In prod the same path covers an env whose ChallengeCategory table hasn't
// been created/seeded yet — migrations are applied manually.)
import {
  assertCategoryActiveAllowed,
  getJudgingCategoryOptions,
  pickCategoryRubric,
  resolveJudgingCategories,
  resolveRubricBlock,
  type ChallengeCategoryRow,
} from '~/server/services/challenge-category.service';
import { CHALLENGE_PRESET_CATEGORIES } from '~/shared/constants/challenge.constants';

const row = (overrides: Partial<ChallengeCategoryRow> & { key: string }): ChallengeCategoryRow => ({
  label: overrides.key,
  group: 'Universal',
  criteria: 'terse criteria',
  rubric: null,
  rubricNsfw: null,
  sortOrder: 0,
  active: true,
  ...overrides,
});

describe('pickCategoryRubric precedence', () => {
  const category = { key: 'theme', name: 'Theme', criteria: 'stored criteria' };

  it('DB nsfw override wins when nsfw is requested', () => {
    const r = row({ key: 'theme', rubric: 'DB SFW', rubricNsfw: 'DB NSFW' });
    expect(pickCategoryRubric(r, category, { nsfw: true })).toBe('DB NSFW');
  });

  it('nsfw request falls back to the SFW rubric when no nsfw variant exists', () => {
    const r = row({ key: 'theme', rubric: 'DB SFW' });
    expect(pickCategoryRubric(r, category, { nsfw: true })).toBe('DB SFW');
  });

  it('uses the DB rubric when present', () => {
    const r = row({ key: 'theme', rubric: 'DB SFW' });
    expect(pickCategoryRubric(r, category)).toBe('DB SFW');
  });

  it('derives from the DB row label + criteria when the row has no rubric (structurally-seeded env)', () => {
    const r = row({ key: 'theme', label: 'Theme', criteria: 'stored criteria' });
    expect(pickCategoryRubric(r, category)).toBe('THEME SCORING (0-10):\nstored criteria');
  });

  it('derives from the DB row label + criteria for an un-authored category', () => {
    const r = row({ key: 'dread', label: 'Dread', criteria: 'sense of dread' });
    expect(pickCategoryRubric(r, { key: 'dread' })).toBe('DREAD SCORING (0-10):\nsense of dread');
  });

  it('derives from the category name/criteria when there is no DB row and no legacy rubric', () => {
    expect(
      pickCategoryRubric(undefined, { key: 'newcat', name: 'New Cat', criteria: 'is new' })
    ).toBe('NEW CAT SCORING (0-10):\nis new');
  });
});

describe('preset fallback (no DB available)', () => {
  it('getJudgingCategoryOptions returns the preset library without rubric columns', async () => {
    const options = await getJudgingCategoryOptions();
    expect(options.map((o) => o.key)).toContain('theme');
    expect(options.find((o) => o.key === 'theme')?.label).toBe(
      CHALLENGE_PRESET_CATEGORIES.theme.label
    );
    for (const o of options) {
      expect(o).not.toHaveProperty('rubric');
      expect(o).not.toHaveProperty('rubricNsfw');
    }
  });

  it('resolveJudgingCategories derives label/criteria and ignores client-sent text', async () => {
    const resolved = await resolveJudgingCategories([
      { key: 'theme', weight: 60 },
      { key: 'humor', weight: 40 },
    ]);
    expect(resolved).toEqual([
      {
        key: 'theme',
        weight: 60,
        label: CHALLENGE_PRESET_CATEGORIES.theme.label,
        criteria: CHALLENGE_PRESET_CATEGORIES.theme.criteria,
      },
      {
        key: 'humor',
        weight: 40,
        label: CHALLENGE_PRESET_CATEGORIES.humor.label,
        criteria: CHALLENGE_PRESET_CATEGORIES.humor.criteria,
      },
    ]);
  });

  it('resolveJudgingCategories throws on an unknown key', async () => {
    await expect(
      resolveJudgingCategories([{ key: 'not-a-category', weight: 100 }])
    ).rejects.toThrow(/Unknown judging category/);
  });

  it('resolveRubricBlock derives per-key blocks from the preset library when the DB is unavailable', async () => {
    const block = await resolveRubricBlock([{ key: 'theme' }, { key: 'aesthetic' }]);
    const derive = (k: 'theme' | 'aesthetic') =>
      `${CHALLENGE_PRESET_CATEGORIES[k].label.toUpperCase()} SCORING (0-10):\n${CHALLENGE_PRESET_CATEGORIES[k].criteria}`.trim();
    expect(block).toBe([derive('theme'), derive('aesthetic')].join('\n\n'));
  });
});

describe('assertCategoryActiveAllowed', () => {
  it('rejects deactivating the theme category', () => {
    expect(() => assertCategoryActiveAllowed('theme', false)).toThrow(/theme category cannot/i);
  });
  it('allows deactivating a non-theme category', () => {
    expect(() => assertCategoryActiveAllowed('humor', false)).not.toThrow();
  });
  it('allows keeping theme active', () => {
    expect(() => assertCategoryActiveAllowed('theme', true)).not.toThrow();
  });
});
