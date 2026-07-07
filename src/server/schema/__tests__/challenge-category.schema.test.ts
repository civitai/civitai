import { describe, it, expect } from 'vitest';
import { challengeJudgingCategoriesSchema } from '~/server/schema/challenge.schema';

const theme = { key: 'theme', label: 'Theme', criteria: 'fit', weight: 100 } as const;

describe('challengeJudgingCategoriesSchema', () => {
  it('accepts a single mandatory Theme at 100%', () => {
    expect(challengeJudgingCategoriesSchema.safeParse([theme]).success).toBe(true);
  });
  it('accepts Theme + up to 3 more summing to 100', () => {
    const cats = [
      { key: 'theme', label: 'Theme', criteria: 'fit', weight: 40 },
      { key: 'humor', label: 'Humor', criteria: 'funny', weight: 30 },
      { key: 'custom', label: 'Color', criteria: 'palette', weight: 30 },
    ];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(true);
  });
  it('rejects when Theme is missing', () => {
    const cats = [{ key: 'humor', label: 'Humor', criteria: 'funny', weight: 100 }];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
  it('rejects when weights do not sum to 100', () => {
    const cats = [{ key: 'theme', label: 'Theme', criteria: 'fit', weight: 90 }];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
  it('rejects more than 4 categories', () => {
    const cats = [
      { key: 'theme', label: 'Theme', criteria: 'x', weight: 20 },
      { key: 'humor', label: 'Humor', criteria: 'x', weight: 20 },
      { key: 'wittiness', label: 'Wittiness', criteria: 'x', weight: 20 },
      { key: 'aesthetic', label: 'Aesthetic', criteria: 'x', weight: 20 },
      { key: 'custom', label: 'Extra', criteria: 'x', weight: 20 },
    ];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
  it('rejects duplicate preset keys', () => {
    const cats = [
      { key: 'theme', label: 'Theme', criteria: 'x', weight: 50 },
      { key: 'theme', label: 'Theme', criteria: 'x', weight: 50 },
    ];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
});
