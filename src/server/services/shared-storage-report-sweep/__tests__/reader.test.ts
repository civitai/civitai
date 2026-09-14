import { describe, expect, it } from 'vitest';
import { buildUserReportQuery } from '../reader';

/**
 * The structural half of the no-content guarantee.
 *
 * `run.test.ts` proves the MAPPING drops the reported content. That guard is built from a fixture,
 * so it can only ever be as good as the fixture's imagination. This one asserts the thing the
 * fixture stands in for: the query the production reader actually sends never asks for the content
 * in the first place, so there is nothing for a future mapping change to leak.
 */
describe('the per-app report query', () => {
  const sql = buildUserReportQuery('"app_ideas_board"');

  it('🔴 never selects the reported content', () => {
    // `shared_kv.value` is the title/body a user wrote and another user flagged. It stays in the
    // apps database; the abuse board is a wider-audience surface than the app's own moderation view.
    expect(sql).not.toMatch(/\bvalue\b/);
    expect(sql).not.toMatch(/\bs\.\*/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    // Positive control on the matcher: it CAN see a column name in this string, so the three
    // absences above are claims about the SQL rather than about a regex that never matches.
    expect(sql).toMatch(/\bauthor_user_id\b/);
  });

  it('selects exactly the metadata a finding is built from', () => {
    for (const column of [
      'r.id',
      'r.key',
      'r.reporter_user_id',
      'r.reason',
      'r.created_at',
      's.author_user_id',
      's.hidden_at',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('🔴 LEFT JOINs, so a report outlives the row it concerns', () => {
    // The provisioner deliberately declines to FK `shared_kv_reports.key` so a report survives a
    // purge (audit trail). An inner join would silently drop every report whose row a moderator
    // already removed — and the run would report that as "none found".
    expect(sql).toMatch(/LEFT JOIN\s+"app_ideas_board"\.shared_kv\b/);
  });

  it('takes the USER reports, not the auto-audit rows that share the table', () => {
    // Auto-audit rows are `key IS NULL` with no reporter and already have their own alerting.
    expect(sql).toContain('r.reporter_user_id IS NOT NULL');
    expect(sql).toContain('r.key IS NOT NULL');
  });

  it('is bounded on both edges of the window and on row count', () => {
    // Half-open `[since, until)`. A closed upper bound would re-file the boundary row on the next
    // run, which is the duplicate half of the cadence/window coupling.
    expect(sql).toContain('r.created_at >= $1');
    expect(sql).toContain('r.created_at <  $2');
    expect(sql).toContain('LIMIT $3');
  });

  it('parameterises the window — the schema is the only interpolated text', () => {
    // The schema identifier cannot be a bind parameter (identifiers never can), which is why it
    // arrives already quoted from `appSchemaIdent`, itself gated on `isValidAppSlug`. Everything
    // else is a placeholder.
    expect(sql).not.toMatch(/created_at\s*>=\s*'/);
    expect((sql.match(/\$\d/g) ?? []).sort()).toEqual(['$1', '$2', '$3']);
  });
});
