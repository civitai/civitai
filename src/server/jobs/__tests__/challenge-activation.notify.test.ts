import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => true),
  getChallengesReadyToStart: vi.fn(async (): Promise<unknown[]> => []),
  getUnscannedUserChallengesPastStart: vi.fn(async (): Promise<unknown[]> => []),
  getChallengeConfig: vi.fn(async () => ({})),
  setChallengeActive: vi.fn(async (..._a: unknown[]) => ({ activated: true })),
  startScheduledChallenge: vi.fn(async (..._a: unknown[]) => undefined),
  getChallengeNotifyRecipients: vi.fn(async (..._a: unknown[]): Promise<number[]> => []),
  createNotification: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mocks.isFlipt,
  FLIPT_FEATURE_FLAGS: { CHALLENGE_PLATFORM_ENABLED: 'x' },
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengesReadyToStart: mocks.getChallengesReadyToStart,
  getChallengeConfig: mocks.getChallengeConfig,
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  getUnscannedUserChallengesPastStart: mocks.getUnscannedUserChallengesPastStart,
  setChallengeActive: mocks.setChallengeActive,
}));
vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  startScheduledChallenge: mocks.startScheduledChallenge,
}));
vi.mock('~/server/services/challenge-engagement.service', () => ({
  getChallengeNotifyRecipients: mocks.getChallengeNotifyRecipients,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/services/challenge.service', () => ({
  scanUserChallenge: vi.fn(),
  voidChallenge: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({ dbWrite: { challenge: { findUnique: vi.fn() } } }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
// challenge-activation.ts builds `challengeActivationJob` at import time; stub the runner so the
// test never reaches the real cron/redis wiring.
vi.mock('~/server/jobs/job', () => ({
  createJob: (_name: string, _cron: string, fn: unknown) => ({ name: _name, run: fn }),
}));

import { runChallengeActivation } from '~/server/jobs/challenge-activation';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFlipt.mockResolvedValue(true);
  mocks.setChallengeActive.mockResolvedValue({ activated: true });
  mocks.getChallengesReadyToStart.mockResolvedValue([{ challengeId: 7, title: 'Neon Dreams' }]);
});

describe('challenge-starting on activation', () => {
  it('notifies every tracker once, with the shared per-challenge key', async () => {
    mocks.getChallengeNotifyRecipients.mockResolvedValueOnce([1, 2, 3]);

    await runChallengeActivation();

    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'challenge-starting',
        key: 'challenge-starting:7',
        userIds: [1, 2, 3],
      })
    );
  });

  it('sends nothing when the challenge has no trackers', async () => {
    mocks.getChallengeNotifyRecipients.mockResolvedValueOnce([]);

    await runChallengeActivation();

    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('does not notify when a concurrent tick already claimed the activation', async () => {
    mocks.setChallengeActive.mockResolvedValueOnce({ activated: false });

    await runChallengeActivation();

    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.startScheduledChallenge).not.toHaveBeenCalled();
  });

  it('a notification failure does not abort activation', async () => {
    mocks.getChallengeNotifyRecipients.mockRejectedValueOnce(new Error('redis down'));

    await expect(runChallengeActivation()).resolves.not.toThrow();
    expect(mocks.startScheduledChallenge).toHaveBeenCalledTimes(1);
  });
});
