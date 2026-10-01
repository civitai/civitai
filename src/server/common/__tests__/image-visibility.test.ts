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
  // Pins the whole shape, not keywords: a string match still passes with OR and AND swapped,
  // which would expose every mod-rated ToS removal.
  it('renders scanned OR (mod-rated AND not terminal AND not an unqualified Error lock)', () => {
    expect(render()).toBe(
      '( "i"."ingestion" = Scanned::"ImageIngestionStatus" ' +
        'OR ( "i"."nsfwLevelLocked" = TRUE ' +
        'AND "i"."ingestion" NOT IN (Blocked::"ImageIngestionStatus",NotFound::"ImageIngestionStatus") ' +
        'AND NOT ( "i"."ingestion" = Error::"ImageIngestionStatus" ' +
        `AND ( COALESCE("i"."metadata"->>'nsfwLevelReason', '') = Knights Vote ` +
        `OR COALESCE("i"."scanJobs"->'error'->>'failureClass', '') = permanent ) ) ) )`
    );
  });

  it('keeps the terminal exclusion inside the mod-rated branch, not the top level', () => {
    const sql = render();
    const orIndex = sql.indexOf('OR');
    // Both halves of the mod-rated branch must sit after the OR: if NOT IN escaped to
    // the top level it would filter Scanned images too, and if the AND became an OR a
    // mod rating alone would satisfy the predicate.
    expect(sql.indexOf('nsfwLevelLocked')).toBeGreaterThan(orIndex);
    expect(sql.indexOf('NOT IN')).toBeGreaterThan(sql.indexOf('nsfwLevelLocked'));
    expect(sql).not.toMatch(/nsfwLevelLocked"\s*=\s*TRUE\s*\)?\s*OR/);
  });

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
    expect(isImageReviewed({ nsfwLevelReason: null, scanFailureClass: null, ...input })).toBe(
      expected
    );
  });
});
