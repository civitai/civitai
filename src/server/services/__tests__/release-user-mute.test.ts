import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as Ledger from '~/server/services/scam-case-ledger';
import type * as ModeratorService from '~/server/services/moderator.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const m = vi.hoisted(() => ({
  closeScamCasesOpenedBefore: vi.fn(async (): Promise<number[]> => []),
  restoreScamCases: vi.fn(async () => undefined),
  trackModActivity: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/scam-case-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof Ledger>()),
  closeScamCasesOpenedBefore: m.closeScamCasesOpenedBefore,
  restoreScamCases: m.restoreScamCases,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: m.trackModActivity,
}));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  invalidateSession: m.invalidateSession,
}));

const { releaseUserMute } = await import('~/server/services/mute-release.service');
const { setUserMuted } = await import('~/server/services/user.service');

const MOD = 7;
const SYSTEM = -1;
const USER = 42;

const lockedRow = (over: Record<string, unknown> = {}) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    { meta: { muteReason: 'x', mutedBy: MOD, other: 1 }, muteExpiresAt: null, ...over },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  lockedRow();
  dbMock.dbWrite.userRestriction.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER, muted: false });
});

describe('releaseUserMute', () => {
  it('clears the mute, dates it with a ModActivity and closes scam holds, all in one transaction', async () => {
    m.closeScamCasesOpenedBefore.mockResolvedValueOnce([5, 9]);
    const result = await releaseUserMute({ userId: USER, actorId: MOD, updateSource: 't' });

    expect(result).toMatchObject({ released: true, closedCaseIds: [5, 9] });
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledOnce();
    const lock = (dbMock.dbWrite.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(lock).toContain('FOR UPDATE');
    expect(dbMock.dbWrite.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { muted: false, mutedAt: null, muteExpiresAt: null, meta: { other: 1 } },
    });
    expect(m.trackModActivity).toHaveBeenCalledExactlyOnceWith(
      MOD,
      { entityType: 'user', entityId: USER, activity: 'unmute' },
      dbMock.dbWrite
    );
    expect(m.closeScamCasesOpenedBefore).toHaveBeenCalledWith(
      USER,
      expect.any(Date),
      dbMock.dbWrite
    );
    const order = [
      dbMock.dbWrite.user.update.mock.invocationCallOrder[0],
      m.trackModActivity.mock.invocationCallOrder[0],
      m.closeScamCasesOpenedBefore.mock.invocationCallOrder[0],
    ];
    expect(order.every((at) => at > dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0])).toBe(
      true
    );
  });

  it('restores what the closed holds hid, after the transaction', async () => {
    m.closeScamCasesOpenedBefore.mockResolvedValueOnce([5]);
    await releaseUserMute({ userId: USER, actorId: MOD, updateSource: 't' });
    expect(m.restoreScamCases).toHaveBeenCalledExactlyOnceWith(USER, [5]);
    expect(m.invalidateSession).toHaveBeenCalledWith(USER, 'moderation');
  });

  const openCase = (type: string) =>
    dbMock.dbWrite.userRestriction.findFirst.mockImplementation(
      async ({ where }: { where: { type?: string } }) =>
        !where.type || where.type === type ? { id: 3 } : null
    );

  it('a system release never lifts a mute a Pending scam case holds', async () => {
    openCase('scam');
    expect(await releaseUserMute({ userId: USER, actorId: SYSTEM, updateSource: 't' })).toEqual({
      released: false,
      reason: 'scam-case',
      closedCaseIds: [],
    });
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
    expect(m.trackModActivity).not.toHaveBeenCalled();
  });

  it('a moderator unmute still lifts a mute a Pending scam case holds', async () => {
    openCase('scam');
    expect(await releaseUserMute({ userId: USER, actorId: MOD, updateSource: 't' })).toMatchObject({
      released: true,
    });
  });

  it('a system release lifts the mute despite another open case, and leaves the case queued', async () => {
    openCase('generation');
    expect(
      await releaseUserMute({ userId: USER, actorId: SYSTEM, updateSource: 't' })
    ).toMatchObject({ released: true, closedCaseIds: [] });
    expect(dbMock.dbWrite.user.update).toHaveBeenCalled();
    expect(m.closeScamCasesOpenedBefore).not.toHaveBeenCalled();
  });

  it('a system release with no open case clears the mute but closes no scam hold', async () => {
    expect(
      await releaseUserMute({ userId: USER, actorId: SYSTEM, updateSource: 't' })
    ).toMatchObject({ released: true, closedCaseIds: [] });
    expect(m.closeScamCasesOpenedBefore).not.toHaveBeenCalled();
  });

  it('a moderator unmute is not held back by an open case', async () => {
    dbMock.dbWrite.userRestriction.findFirst.mockResolvedValue({ id: 3 });
    expect(await releaseUserMute({ userId: USER, actorId: MOD, updateSource: 't' })).toMatchObject({
      released: true,
    });
  });

  it('only lifts a timed mute when asked to', async () => {
    expect(
      await releaseUserMute({
        userId: USER,
        actorId: MOD,
        activity: 'revokeTimedMute',
        onlyIfTimed: true,
        updateSource: 't',
      })
    ).toMatchObject({ released: false, reason: 'not-timed' });
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();

    lockedRow({ muteExpiresAt: new Date() });
    await releaseUserMute({
      userId: USER,
      actorId: MOD,
      activity: 'revokeTimedMute',
      onlyIfTimed: true,
      updateSource: 't',
    });
    expect(m.trackModActivity).toHaveBeenCalledWith(
      MOD,
      expect.objectContaining({ activity: 'revokeTimedMute' }),
      dbMock.dbWrite
    );
  });

  it('merges a caller meta patch after the mute keys are cleared', async () => {
    await releaseUserMute({
      userId: USER,
      actorId: SYSTEM,
      metaPatch: { strikeFlaggedForReview: false },
      updateSource: 't',
    });
    expect(dbMock.dbWrite.user.update.mock.calls[0][0].data.meta).toEqual({
      other: 1,
      strikeFlaggedForReview: false,
    });
  });

  it('reports a missing account without writing', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(await releaseUserMute({ userId: USER, actorId: MOD, updateSource: 't' })).toMatchObject({
      released: false,
      reason: 'not-found',
    });
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });

  it('does not throw once the unmute has committed', async () => {
    m.invalidateSession.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      releaseUserMute({ userId: USER, actorId: MOD, updateSource: 't' })
    ).resolves.toMatchObject({ released: true });
  });
});

describe('setUserMuted', () => {
  it('unmutes through releaseUserMute, as the acting moderator', async () => {
    await setUserMuted({ userId: USER, muted: false, actorId: MOD });
    expect(m.trackModActivity).toHaveBeenCalledWith(
      MOD,
      { entityType: 'user', entityId: USER, activity: 'unmute' },
      dbMock.dbWrite
    );
  });
});
