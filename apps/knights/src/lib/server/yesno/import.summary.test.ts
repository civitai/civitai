import { describe, expect, it } from 'vitest';
import { formatImportSummary, type ImportResult } from './import';

describe('formatImportSummary', () => {
  it('prints a number for every count, including retired and reopened', () => {
    const result: ImportResult = {
      inserted: 1,
      updated: 2,
      unchanged: 3,
      refused: 4,
      moderated: 5,
      retired: 6,
      revived: 7,
      axes: 8,
    };
    expect(formatImportSummary(result)).toBe(
      '8 axes; 1 inserted, 2 updated, 3 unchanged, 4 refused (changed but already answered), 5 skipped (moderated), 6 retired, 7 reworded copies reopened.'
    );
  });
});
