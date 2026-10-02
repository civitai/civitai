import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Which model an image's hash credits is decided twice: `get_image_resources()` answers for the
 * image page, `prefersHashMatch` answers for the generator. Nothing executes the SQL in a test, so
 * the two can only be compared textually — and they have already drifted once, in opposite
 * directions on the date term (fixed 2026-09-15), which credited the original creator on one
 * surface and the re-uploader on the other for the same file.
 *
 * Two properties are pinned here because each was a live defect:
 *
 *   1. The official preference outranks the date. A hash is a statement about BYTES, so when the
 *      same bytes sit on an official version and a community re-host, the official page is the
 *      answer. Ordered by date alone, an official model published after a mirror of its own weights
 *      lost the credit, and reclaiming it took per-version SQL.
 *
 *   2. `excludeFromAutoDetection` filters CANDIDATES, not winners. It used to sit in the final
 *      SELECT, after row_number had already chosen one row per (image, hash): the excluded version
 *      still won its partition and was then dropped, so the slot came back empty rather than
 *      passing to the next candidate. Used twice on that assumption, it removed 331 attributions
 *      and reassigned none.
 */

const repoRoot = join(__dirname, '../../../..');
const sql = readFileSync(
  join(repoRoot, 'packages/civitai-db-schema/prisma/programmability/get_image_resources.sql'),
  'utf-8'
);
const service = readFileSync(
  join(repoRoot, 'src/server/services/generation/generation.service.ts'),
  'utf-8'
);

/**
 * Every window-function ORDER BY that ranks the files sharing one hash. Matched by LINE rather than
 * by a balanced-paren regex: the clause is full of `IIF(...)` calls, so `[^)]*` stops at the first
 * one and silently yields nothing to assert against.
 */
const rankingClauses = sql.split('\n').filter((line) => line.includes('row_number() OVER ('));

describe('the hash tie-break is stated the same way in both implementations', () => {
  it('ranks on is_official in every SQL ranking clause', () => {
    expect(rankingClauses.length, 'no row_number ORDER BY found — the SQL shape changed').toBe(2);
    for (const clause of rankingClauses)
      expect(clause, `ranking clause without an is_official term: ${clause}`).toMatch(
        /IIF\(is_official,0,1\)/
      );
  });

  it('puts is_official BEFORE version_date in the SQL', () => {
    // Reversed, the rule silently becomes "earliest upload wins" again — every assertion above
    // still passes, and the only symptom is an official model losing its own bytes.
    for (const clause of rankingClauses) {
      const official = clause.indexOf('IIF(is_official,0,1)');
      const date = clause.indexOf('version_date');
      expect(official).toBeGreaterThan(-1);
      expect(date).toBeGreaterThan(-1);
      expect(official, `is_official must outrank version_date in: ${clause}`).toBeLessThan(date);
    }
  });

  it('selects is_official in the merge CTE that the ranking reads', () => {
    expect(sql).toMatch(/COALESCE\(m\."isOfficial", false\) AS is_official/);
  });

  it('applies excludeFromAutoDetection as a candidate filter, not to the final rows', () => {
    const merge = sql.slice(
      sql.indexOf('image_resource_merge AS ('),
      sql.indexOf('image_resource_id AS (')
    );
    expect(merge, 'the exclusion is not in image_resource_merge').toMatch(
      /excludeFromAutoDetection/
    );

    const finalSelect = sql.slice(sql.indexOf('FROM image_resource_id iri'));
    expect(
      finalSelect,
      'the exclusion is back in the final SELECT, where it empties the slot instead of passing it on'
    ).not.toMatch(/excludeFromAutoDetection/);
  });

  it('compares isOfficial before versionDate in prefersHashMatch', () => {
    const body = service.slice(
      service.indexOf('export function prefersHashMatch'),
      service.indexOf('export function prefersHashMatch') + 900
    );
    const official = body.indexOf('isOfficial');
    const date = body.indexOf('versionDate');
    expect(official, 'prefersHashMatch does not read isOfficial').toBeGreaterThan(-1);
    expect(date).toBeGreaterThan(-1);
    expect(official, 'isOfficial must be compared before versionDate').toBeLessThan(date);
  });

  it('reads isOfficial from the query that feeds it', () => {
    expect(service).toMatch(/COALESCE\(m\."isOfficial", false\) AS "isOfficial"/);
  });
});
