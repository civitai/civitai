import { describe, it, expect } from 'vitest';
import { imageReviewedSql } from '~/server/common/image-visibility';

// Guards the rule, not the formatting: a mod-locked rating stands in for a scan that
// never landed, but must never resurrect Blocked/Error/NotFound. Dropping that half
// would expose every mod-rated ToS removal (311 rows in prod when this was written).
const render = (alias?: string) => {
  const sql = alias ? imageReviewedSql(alias) : imageReviewedSql();
  return sql.strings.reduce((acc, s, i) => acc + s + (sql.values[i] ?? ''), '');
};

describe('imageReviewedSql', () => {
  it('accepts Scanned', () => {
    expect(render()).toContain('Scanned');
  });

  it('accepts a mod-locked rating in place of a scan', () => {
    const sql = render();
    expect(sql).toContain('nsfwLevelLocked');
    expect(sql).toMatch(/nsfwLevelLocked"?\s*=\s*TRUE/);
  });

  it('never lets a mod rating override Blocked, Error or NotFound', () => {
    const sql = render();
    expect(sql).toContain('NOT IN');
    for (const terminal of ['Blocked', 'Error', 'NotFound']) {
      expect(sql).toContain(terminal);
    }
  });

  it('defaults to the `i` alias and honours an override', () => {
    expect(render()).toContain('"i"."ingestion"');
    expect(render('img')).toContain('"img"."ingestion"');
  });
});
