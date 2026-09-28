import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as Restriction from '~/server/services/user-restriction.service';
import type * as Ledger from '~/server/services/scam-case-ledger';
import type * as Cleanup from '~/server/services/scam-cleanup.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { constants } from '~/server/common/constants';

const m = vi.hoisted(() => ({
  userActivity: vi.fn(async () => undefined),
  trackModActivity: vi.fn(async () => undefined),
  applyPendingReviewMute: vi.fn(),
  runScamCleanup: vi.fn(),
  scamVerdictActioned: vi.fn(),
  lastModeratorUnmuteAt: vi.fn(),
  scamTextSeenBefore: vi.fn(),
  closeScamCasesOpenedBefore: vi.fn(async () => 0),
  appendScamTrigger: vi.fn(),
  recordScamCleanup: vi.fn(async () => undefined),
  fileScamCleanupRecord: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    userActivity = m.userActivity;
  },
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: m.trackModActivity,
}));
vi.mock('~/server/services/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Restriction>()),
  applyPendingReviewMute: m.applyPendingReviewMute,
}));
vi.mock('~/server/services/scam-cleanup.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Cleanup>()),
  runScamCleanup: m.runScamCleanup,
}));
vi.mock('~/server/services/scam-case-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof Ledger>()),
  scamVerdictActioned: m.scamVerdictActioned,
  lastModeratorUnmuteAt: m.lastModeratorUnmuteAt,
  scamTextSeenBefore: m.scamTextSeenBefore,
  closeScamCasesOpenedBefore: m.closeScamCasesOpenedBefore,
  appendScamTrigger: m.appendScamTrigger,
  recordScamCleanup: m.recordScamCleanup,
  fileScamCleanupRecord: m.fileScamCleanupRecord,
}));

const { autoMuteScamAccount } = await import('~/server/services/scam-auto-mute.service');

const DAY = 86_400_000;
const UNMUTED_AT = new Date(Date.now() - DAY);
const RECORD = {
  kind: 'comments',
  at: new Date().toISOString(),
  count: 2,
  ids: [3, 4],
  truncated: false,
};
const user = (over: Record<string, unknown> = {}) => ({
  createdAt: new Date(Date.now() - 2 * DAY),
  isModerator: false,
  muted: false,
  mutedAt: null,
  bannedAt: null,
  deletedAt: null,
  ...over,
});
const evidence = (over: Record<string, unknown> = {}) => ({
  source: 'text-scan:Comment:7',
  dedupeKey: 'wf-1',
  reason: 'Fake support',
  entityType: 'Comment',
  entityId: 7,
  text: 'DM me for the prize',
  textHash: 'h1',
  contentAt: new Date(),
  ...over,
});
const base = { userId: 42, cleanup: 'comments' as const, evidence: evidence() };

const nothingActed = () => {
  expect(m.applyPendingReviewMute).not.toHaveBeenCalled();
  expect(m.fileScamCleanupRecord).not.toHaveBeenCalled();
  expect(m.runScamCleanup).not.toHaveBeenCalled();
  expect(m.trackModActivity).not.toHaveBeenCalled();
  expect(m.userActivity).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findUnique.mockResolvedValue(user());
  m.scamVerdictActioned.mockResolvedValue(false);
  m.lastModeratorUnmuteAt.mockResolvedValue(null);
  m.scamTextSeenBefore.mockResolvedValue(false);
  m.applyPendingReviewMute.mockResolvedValue({ muted: true, userRestrictionId: 5, deduped: false });
  m.appendScamTrigger.mockResolvedValue(1);
  m.runScamCleanup.mockResolvedValue(RECORD);
  m.fileScamCleanupRecord.mockResolvedValue({ userRestrictionId: 9, index: 0, created: true });
});

describe('autoMuteScamAccount', () => {
  it('files a scam case with the verdict as its first trigger, then audits, cleans and records', async () => {
    expect(await autoMuteScamAccount(base)).toEqual({
      muted: true,
      userRestrictionId: 5,
      deduped: false,
      accountAgeDays: 2,
      cleanup: RECORD,
    });

    const call = m.applyPendingReviewMute.mock.calls[0][0];
    expect(call).toMatchObject({ userId: 42, type: 'scam', updateSource: 'scamAutoMute' });
    expect(call.triggers).toEqual([
      expect.objectContaining({
        category: 'scam',
        source: 'text-scan:Comment:7',
        dedupeKey: 'wf-1',
        reason: 'Fake support',
        entityType: 'Comment',
        entityId: 7,
        text: 'DM me for the prize',
        textHash: 'h1',
      }),
    ]);
    expect(m.trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      entityId: 42,
      activity: 'autoMuteScam',
    });
    expect(m.runScamCleanup).toHaveBeenCalledWith('comments', 42);
    expect(m.recordScamCleanup).toHaveBeenCalledWith(5, 0, 'wf-1', RECORD);
    expect(m.userActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Muted',
        targetUserId: 42,
        source: expect.stringContaining('text-scan:Comment:7'),
      })
    );
    expect(m.appendScamTrigger).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.updateMany).not.toHaveBeenCalled();
  });

  it('writes the ModActivity before any best-effort step', async () => {
    await autoMuteScamAccount(base);
    const [audit] = m.trackModActivity.mock.invocationCallOrder;
    expect(audit).toBeLessThan(m.runScamCleanup.mock.invocationCallOrder[0]);
    expect(audit).toBeLessThan(m.userActivity.mock.invocationCallOrder[0]);
  });

  it('reads the account from the primary', async () => {
    await autoMuteScamAccount(base);
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalled();
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['moderator', { isModerator: true }],
    ['deleted', { deletedAt: new Date() }],
    ['banned', { bannedAt: new Date() }],
    ['too-old', { createdAt: new Date(Date.now() - 8 * DAY - 60_000) }],
  ])('skips %s without acting', async (skipped, over) => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(user(over));
    expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped });
    nothingActed();
  });

  it('still mutes on day 7, and at any age when the age rule is waived', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(
      user({ createdAt: new Date(Date.now() - 7 * DAY - 60_000) })
    );
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, accountAgeDays: 7 });
    dbMock.dbWrite.user.findUnique.mockResolvedValue(
      user({ createdAt: new Date(Date.now() - 900 * DAY) })
    );
    expect(await autoMuteScamAccount({ ...base, ignoreAccountAge: true })).toMatchObject({
      muted: true,
      accountAgeDays: 900,
    });
  });

  it.each([constants.system.user.id, constants.system.officialUserId])(
    'never mutes protected account %s, even with the age rule waived',
    async (userId) => {
      expect(await autoMuteScamAccount({ ...base, userId, ignoreAccountAge: true })).toEqual({
        muted: false,
        skipped: userId > 0 ? 'protected' : 'invalid-user',
      });
      expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
      nothingActed();
    }
  );

  it('skips a user that does not exist', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
    expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped: 'not-found' });
    nothingActed();
  });

  it('does nothing at all for a verdict already on the ledger (redelivery or retry)', async () => {
    m.scamVerdictActioned.mockResolvedValue(true);
    expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped: 'duplicate' });
    expect(m.scamVerdictActioned).toHaveBeenCalledWith(42, 'wf-1');
    nothingActed();
  });

  describe('after a moderator unmute', () => {
    beforeEach(() => m.lastModeratorUnmuteAt.mockResolvedValue(UNMUTED_AT));

    it('does not re-mute for content written before it', async () => {
      const old = evidence({ contentAt: new Date(UNMUTED_AT.getTime() - 1000) });
      expect(await autoMuteScamAccount({ ...base, evidence: old })).toEqual({
        muted: false,
        skipped: 'unmuted-since',
      });
      nothingActed();
      expect(m.closeScamCasesOpenedBefore).not.toHaveBeenCalled();
    });

    it('mutes for content written after it, closing the case the unmute left open', async () => {
      expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true });
      expect(m.closeScamCasesOpenedBefore).toHaveBeenCalledWith(42, UNMUTED_AT);
      expect(m.closeScamCasesOpenedBefore.mock.invocationCallOrder[0]).toBeLessThan(
        m.applyPendingReviewMute.mock.invocationCallOrder[0]
      );
    });

    it('without a content time, blocks text already flagged before it', async () => {
      m.scamTextSeenBefore.mockResolvedValue(true);
      const undated = evidence({ entityType: 'User', entityId: 42, contentAt: null });
      expect(await autoMuteScamAccount({ ...base, evidence: undated })).toEqual({
        muted: false,
        skipped: 'unmuted-since',
      });
      expect(m.scamTextSeenBefore).toHaveBeenCalledWith(
        42,
        { entityType: 'User', entityId: 42, textHash: 'h1' },
        UNMUTED_AT
      );
      nothingActed();
    });

    it('without a content time, mutes for text not flagged before it', async () => {
      const undated = evidence({ entityType: 'User', entityId: 42, contentAt: null });
      expect(await autoMuteScamAccount({ ...base, evidence: undated })).toMatchObject({
        muted: true,
      });
    });
  });

  describe('when a moderator already stands behind a mute', () => {
    beforeEach(() =>
      dbMock.dbWrite.user.findUnique.mockResolvedValue(user({ muted: true, mutedAt: new Date() }))
    );

    it('opens no case, but records the verdict and its cleanup so they can be restored', async () => {
      expect(await autoMuteScamAccount(base)).toEqual({
        muted: false,
        skipped: 'moderator-muted',
        cleanup: RECORD,
      });
      expect(m.applyPendingReviewMute).not.toHaveBeenCalled();
      expect(m.fileScamCleanupRecord).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ category: 'scam', dedupeKey: 'wf-1', reason: 'Fake support' })
      );
      expect(m.runScamCleanup).toHaveBeenCalledWith('comments', 42);
      expect(m.recordScamCleanup).toHaveBeenCalledWith(9, 0, 'wf-1', RECORD);
      expect(m.trackModActivity).toHaveBeenCalledExactlyOnceWith(-1, {
        entityType: 'user',
        entityId: 42,
        activity: 'scamCleanup',
      });
      expect(m.userActivity).not.toHaveBeenCalled();
    });

    it('audits only the record it opened, not each verdict appended to it', async () => {
      m.fileScamCleanupRecord.mockResolvedValue({ userRestrictionId: 9, index: 3, created: false });
      await autoMuteScamAccount(base);
      expect(m.recordScamCleanup).toHaveBeenCalledWith(9, 3, 'wf-1', RECORD);
      expect(m.trackModActivity).not.toHaveBeenCalled();
    });

    it('does nothing when a concurrent redelivery recorded the same verdict first', async () => {
      m.fileScamCleanupRecord.mockResolvedValue(null);
      expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped: 'duplicate' });
      expect(m.runScamCleanup).not.toHaveBeenCalled();
      expect(m.trackModActivity).not.toHaveBeenCalled();
    });
  });

  it('still files a case and cleans up when the account is muted without a moderator verdict', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(user({ muted: true }));
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, deduped: false });
    expect(m.runScamCleanup).toHaveBeenCalled();
    expect(m.fileScamCleanupRecord).not.toHaveBeenCalled();
  });

  it('appends to an open case without a second audit row or ClickHouse event', async () => {
    m.applyPendingReviewMute.mockResolvedValue({
      muted: true,
      userRestrictionId: 5,
      deduped: true,
    });
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, deduped: true });
    expect(m.appendScamTrigger).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ dedupeKey: 'wf-1' })
    );
    expect(m.recordScamCleanup).toHaveBeenCalledWith(5, 1, 'wf-1', RECORD);
    expect(m.trackModActivity).not.toHaveBeenCalled();
    expect(m.userActivity).not.toHaveBeenCalled();
  });

  it('stops when a concurrent redelivery appended the same verdict first', async () => {
    m.applyPendingReviewMute.mockResolvedValue({
      muted: true,
      userRestrictionId: 5,
      deduped: true,
    });
    m.appendScamTrigger.mockResolvedValue(null);
    expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped: 'duplicate' });
    expect(m.runScamCleanup).not.toHaveBeenCalled();
  });

  it('retries once into the dedupe path when a concurrent verdict opened the case first', async () => {
    m.applyPendingReviewMute
      .mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      )
      .mockResolvedValueOnce({ muted: true, userRestrictionId: 5, deduped: true });
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, deduped: true });
    expect(m.applyPendingReviewMute).toHaveBeenCalledTimes(2);
    expect(m.trackModActivity).not.toHaveBeenCalled();
  });

  it('keeps the mute when the cleanup fails, and records nothing for it', async () => {
    m.runScamCleanup.mockRejectedValue(new Error('lock timeout'));
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, cleanup: null });
    expect(m.recordScamCleanup).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scam-auto-mute', message: 'cleanup failed' })
    );
  });

  it('touches no content for cleanup none', async () => {
    m.runScamCleanup.mockResolvedValue(null);
    expect(await autoMuteScamAccount({ ...base, cleanup: 'none' })).toMatchObject({
      muted: true,
      cleanup: null,
    });
    expect(m.recordScamCleanup).not.toHaveBeenCalled();
  });

  it('logs and returns instead of throwing', async () => {
    dbMock.dbWrite.user.findUnique.mockRejectedValue(new Error('db down'));
    expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped: 'error' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scam-auto-mute', type: 'error', userId: 42 })
    );
  });
});
