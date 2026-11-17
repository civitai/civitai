import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

/** The purge deletes only in production against the production database, through its guard. */

const env = vi.hoisted(() => ({ isProd: true, DATABASE_IS_PROD: true }));
vi.mock('~/env/other', () => ({
  get isProd() {
    return env.isProd;
  },
}));
vi.mock('~/env/server', () => ({
  env: {
    get DATABASE_IS_PROD() {
      return env.DATABASE_IS_PROD;
    },
  },
}));
const { deleteImages } = vi.hoisted(() => ({ deleteImages: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ deleteImages }));

const { purgeFeedbackCaptures } = await import('../purge-feedback-captures');

const run = () =>
  (purgeFeedbackCaptures.run({}) as unknown as { result: Promise<Record<string, unknown>> }).result;

beforeEach(() => {
  vi.clearAllMocks();
  env.isProd = true;
  env.DATABASE_IS_PROD = true;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (sql: { sql: string }) =>
    sql.sql.includes('AS "evidenceHold"')
      ? [
          {
            id: 9,
            review: true,
            blocked: false,
            minor: false,
            reported: false,
            evidenceHold: false,
          },
        ]
      : [{ id: 1 }, { id: 2 }]) as never);
  deleteImages.mockResolvedValue([{ id: 1 }]);
});

describe('purge-feedback-captures', () => {
  it('deletes the expired captures through the guard, and counts what the guard skipped', async () => {
    expect(await run()).toMatchObject({ deleted: 1, skippedByGuard: 1, kept: 1, keptReview: 1 });
    expect(deleteImages).toHaveBeenCalledTimes(1);
    const [ids, , opts] = deleteImages.mock.calls[0];
    expect(ids).toEqual([1, 2]);
    expect(opts.onlyWhere.sql).toContain('"Image"."createdAt" <');
  });

  it.each([
    ['outside production', { isProd: false, DATABASE_IS_PROD: true }],
    ['against a non-production database', { isProd: true, DATABASE_IS_PROD: false }],
  ])('deletes nothing %s', async (_label, flags) => {
    Object.assign(env, flags);
    expect(await run()).toMatchObject({ wouldDelete: 2 });
    expect(deleteImages).not.toHaveBeenCalled();
  });
});
