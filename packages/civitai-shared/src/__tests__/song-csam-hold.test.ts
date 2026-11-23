import { describe, expect, it } from 'vitest';
import { lockSongCsamHoldSql, releaseSongCsamHoldSql, songIdOfCoverSql } from '../song-csam-hold';

// The builders splice their alias and ids into SQL text, so each refuses anything else.
describe('song csam hold SQL builders', () => {
  it('refuse an alias that is not a plain identifier', () => {
    expect(() => songIdOfCoverSql('c')).not.toThrow();
    expect(() => songIdOfCoverSql('c; DROP TABLE "Image"')).toThrow(/alias/);
    expect(() => songIdOfCoverSql('"c"')).toThrow(/alias/);
  });

  it('refuse an id that is not a positive int4', () => {
    for (const bad of [0, -1, 1.5, 2 ** 31, Number.NaN]) {
      expect(() => releaseSongCsamHoldSql({ source: 'lyrics', songIds: [bad] })).toThrow(/id/);
      expect(() => lockSongCsamHoldSql({ source: 'cover', coverIds: [bad] })).toThrow(/id/);
    }
    expect(() =>
      releaseSongCsamHoldSql({ source: 'lyrics', songIds: [2 ** 31 - 1] })
    ).not.toThrow();
  });

  it('build nothing for no ids', () => {
    expect(releaseSongCsamHoldSql({ source: 'lyrics', songIds: [] })).toBeNull();
    expect(lockSongCsamHoldSql({ source: 'cover', coverIds: [] })).toBeNull();
  });
});
