import { describe, expect, it } from 'vitest';
import { songIdOfCoverSql } from '../song-csam-hold';

describe('song csam hold SQL builders', () => {
  it('refuse an alias that would splice SQL', () => {
    expect(() => songIdOfCoverSql('c; DROP TABLE "Image"')).toThrow(/alias/);
  });
});
