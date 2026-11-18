import { describe, expect, it } from 'vitest';
import { levelName } from './rating-guide';

describe('levelName', () => {
  it('names each rating level the way the guide does', () => {
    expect(['PG', 'PG-13', 'R', 'X', 'XXX', 'Blocked'].map(levelName)).toEqual([
      'Safe for all',
      'Suggestive',
      'Mature',
      'Explicit',
      'Hardcore',
      'Not allowed',
    ]);
  });

  it('falls back to no name for a label it does not know', () => {
    expect(levelName('?')).toBeNull();
  });
});
