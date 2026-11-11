import { describe, it, expect } from 'vitest';
import {
  imageReviewedSql,
  isImageReviewed,
  KNIGHTS_VOTE_NSFW_LEVEL_REASON,
} from '~/server/common/image-visibility';

const render = (alias?: string) => {
  const sql = alias ? imageReviewedSql(alias) : imageReviewedSql();
  return sql.strings
    .reduce((acc, s, i) => acc + s + (i < sql.values.length ? String(sql.values[i]) : ''), '')
    .replace(/\s+/g, ' ')
    .trim();
};

describe('imageReviewedSql', () => {
  it('honours an alias override', () => {
    expect(render('img')).toContain('"img"."ingestion"');
    expect(render('img')).not.toContain('"i"."ingestion"');
  });
});

describe('isImageReviewed', () => {
  const locked = { nsfwLevelLocked: true } as const;

  it.each([
    ['a completed scan', { ingestion: 'Scanned', nsfwLevelLocked: false }, true],
    ['a mod lock on a stalled scan', { ingestion: 'Pending', ...locked }, true],
    [
      'a Knights lock on a stalled scan',
      { ingestion: 'Pending', ...locked, nsfwLevelReason: KNIGHTS_VOTE_NSFW_LEVEL_REASON },
      true,
    ],
    ['a mod lock on an errored scan', { ingestion: 'Error', ...locked }, true],
    [
      'a Knights lock on an errored scan',
      { ingestion: 'Error', ...locked, nsfwLevelReason: KNIGHTS_VOTE_NSFW_LEVEL_REASON },
      false,
    ],
    [
      'a mod lock on a permanently failed scan',
      { ingestion: 'Error', ...locked, scanFailureClass: 'permanent' },
      false,
    ],
    ['an errored scan with no lock', { ingestion: 'Error', nsfwLevelLocked: false }, false],
    ['a mod lock on a ToS removal', { ingestion: 'Blocked', ...locked }, false],
    ['a mod lock on missing media', { ingestion: 'NotFound', ...locked }, false],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(
      isImageReviewed({
        type: 'image',
        lyricsHeld: false,
        nsfwLevelReason: null,
        scanFailureClass: null,
        ...input,
      })
    ).toBe(expected);
  });
});
