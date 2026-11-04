import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import { dbMock } from '~/__tests__/mocks/db.mock';

const m = vi.hoisted(() => ({
  invalidateSession: vi.fn(async (_userId: number, _caller?: unknown) => undefined),
  trackModActivity: vi.fn(async () => undefined),
}));

vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  invalidateSession: m.invalidateSession,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: m.trackModActivity,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));

const { toggleMuteHandler } = await import('~/server/controllers/user.controller');
const { setUserMuted } = await import('~/server/services/user.service');

const USER = 42;
const ctx = () =>
  ({
    user: { id: 7, isModerator: true },
    track: { userActivity: vi.fn(async () => undefined) },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` keeps a `mockRejectedValue` from an earlier test.
  m.invalidateSession.mockResolvedValue(undefined);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ muted: false } as never);
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER, muted: true } as never);
});

describe('toggleMute when the muted account’s sessions cannot be ended', () => {
  it('still succeeds, writes the mute once, and reports the failed logout', async () => {
    m.invalidateSession.mockRejectedValue(new Error('session store down'));

    const result = await toggleMuteHandler({ input: { id: USER }, ctx: ctx() });

    expect(result).toMatchObject({ sessionInvalidated: false });
    const muteWrites = dbMock.dbWrite.user.update.mock.calls.filter(
      ([args]) => (args as { data?: { muted?: boolean } }).data?.muted === true
    );
    expect(muteWrites).toHaveLength(1);
    expect(m.trackModActivity).toHaveBeenCalled();
  });
});

// `user.mute` answers a retryable 503 after the mute commits; the retry must not re-date the decision.
describe('setUserMuted when the account is already muted', () => {
  const writtenMutedAt = () =>
    (dbMock.dbWrite.user.update.mock.calls.at(-1)?.[0] as { data: { mutedAt?: Date } }).data
      .mutedAt;

  it('keeps the original mutedAt on a repeat', async () => {
    const original = new Date('2026-10-01T00:00:00Z');
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true, mutedAt: original } as never);
    await setUserMuted({ userId: USER, muted: true, expiresAt: null });
    expect(writtenMutedAt()).toEqual(original);
  });

  it.each([
    ['a new mute', { muted: false, mutedAt: null }],
    ['a mute over an automatic one', { muted: true, mutedAt: null }],
    [
      'a mute over a stale mutedAt left on an unmuted account',
      { muted: false, mutedAt: new Date(0) },
    ],
  ])('dates %s now', async (_, row) => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row as never);
    const before = Date.now();
    await setUserMuted({ userId: USER, muted: true, expiresAt: null });
    expect(writtenMutedAt()?.getTime()).toBeGreaterThanOrEqual(before);
  });
});
