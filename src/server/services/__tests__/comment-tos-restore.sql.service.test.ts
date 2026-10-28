import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Setting `tosViolation` was a one-way door: nothing in the main app or the moderator spoke cleared it,
 * there is no comment equivalent of `restoreImages`, and a ban purge can set it across a whole account
 * in one click. So a false positive had no route back.
 *
 * The reversal is easy to write and easy to get subtly wrong, in ways nothing else would catch:
 *
 *  - Reopening every non-Pending report would sweep up ones a moderator DISMISSED on their own
 *    judgement and put them back in the queue. Only what this flag ACTIONED may reopen.
 *  - Reopening to Dismissed rather than Pending would silently rule on reports nobody looked at.
 *  - Counting submitted ids rather than updated rows would report a restore that restored nothing.
 *
 * Each is invisible in the return shape, so these read the emitted SQL.
 */

const statements: string[] = [];
/** Ids whose clear finds no row, as for a comment that is gone. */
const missing = new Set<number>();

const record = (first: unknown, rest: unknown[]) => {
  const text =
    Array.isArray(first) && Array.isArray((first as unknown as TemplateStringsArray).raw)
      ? (first as string[]).reduce((acc, chunk, i) => acc + (i ? `$${i}` : '') + chunk, '')
      : String(first);
  statements.push(text);
  // The clear: an unheld author's comment, cleared.
  if (text.includes('WITH target AS'))
    return rest.some((v) => typeof v === 'number' && missing.has(v))
      ? []
      : [{ userId: 1, held: false, cleared: true }];
  return [] as unknown[];
};
/** The statement that reopens reports. */
const reopen = () => statements.find((sql) => sql.includes('UPDATE "Report"')) ?? '';

dbMock.dbWrite.$queryRaw.mockImplementation(async (first: unknown, ...rest: unknown[]) =>
  record(first, rest)
);

const { bulkClearCommentV2TosViolation } = await import('~/server/services/commentsv2.service');
const { bulkClearCommentTosViolation } = await import('~/server/services/comment.service');

describe('clearing a comment ToS flag', () => {
  beforeEach(() => {
    statements.length = 0;
    missing.clear();
  });

  it('reopens ONLY the reports the flag actioned', async () => {
    await bulkClearCommentV2TosViolation({ ids: [7] });

    const sql = reopen();
    // `= Actioned`, never `<> Pending`: the second form also reopens a moderator's dismissal.
    expect(sql).toMatch(/r\.status = \$\d+::"ReportStatus"/);
    expect(sql).not.toMatch(/r\.status <> /);
  });

  it('reopens to Pending, so a human still rules on them', async () => {
    // The flag being wrong does not make the report wrong. Dismissing here would decide that for them.
    const { ReportStatus } = await import('~/shared/utils/prisma/enums');
    await bulkClearCommentV2TosViolation({ ids: [7] });

    const call = dbMock.dbWrite.$queryRaw.mock.calls.find(([first]) =>
      Array.from(first as string[])
        .join('')
        .includes('UPDATE "Report"')
    );
    expect(call?.slice(1)).toContain(ReportStatus.Pending);
    expect(call?.slice(1)).toContain(ReportStatus.Actioned);
  });

  it('scopes to TOSViolation reports on that comment', async () => {
    await bulkClearCommentV2TosViolation({ ids: [7] });

    const sql = reopen();
    expect(sql).toContain('"CommentV2Report"');
    expect(sql).toContain('c."commentV2Id"');
    expect(sql).toContain('r.reason =');
  });

  it('counts rows it cleared, not ids it was handed', async () => {
    // A comment already unflagged must not count, or the caller reports a restore that did nothing.
    missing.add(8);

    const result = await bulkClearCommentV2TosViolation({ ids: [7, 8] });

    expect(result.count).toBe(1);
  });

  it('does nothing at all for an empty list', async () => {
    // Not a formality: an unguarded loop would emit a bare UPDATE with no id bound.
    const result = await bulkClearCommentV2TosViolation({ ids: [] });

    expect(result).toEqual({ count: 0, reopenedReports: 0, retainedHidden: 0 });
    expect(statements).toHaveLength(0);
  });

  it('the legacy twin carries the same predicate against its own report table', async () => {
    // v1 deliberately does NOT reuse `updateCommentReportStatusByReason`, whose `<> target` guard is
    // wrong for reopening. If it ever starts reusing it, this fails.
    await bulkClearCommentTosViolation({ ids: [7] });

    const sql = reopen();
    expect(sql).toContain('"CommentReport"');
    expect(sql).toContain('c."commentId"');
    expect(sql).not.toMatch(/r\.status <> /);
  });
});
