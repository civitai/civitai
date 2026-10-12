import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as Restriction from '~/server/services/user-restriction.service';
import type * as Ledger from '~/server/services/scam-case-ledger';
import type * as Cleanup from '~/server/services/scam-cleanup.service';
import type * as StrikeService from '~/server/services/strike.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { constants } from '~/server/common/constants';

const m = vi.hoisted(() => ({
  userActivity: vi.fn(async () => undefined),
  trackModActivity: vi.fn(async () => undefined),
  claimPendingReviewMute: vi.fn(),
  announcePendingReviewMute: vi.fn(async () => undefined),
  runScamCleanup: vi.fn(),
  scamVerdictActioned: vi.fn(),
  lastModeratorUnmuteAt: vi.fn(),
  scamTextSeenBefore: vi.fn(),
  closeScamCasesOpenedBefore: vi.fn(async (): Promise<number[]> => []),
  appendScamTrigger: vi.fn(),
  recordScamCleanup: vi.fn(async () => undefined),
  linkScamStrike: vi.fn(async () => false),
  restoreScamCases: vi.fn(async () => undefined),
  createStrike: vi.fn(),
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
  claimPendingReviewMute: m.claimPendingReviewMute,
  announcePendingReviewMute: m.announcePendingReviewMute,
}));
vi.mock('~/server/services/strike.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StrikeService>()),
  createStrike: m.createStrike,
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
  linkScamStrike: m.linkScamStrike,
  restoreScamCases: m.restoreScamCases,
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
  id: 42,
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
  expect(m.claimPendingReviewMute).not.toHaveBeenCalled();
  expect(m.announcePendingReviewMute).not.toHaveBeenCalled();
  expect(m.createStrike).not.toHaveBeenCalled();
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
  m.claimPendingReviewMute.mockResolvedValue({
    muted: true,
    userRestrictionId: 5,
    deduped: false,
    wasMuted: false,
  });
  m.appendScamTrigger.mockResolvedValue(1);
  m.runScamCleanup.mockResolvedValue(RECORD);
  // As the real one does: the row lands, `onCreated` runs, then escalation.
  m.createStrike.mockImplementation(
    async ({ onCreated }: { onCreated?: (strike: { id: number }) => Promise<void> }) => {
      await onCreated?.({ id: 77 });
      return { id: 77 };
    }
  );
});

describe('autoMuteScamAccount', () => {
  it('files a scam case with the verdict as its first trigger, then audits, cleans and records', async () => {
    expect(await autoMuteScamAccount(base)).toEqual({
      muted: true,
      userRestrictionId: 5,
      deduped: false,
      accountAgeDays: 2,
      strikeId: 77,
      cleanup: RECORD,
    });

    const call = m.claimPendingReviewMute.mock.calls[0][1];
    expect(call).toMatchObject({ userId: 42, type: 'scam' });
    expect(m.announcePendingReviewMute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 42, type: 'scam', updateSource: 'scamAutoMute' })
    );
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
    expect(m.trackModActivity).toHaveBeenCalledExactlyOnceWith(-1, {
      entityType: 'user',
      entityId: 42,
      activity: 'autoMuteScam',
    });
    expect(m.runScamCleanup).toHaveBeenCalledWith('comments', 42);
    expect(m.recordScamCleanup).toHaveBeenCalledWith(5, 0, 'wf-1', RECORD);
    expect(m.userActivity).toHaveBeenCalledExactlyOnceWith(
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

  it('issues one silent, non-expiring 3-point Scam strike with the public reason, and records it on the case', async () => {
    await autoMuteScamAccount(base);
    expect(m.createStrike).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: 42,
        reason: 'Scam',
        points: 3,
        description: 'Impersonating Civitai staff',
        notifyUser: false,
      })
    );
    const { expiresInDays, internalNotes } = m.createStrike.mock.calls[0][0];
    expect(expiresInDays).toBeGreaterThanOrEqual(36500);
    expect(internalNotes).toContain('Fake support');
    expect(m.linkScamStrike).toHaveBeenCalledWith(5, 0, 'wf-1', 77);
    expect(m.announcePendingReviewMute.mock.invocationCallOrder[0]).toBeLessThan(
      m.createStrike.mock.invocationCallOrder[0]
    );
  });

  it('still files the case and cleans up when the daily cap withholds the strike', async () => {
    m.createStrike.mockResolvedValue(null);
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, strikeId: null });
    expect(m.linkScamStrike).not.toHaveBeenCalled();
    expect(m.runScamCleanup).toHaveBeenCalled();
  });

  it('keeps the mute and its strike when recording the strike id on the case fails', async () => {
    m.linkScamStrike.mockRejectedValueOnce(new Error('update failed'));
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, strikeId: 77 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'strike record failed', userRestrictionId: 5 })
    );
  });

  it('links a strike whose escalation then failed, and says the strike landed', async () => {
    m.createStrike.mockImplementationOnce(
      async ({ onCreated }: { onCreated?: (strike: { id: number }) => Promise<void> }) => {
        await onCreated?.({ id: 77 });
        throw new Error('escalation deadlock');
      }
    );
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, strikeId: 77 });
    expect(m.linkScamStrike).toHaveBeenCalledWith(5, 0, 'wf-1', 77);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'strike issued, but escalation failed' })
    );
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'strike failed' })
    );
  });

  it('reports no live strike when its case was overturned before the strike landed', async () => {
    m.linkScamStrike.mockResolvedValueOnce(true);
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, strikeId: null });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        message: 'strike voided: its case was overturned before the strike landed',
        strikeId: 77,
        userRestrictionId: 5,
      })
    );
  });

  it('logs a failed strike with the case id and carries on', async () => {
    m.createStrike.mockRejectedValue(new Error('enum value missing'));
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, strikeId: null });
    expect(m.runScamCleanup).toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'strike failed', userRestrictionId: 5 })
    );
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
    expect(m.scamVerdictActioned).toHaveBeenCalledWith(42, 'wf-1', expect.anything());
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
      expect(m.closeScamCasesOpenedBefore).toHaveBeenCalledWith(42, UNMUTED_AT, expect.anything());
      expect(m.closeScamCasesOpenedBefore.mock.invocationCallOrder[0]).toBeLessThan(
        m.claimPendingReviewMute.mock.invocationCallOrder[0]
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
        UNMUTED_AT,
        expect.anything()
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

  it.each([
    ['by a moderator', { muted: true, mutedAt: new Date() }],
    ['pending review or by strikes', { muted: true }],
  ])('skips an account already muted %s without acting', async (_label, over) => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(user(over));
    expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped: 'muted' });
    nothingActed();
    expect(m.scamVerdictActioned).not.toHaveBeenCalled();
  });

  it('appends to an open case without a second audit row or ClickHouse event', async () => {
    m.claimPendingReviewMute.mockResolvedValue({
      muted: true,
      userRestrictionId: 5,
      deduped: true,
      wasMuted: true,
    });
    expect(await autoMuteScamAccount(base)).toMatchObject({
      muted: true,
      deduped: true,
      strikeId: null,
    });
    expect(m.createStrike).not.toHaveBeenCalled();
    expect(m.appendScamTrigger).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ dedupeKey: 'wf-1' }),
      expect.anything()
    );
    expect(m.recordScamCleanup).toHaveBeenCalledWith(5, 1, 'wf-1', RECORD);
    expect(m.trackModActivity).not.toHaveBeenCalled();
    expect(m.userActivity).not.toHaveBeenCalled();
  });

  it('stops when a concurrent redelivery appended the same verdict first', async () => {
    m.claimPendingReviewMute.mockResolvedValue({
      muted: true,
      userRestrictionId: 5,
      deduped: true,
      wasMuted: true,
    });
    m.appendScamTrigger.mockResolvedValue(null);
    expect(await autoMuteScamAccount(base)).toEqual({ muted: false, skipped: 'duplicate' });
    expect(m.runScamCleanup).not.toHaveBeenCalled();
  });

  it('retries once into the dedupe path when a concurrent verdict opened the case first', async () => {
    m.claimPendingReviewMute
      .mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      )
      .mockResolvedValueOnce({ muted: true, userRestrictionId: 5, deduped: true, wasMuted: true });
    expect(await autoMuteScamAccount(base)).toMatchObject({ muted: true, deduped: true });
    expect(m.claimPendingReviewMute).toHaveBeenCalledTimes(2);
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
    expect(m.runScamCleanup).toHaveBeenCalledExactlyOnceWith('none', 42);
    expect(m.recordScamCleanup).not.toHaveBeenCalled();
  });

  it('passes the chat cleanup through', async () => {
    await autoMuteScamAccount({ ...base, cleanup: 'chatMessages' });
    expect(m.runScamCleanup).toHaveBeenCalledExactlyOnceWith('chatMessages', 42);
  });

  it('throws when it fails before filing, so the delivery is retried', async () => {
    dbMock.dbWrite.user.findUnique.mockRejectedValue(new Error('db down'));
    await expect(autoMuteScamAccount(base)).rejects.toThrow('db down');
    expect(m.claimPendingReviewMute).not.toHaveBeenCalled();
  });

  it('does not throw after filing; later failures are logged with the case id', async () => {
    m.trackModActivity.mockRejectedValueOnce(new Error('insert failed'));
    m.recordScamCleanup.mockRejectedValueOnce(new Error('update failed'));
    await expect(autoMuteScamAccount(base)).resolves.toMatchObject({ muted: true });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'audit failed', userRestrictionId: 5 })
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'cleanup record failed', userRestrictionId: 5 })
    );
  });

  it('decides under a lock on the account row, inside one transaction', async () => {
    await autoMuteScamAccount(base);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledOnce();
    const lock = (dbMock.dbWrite.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(lock).toContain('FOR UPDATE');
    expect(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      m.claimPendingReviewMute.mock.invocationCallOrder[0]
    );
  });

  it('restores what a lazily closed case hid, after the transaction', async () => {
    m.lastModeratorUnmuteAt.mockResolvedValue(UNMUTED_AT);
    m.closeScamCasesOpenedBefore.mockResolvedValueOnce([3]);
    await autoMuteScamAccount(base);
    expect(m.restoreScamCases).toHaveBeenCalledWith(42, [3]);
  });
});
