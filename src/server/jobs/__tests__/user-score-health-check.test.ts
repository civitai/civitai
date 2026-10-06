import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ notifyModAlert: vi.fn(async () => 'delivered' as const) }));
vi.mock('~/server/common/mod-alert', async (importOriginal) => ({
  ...(await importOriginal<typeof ModAlert>()),
  notifyModAlert: mocks.notifyModAlert,
}));
vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof JobModule>()),
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

import type * as ModAlert from '~/server/common/mod-alert';
import type * as JobModule from '~/server/jobs/job';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userScoreCheckpointKeys } from '~/server/jobs/update-user-score';
import { checkUserScoreHealth } from '~/server/jobs/user-score-health-check';

const now = new Date('2026-10-05T12:00:00Z');
const hoursAgo = (h: number) => now.getTime() - h * 3_600_000;

function checkpoints(ageHours: Record<string, number>) {
  dbMock.dbRead.keyValue.findMany.mockResolvedValue(
    Object.entries(ageHours).map(([key, h]) => ({ key, value: hoursAgo(h) })) as never
  );
}

beforeEach(() => vi.clearAllMocks());

describe('checkUserScoreHealth', () => {
  it('watches one checkpoint per score category and one for tier grants', () => {
    expect(userScoreCheckpointKeys).toEqual([
      'update-user-score:models',
      'update-user-score:articles',
      'update-user-score:users',
      'update-user-score:reportsActioned',
      'update-user-score:reportsAgainst',
      'update-user-score:images',
      'update-user-score:tierGrants',
    ]);
  });

  it('stays quiet when every category succeeded last night', async () => {
    checkpoints(Object.fromEntries(userScoreCheckpointKeys.map((k) => [k, 12])));
    expect(await checkUserScoreHealth(now)).toEqual({ healthy: true });
    expect(mocks.notifyModAlert).not.toHaveBeenCalled();
  });

  it('alerts after one missed night, naming the stale category', async () => {
    checkpoints({
      ...Object.fromEntries(userScoreCheckpointKeys.map((k) => [k, 12])),
      'update-user-score:images': 36,
    });
    const result = await checkUserScoreHealth(now);
    expect(result).toMatchObject({ healthy: false, stale: 1 });
    expect(mocks.notifyModAlert).toHaveBeenCalledTimes(1);
    const [, description] = mocks.notifyModAlert.mock.calls[0] as unknown as [string, string];
    expect(description).toContain('`update-user-score:images` last succeeded 2026-10-04T00:00:00');
    expect(description).not.toContain('update-user-score:models');
  });

  it('treats a checkpoint that was never written as stale', async () => {
    checkpoints({});
    expect(await checkUserScoreHealth(now)).toMatchObject({ healthy: false, stale: 7 });
    expect(mocks.notifyModAlert).toHaveBeenCalledTimes(1);
    const [, description] = mocks.notifyModAlert.mock.calls[0] as unknown as [string, string];
    expect(description).toContain('`update-user-score:tierGrants` last succeeded never');
  });
});
