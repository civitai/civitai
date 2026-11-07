import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Caches from '~/server/redis/caches';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type {
  ChallengeConfig,
  DailyChallengeDetails,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import '~/__tests__/mocks/logging.mock';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  setChallengeActive: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  cosmeticEntityCaches: { Model: { refresh: mocks.refresh } },
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  setChallengeActive: mocks.setChallengeActive,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { startScheduledChallenge } = await import('~/server/jobs/daily-challenge-processing');

// Pairwise-distinct ids, so passing the wrong one to refresh() cannot match by accident.
const MODEL_ID = 4711;
const challenge = {
  challengeId: 37,
  collectionId: 902,
  modelId: MODEL_ID,
  title: 'Neon Dreams',
} as unknown as DailyChallengeDetails;
const withCosmetic = { resourceCosmeticId: 555 } as unknown as ChallengeConfig;

const isGrant = (strings: unknown) =>
  (strings as string[]).join('?').includes('INSERT INTO "UserCosmetic"');
const grantCalls = () =>
  vi.mocked(dbMock.dbWrite.$executeRaw).mock.calls.filter(([strings]) => isGrant(strings));

beforeEach(() => {
  vi.clearAllMocks();
  // The shared db mock resets per FILE, not per test: restore the default so the deferred
  // INSERT below cannot leak into a later case.
  vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValue(0 as never);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.setChallengeActive.mockResolvedValue({ activated: true });
  mocks.createNotification.mockResolvedValue(undefined);
  vi.mocked(dbMock.dbRead.model.findUnique).mockResolvedValue({
    userId: 8,
    name: 'Some Model',
  } as never);
});

describe('startScheduledChallenge: resource cosmetic grant', () => {
  it('refreshes the model frame cache once, with the challenge modelId, after the grant', async () => {
    await startScheduledChallenge(challenge, withCosmetic);

    expect(grantCalls()).toHaveLength(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledWith(MODEL_ID);
  });

  it('does not refresh until the grant INSERT has resolved', async () => {
    // Call ORDER alone cannot see a dropped `await`: the refresh would still start after the
    // INSERT starts, yet race it and re-cache "no frame". So hold the INSERT open.
    let resolveInsert!: (n: number) => void;
    const insertPending = new Promise<number>((resolve) => (resolveInsert = resolve));
    vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(((strings: unknown) =>
      isGrant(strings) ? insertPending : Promise.resolve(0)) as never);

    const run = startScheduledChallenge(challenge, withCosmetic);
    await vi.waitFor(() => expect(grantCalls()).toHaveLength(1));
    // Several macrotask turns: any un-awaited refresh would have been called by now.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(mocks.refresh).not.toHaveBeenCalled();

    resolveInsert(1);
    await run;

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledWith(MODEL_ID);
  });

  it('still completes the challenge start when the refresh rejects', async () => {
    mocks.refresh.mockRejectedValueOnce(new Error('redis down'));

    await expect(startScheduledChallenge(challenge, withCosmetic)).resolves.toBeUndefined();

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    // The step after the grant (owner notification) still ran.
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'challenge-resource', userId: 8 })
    );
  });

  it('does not refresh when the config grants no cosmetic', async () => {
    await startScheduledChallenge(challenge, {} as unknown as ChallengeConfig);

    expect(grantCalls()).toHaveLength(0);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
