import { describe, it, expect } from 'vitest';
import {
  CATEGORY_RUBRICS,
  CATEGORY_RUBRICS_NSFW,
  getCategoryRubric,
} from './category-rubrics';
import {
  CHALLENGE_CATEGORY_KEYS,
  CHALLENGE_PRESET_CATEGORIES,
} from '~/shared/constants/challenge.constants';

describe('getCategoryRubric', () => {
  it('returns the rich rubric verbatim for a default category', () => {
    expect(getCategoryRubric('theme')).toBe(CATEGORY_RUBRICS.theme);
    expect(getCategoryRubric('theme')).toContain('THEME SCORING (0-10):');
  });

  it('returns the rich rubric for all four authored defaults', () => {
    for (const key of ['theme', 'wittiness', 'humor', 'aesthetic'] as const) {
      expect(getCategoryRubric(key)).toBe(CATEGORY_RUBRICS[key]);
    }
  });

  it('falls back to CATEGORY_RUBRICS when nsfw is requested but no override exists', () => {
    expect(getCategoryRubric('theme', { nsfw: true })).toBe(CATEGORY_RUBRICS.theme);
  });

  it('prefers the NSFW override over the canonical rubric when present', () => {
    const original = CATEGORY_RUBRICS_NSFW.theme;
    CATEGORY_RUBRICS_NSFW.theme = 'NSFW THEME SCORING (0-10):\nfixture override text.';

    try {
      expect(getCategoryRubric('theme', { nsfw: true })).toBe(
        'NSFW THEME SCORING (0-10):\nfixture override text.'
      );
      // Non-nsfw lookups must be unaffected by the override.
      expect(getCategoryRubric('theme')).toBe(CATEGORY_RUBRICS.theme);
    } finally {
      if (original === undefined) delete CATEGORY_RUBRICS_NSFW.theme;
      else CATEGORY_RUBRICS_NSFW.theme = original;
    }
  });

  it('builds a criteria-derived fallback for a non-default preset (gruesomeness)', () => {
    const preset = CHALLENGE_PRESET_CATEGORIES.gruesomeness;
    expect(getCategoryRubric('gruesomeness')).toBe(
      `${preset.label.toUpperCase()} SCORING (0-10):\n${preset.criteria}`
    );
  });

  it('applies the same criteria-derived fallback shape when nsfw is requested for a non-default preset', () => {
    const preset = CHALLENGE_PRESET_CATEGORIES.gruesomeness;
    expect(getCategoryRubric('gruesomeness', { nsfw: true })).toBe(
      `${preset.label.toUpperCase()} SCORING (0-10):\n${preset.criteria}`
    );
  });

  it('never returns an empty rubric for any known category key', () => {
    for (const key of CHALLENGE_CATEGORY_KEYS) {
      const rubric = getCategoryRubric(key);
      expect(typeof rubric).toBe('string');
      expect(rubric.length).toBeGreaterThan(0);

      const rubricNsfw = getCategoryRubric(key, { nsfw: true });
      expect(typeof rubricNsfw).toBe('string');
      expect(rubricNsfw.length).toBeGreaterThan(0);
    }
  });
});
