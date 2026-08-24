import { vi, describe, it, expect, beforeEach } from 'vitest';
import type * as ReportService from '~/server/services/report.service';

import { BlocklistType } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const createReport = vi.fn();
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  createReport: (...args: unknown[]) => createReport(...args),
}));

import { reportBlockedMessagePattern } from '../message-pattern.service';

/** getBlocklistData reads redis first, so a cached value drives the whole path without a DB. */
const setPatterns = (patterns: string[]) =>
  redisMock.redis.get.mockResolvedValue(
    JSON.stringify({ type: BlocklistType.MessagePattern, data: patterns })
  );

const comment = (content: string) => ({
  type: 'CommentV2' as const,
  entityId: 42,
  userId: 7,
  content,
});

describe('reportBlockedMessagePattern', () => {
  beforeEach(() => {
    // clearAllMocks drops recorded calls, NOT implementations — without this the dedup test's
    // "a report already exists" leaks into every test after it and silently disables the path.
    vi.clearAllMocks();
    createReport.mockResolvedValue({ id: 1 });
    dbMock.dbRead.report.findFirst.mockResolvedValue(null);
    redisMock.redis.get.mockResolvedValue(null);
  });

  it('reports a comment carrying a blocked pattern, and does not throw at the author', async () => {
    setPatterns(['claim your free nitro']);

    await expect(
      reportBlockedMessagePattern(comment('Claim your FREE NITRO at evil.example'))
    ).resolves.toBeUndefined();

    expect(createReport).toHaveBeenCalledTimes(1);
    const [args] = createReport.mock.calls[0] as [Record<string, never>];
    expect(args).toMatchObject({
      type: 'commentV2',
      id: 42,
      // The system user files it, not the author — otherwise the account is recorded as having
      // reported its own comment, and the author-facing report notifications key off that id.
      userId: -1,
      isModerator: true,
      reason: 'Automated',
      details: { tags: ['claim your free nitro'], userId: 7 },
    });
    expect(dbMock.dbWrite.reportAutomated.create).toHaveBeenCalledWith({
      data: {
        reportId: 1,
        metadata: {
          tags: ['claim your free nitro'],
          value: 'Claim your FREE NITRO at evil.example',
        },
      },
    });
  });

  it('reports nothing when no pattern matches', async () => {
    setPatterns(['claim your free nitro']);

    await reportBlockedMessagePattern(comment('nice model, thanks for sharing'));

    expect(createReport).not.toHaveBeenCalled();
  });

  it('does not report the same comment twice — an edit re-runs this, and Automated skips dedup', async () => {
    setPatterns(['claim your free nitro']);
    dbMock.dbRead.report.findFirst.mockResolvedValue({ id: 99 });

    await reportBlockedMessagePattern(comment('claim your free nitro'));

    expect(createReport).not.toHaveBeenCalled();
    // Scoped to THIS comment. Unscoped, one pending automated report anywhere in a 644k-row queue
    // switches every future message-pattern report off site-wide.
    expect(dbMock.dbRead.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          commentV2: { commentV2Id: 42 },
          reason: 'Automated',
          status: 'Pending',
        }),
      })
    );
  });

  it('reports a legacy model comment against the other table', async () => {
    setPatterns(['claim your free nitro']);

    await reportBlockedMessagePattern({
      ...comment('claim your free nitro'),
      type: 'Comment',
    });

    expect(dbMock.dbRead.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ comment: { commentId: 42 } }) })
    );
    expect(createReport.mock.calls[0][0]).toMatchObject({ type: 'comment' });
  });

  it('skips moderators', async () => {
    setPatterns(['claim your free nitro']);

    await reportBlockedMessagePattern({ ...comment('claim your free nitro'), isModerator: true });

    expect(createReport).not.toHaveBeenCalled();
  });

  it('swallows a failure to report — the comment has already posted', async () => {
    setPatterns(['claim your free nitro']);
    createReport.mockRejectedValue(new Error('report table on fire'));

    await expect(
      reportBlockedMessagePattern(comment('claim your free nitro'))
    ).resolves.toBeUndefined();
    // Silence is this path's whole failure mode, so the log is the only thing that would ever
    // surface it — an empty catch block passes the line above.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'message-pattern-report' })
    );
  });
});
