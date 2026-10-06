import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));

import type * as NotificationService from '~/server/services/notification.service';
import { persistScoreBatch, settleTierGrants } from '~/server/jobs/update-user-score';

const updatedRow = { userId: 7, oldTotal: '400', newTotal: '600' };
const crossing = { userId: 7, milestoneKey: 'score:spark', name: 'Spark', threshold: 500 };

function batchCtx(grant: () => Promise<unknown[]>) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pg = {
    cancellableQuery: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const result = calls.length === 1 ? async () => [updatedRow] : grant;
      return { result, cancel: async () => undefined };
    }),
  };
  const ctx = {
    pg: pg as never,
    jobContext: { status: 'running', on: vi.fn(), checkIfCanceled: vi.fn() } as never,
    tierUnlocks: [],
    tierGrantErrors: [] as unknown[],
  };
  return { ctx, calls };
}

beforeEach(() => vi.clearAllMocks());

describe('persistScoreBatch', () => {
  it('hands the persisted old and new totals to the grant', async () => {
    const { ctx, calls } = batchCtx(async () => []);
    await persistScoreBatch(ctx, [['7', { models: 600 }]]);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].params?.[0] as string)).toEqual([
      { userId: 7, oldTotal: 400, newTotal: 600 },
    ]);
  });

  it('notifies a crossing as soon as its batch commits', async () => {
    const { ctx } = batchCtx(async () => [crossing]);
    await persistScoreBatch(ctx, [['7', { models: 600 }]]);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'creator-score-tier-reached:7:score:spark', userId: 7 })
    );
    expect(ctx.tierGrantErrors).toEqual([]);
  });

  it('records a failed grant without failing the batch, whose scores are already written', async () => {
    const failure = new Error('relation "UserCreatorMilestone" does not exist');
    const { ctx } = batchCtx(async () => {
      throw failure;
    });
    await expect(persistScoreBatch(ctx, [['7', { models: 600 }]])).resolves.toBeUndefined();
    expect(ctx.tierGrantErrors).toEqual([failure]);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });
});

describe('settleTierGrants', () => {
  it('fails the run and freezes the tierGrants checkpoint when any grant failed', async () => {
    const failures: { category: string; error: unknown }[] = [];
    const advance = vi.fn(async () => undefined);
    const error = new Error('boom');
    await settleTierGrants([error], failures, advance);
    expect(failures).toEqual([{ category: 'tierGrants', error }]);
    expect(advance).not.toHaveBeenCalled();
  });

  it('advances the tierGrants checkpoint when every grant succeeded', async () => {
    const failures: { category: string; error: unknown }[] = [];
    const advance = vi.fn(async () => undefined);
    await settleTierGrants([], failures, advance);
    expect(failures).toEqual([]);
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
