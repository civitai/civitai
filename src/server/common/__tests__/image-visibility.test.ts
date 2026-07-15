import { describe, it, expect } from 'vitest';
import { imageReviewedSql } from '~/server/common/image-visibility';

const render = (alias?: string) => {
  const sql = alias ? imageReviewedSql(alias) : imageReviewedSql();
  return sql.strings
    .reduce((acc, s, i) => acc + s + (i < sql.values.length ? String(sql.values[i]) : ''), '')
    .replace(/\s+/g, ' ')
    .trim();
};

describe('imageReviewedSql', () => {
  // Pins the whole shape, not keywords. A string-match test would still pass with the
  // OR and AND swapped — which is the one mistake that would expose every mod-rated
  // ToS removal (311 Blocked rows in prod when this was written).
  it('renders scanned OR (mod-rated AND not terminal)', () => {
    expect(render()).toBe(
      '( "i"."ingestion" = Scanned::"ImageIngestionStatus" ' +
        'OR ( "i"."nsfwLevelLocked" = TRUE ' +
        'AND "i"."ingestion" NOT IN (Blocked::"ImageIngestionStatus",Error::"ImageIngestionStatus",NotFound::"ImageIngestionStatus") ) )'
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

  it('excludes every terminal state a mod rating must not override', () => {
    for (const terminal of ['Blocked', 'Error', 'NotFound']) {
      expect(render()).toContain(`${terminal}::"ImageIngestionStatus"`);
    }
  });

  it('honours an alias override', () => {
    expect(render('img')).toContain('"img"."ingestion"');
    expect(render('img')).not.toContain('"i"."ingestion"');
  });
});
