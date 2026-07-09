import { describe, expect, it } from 'vitest';
import {
  resolveInitialCustomizeCategories,
  resolveModJudgingCategoriesSubmission,
} from '../ChallengeUpsertForm';
import { DEFAULT_CATEGORY_ROWS } from '~/shared/constants/challenge.constants';

/**
 * Covers the D6-seed "Customize judging categories" toggle for mods: initial toggle state and
 * the submit-payload decision (off -> null, no sum-100 rejection; on -> validated array). The
 * surrounding RHF/Mantine render (Switch wiring, CategoryWeights show/hide, seed-on-toggle-on via
 * form.setValue) is exercised via the `component-preview` skill / manual verification, not here.
 */
describe('resolveInitialCustomizeCategories', () => {
  it('is ON for the user variant regardless of editing/category state', () => {
    expect(
      resolveInitialCustomizeCategories({ isUser: true, isEditing: true, existingCategories: null })
    ).toBe(true);
    expect(
      resolveInitialCustomizeCategories({ isUser: true, isEditing: false, existingCategories: [] })
    ).toBe(true);
  });

  it('is ON for a new (not-yet-created) mod challenge', () => {
    expect(
      resolveInitialCustomizeCategories({
        isUser: false,
        isEditing: false,
        existingCategories: undefined,
      })
    ).toBe(true);
  });

  it('is ON when a mod edits an existing challenge that already has categories', () => {
    expect(
      resolveInitialCustomizeCategories({
        isUser: false,
        isEditing: true,
        existingCategories: DEFAULT_CATEGORY_ROWS,
      })
    ).toBe(true);
  });

  it('is OFF when a mod edits an existing challenge with no categories (no silent conversion)', () => {
    expect(
      resolveInitialCustomizeCategories({ isUser: false, isEditing: true, existingCategories: null })
    ).toBe(false);
    expect(
      resolveInitialCustomizeCategories({
        isUser: false,
        isEditing: true,
        existingCategories: undefined,
      })
    ).toBe(false);
    expect(
      resolveInitialCustomizeCategories({ isUser: false, isEditing: true, existingCategories: [] })
    ).toBe(false);
  });
});

describe('resolveModJudgingCategoriesSubmission', () => {
  it('submits null and skips the sum-100 validation when the toggle is off, even with stale/invalid rows', () => {
    const invalidRows = [{ ...DEFAULT_CATEGORY_ROWS[0], weight: 999 }]; // would fail sum-100 + no-theme-only checks if validated
    expect(resolveModJudgingCategoriesSubmission(false, invalidRows)).toEqual({
      success: true,
      data: null,
    });
    expect(resolveModJudgingCategoriesSubmission(false, [])).toEqual({ success: true, data: null });
  });

  it('submits the validated array when the toggle is on and categories are valid', () => {
    const result = resolveModJudgingCategoriesSubmission(true, DEFAULT_CATEGORY_ROWS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(DEFAULT_CATEGORY_ROWS);
    }
  });

  it('rejects with a message when the toggle is on and weights do not sum to 100', () => {
    const badRows = DEFAULT_CATEGORY_ROWS.map((row, i) => (i === 0 ? { ...row, weight: 1 } : row));
    const result = resolveModJudgingCategoriesSubmission(true, badRows);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toMatch(/100/);
    }
  });

  it('rejects when the toggle is on and the theme row is missing', () => {
    const noTheme = DEFAULT_CATEGORY_ROWS.filter((row) => row.key !== 'theme');
    const result = resolveModJudgingCategoriesSubmission(true, noTheme);
    expect(result.success).toBe(false);
  });
});
