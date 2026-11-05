import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CsamService from '~/server/services/csam.service';
import type * as UserService from '~/server/services/user.service';

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { createCsamReport, softDeleteUser } = vi.hoisted(() => ({
  createCsamReport: vi.fn(async () => undefined),
  softDeleteUser: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  createCsamReport,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  softDeleteUser,
}));

const { fileCsamReport } = await import('~/server/controllers/csam.controller');

const USER = 30;
const MOD = 2;
const file = () =>
  fileCsamReport({ userId: USER, type: 'GeneratedImage', reportedById: MOD } as never);
const orchestratorAnswers = (status: number) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));

beforeEach(() => {
  vi.restoreAllMocks();
  createCsamReport.mockClear();
  softDeleteUser.mockClear();
});

describe('fileCsamReport (GeneratedImage)', () => {
  it('removes the account when the strikes review route is not found', async () => {
    const fetch = orchestratorAnswers(404);

    await file();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/strikes/review`),
      expect.objectContaining({ method: 'POST' })
    );
    expect(createCsamReport).toHaveBeenCalledTimes(1);
    expect(softDeleteUser).toHaveBeenCalledWith({ id: USER, userId: MOD });
  });

  it('still fails, before removing the account, when the review fails any other way', async () => {
    orchestratorAnswers(500);

    await expect(file()).rejects.toThrow('500');
    expect(createCsamReport).toHaveBeenCalledTimes(1);
    expect(softDeleteUser).not.toHaveBeenCalled();
  });
});
