import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mocks = vi.hoisted(() => ({
  stored: vi.fn(),
  imageScoresAsOf: vi.fn(),
  raiseImagesScores: vi.fn(),
  subtractImagesScores: vi.fn(),
  excluded: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {},
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: {},
  pgDbWrite: {
    cancellableQuery: async (_sql: string, [ids]: [number[]]) => ({
      result: async () => mocks.stored(ids),
      cancel: async () => undefined,
    }),
  },
}));
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  getScoreMultipliers: async () => ({ images: { reactions: 10, comments: 20 } }),
  raiseImagesScores: mocks.raiseImagesScores,
  subtractImagesScores: mocks.subtractImagesScores,
}));
vi.mock('~/server/services/image-score-raise.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageScoreRaise>()),
  imageScoresAsOf: mocks.imageScoresAsOf,
}));
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricExcludedUsers>()),
  getMetricExcludedUserIdsOrThrow: mocks.excluded,
}));

import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as UpdateUserScore from '~/server/jobs/update-user-score';
import type * as ImageScoreRaise from '~/server/services/image-score-raise.service';
import type * as MetricExcludedUsers from '~/server/services/metric-excluded-users.service';
import handler from '~/pages/api/admin/temp/raise-image-scores';

function call(body: unknown, query: Record<string, string> = {}, method = 'POST') {
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  const req = { method, headers: {}, body, query: { token: 'test-webhook-token', ...query } };
  return (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(() => ({
    status,
    body: payload as Record<string, unknown>,
  }));
}

const CHECKPOINT = 1_792_886_169_000;

// Owner 1 goes up, owner 2 would go down, owner 3 is already right, owner 4 has no User row.
beforeEach(() => {
  vi.clearAllMocks();
  mocks.excluded.mockResolvedValue([]);
  dbMock.dbWrite.keyValue.findUnique.mockResolvedValue({
    key: 'update-user-score:images',
    value: CHECKPOINT,
  });
  mocks.stored.mockResolvedValue([
    { id: 1, images: '100', total: '100' },
    { id: 2, images: '500', total: '500' },
    { id: 3, images: '70', total: '70' },
  ]);
  mocks.imageScoresAsOf.mockImplementation(async ({ ownerIds }: { ownerIds: number[] }) => {
    const value: Record<number, number> = { 1: 400, 2: 300, 3: 70 };
    return new Map(ownerIds.map((id) => [id, value[id]]));
  });
  mocks.raiseImagesScores.mockResolvedValue([
    { userId: 1, oldImages: 100, newImages: 400, oldTotal: 100, newTotal: 400 },
  ]);
});

describe('raise-image-scores', () => {
  it('is a dry run unless told otherwise: it plans and writes nothing', async () => {
    const { status, body } = await call({ mode: 'raise', ownerIds: [1, 2, 3, 4] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ dryRun: true, considered: 3, raise: 1, equal: 1, down: 1 });
    expect(mocks.raiseImagesScores).not.toHaveBeenCalled();
  });

  it('writes only the raises, guarded by the score it read and the checkpoint it used', async () => {
    const { body } = await call({ mode: 'raise', ownerIds: [1, 2, 3, 4] }, { dryRun: 'false' });
    expect(mocks.imageScoresAsOf.mock.calls[0][0].since).toEqual(new Date(CHECKPOINT));
    expect(mocks.raiseImagesScores).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: 1, expected: 100, next: 400 }],
      expect.objectContaining({
        checkpoint: { key: 'update-user-score:images', value: CHECKPOINT },
      })
    );
    expect(body).toMatchObject({
      written: [{ ownerId: 1, beforeImages: 100, afterImages: 400 }],
      skippedRace: [],
    });
  });

  it('never raises a metric-excluded owner, even when the score would go up', async () => {
    mocks.excluded.mockResolvedValue([1]);
    const { body } = await call({ mode: 'raise', ownerIds: [1, 2, 3] }, { dryRun: 'false' });
    expect(body).toMatchObject({ raise: 0, excluded: 1 });
    expect(mocks.raiseImagesScores).toHaveBeenCalledWith(expect.anything(), [], expect.anything());
  });

  it('reports a raise the guard refused, so the driver can retry it', async () => {
    mocks.raiseImagesScores.mockResolvedValue([]);
    const { body } = await call({ mode: 'raise', ownerIds: [1] }, { dryRun: 'false' });
    expect(body).toMatchObject({ written: [], skippedRace: [1] });
  });

  it('refuses to plan without a checkpoint', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null);
    const { status } = await call({ mode: 'raise', ownerIds: [1] });
    expect(status).toBe(409);
  });

  it('rolls back by subtracting what was added, and only when told to', async () => {
    const rows = [{ ownerId: 1, added: 300 }];
    await call({ mode: 'rollback', rows });
    expect(mocks.subtractImagesScores).not.toHaveBeenCalled();
    await call({ mode: 'rollback', rows }, { dryRun: 'false' });
    expect(mocks.subtractImagesScores).toHaveBeenCalledWith(expect.anything(), [[1, 300]], {
      key: 'imageScoreRaiseRolledBackAt',
      at: expect.any(Date),
    });
  });

  it('takes POST only', async () => {
    const { status } = await call(undefined, {}, 'GET');
    expect(status).toBe(405);
  });
});

describe('raise-image-scores raiseValues', () => {
  const values = (rows: { ownerId: number; expected: number | null; next: number }[]) => ({
    mode: 'raiseValues',
    checkpoint: CHECKPOINT,
    rows,
  });
  const written = () => mocks.raiseImagesScores.mock.calls[0][1];

  it('refuses values computed against a checkpoint the cron has since moved', async () => {
    const { status } = await call(
      { ...values([{ ownerId: 1, expected: 100, next: 400 }]), checkpoint: CHECKPOINT - 3_600_000 },
      { dryRun: 'false' }
    );
    expect(status).toBe(409);
    expect(mocks.raiseImagesScores).not.toHaveBeenCalled();
  });

  it('writes the sent value, guarded by the expected score and the checkpoint', async () => {
    const { body } = await call(values([{ ownerId: 1, expected: 100, next: 400 }]), {
      dryRun: 'false',
    });
    expect(mocks.imageScoresAsOf).not.toHaveBeenCalled();
    expect(mocks.raiseImagesScores).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: 1, expected: 100, next: 400 }],
      expect.objectContaining({
        checkpoint: { key: 'update-user-score:images', value: CHECKPOINT },
      })
    );
    expect(body).toMatchObject({ raise: 1, written: [{ ownerId: 1 }], skippedRace: [] });
  });

  it('writes nothing for an owner whose stored score is not the expected one', async () => {
    const { body } = await call(values([{ ownerId: 1, expected: 90, next: 400 }]), {
      dryRun: 'false',
    });
    expect(body).toMatchObject({ raise: 0, stale: 1 });
    expect(written()).toEqual([]);
  });

  it('plans an owner already at the sent value as equal, not stale, on a re-run', async () => {
    const { body } = await call(values([{ ownerId: 3, expected: 10, next: 70 }]));
    expect(body).toMatchObject({ equal: 1, stale: 0 });
  });

  it('never lowers a score or rewrites an equal one', async () => {
    const { body } = await call(
      values([
        { ownerId: 2, expected: 500, next: 300 },
        { ownerId: 3, expected: 70, next: 70 },
      ]),
      { dryRun: 'false' }
    );
    expect(body).toMatchObject({ raise: 0, down: 1, equal: 1 });
    expect(written()).toEqual([]);
  });

  it('never writes a metric-excluded owner, even when the value would go up', async () => {
    mocks.excluded.mockResolvedValue([1]);
    const { body } = await call(values([{ ownerId: 1, expected: 100, next: 400 }]), {
      dryRun: 'false',
    });
    expect(body).toMatchObject({ raise: 0, excluded: 1 });
    expect(written()).toEqual([]);
  });

  it('dry run summarises the sent values against the stored scores and writes nothing', async () => {
    mocks.excluded.mockResolvedValue([3]);
    mocks.stored.mockResolvedValue([
      { id: 1, images: '100', total: '100' },
      { id: 2, images: '500', total: '500' },
      { id: 3, images: '70', total: '70' },
      { id: 5, images: '40', total: '40' },
    ]);
    const { status, body } = await call(
      values([
        { ownerId: 1, expected: 100, next: 400 },
        { ownerId: 2, expected: 500, next: 300 },
        { ownerId: 3, expected: 70, next: 900 },
        { ownerId: 4, expected: null, next: 10 },
        { ownerId: 5, expected: 40, next: 40 },
      ])
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      dryRun: true,
      considered: 4,
      raise: 1,
      equal: 1,
      down: 1,
      excluded: 1,
      stale: 0,
    });
    expect(mocks.raiseImagesScores).not.toHaveBeenCalled();
  });

  it('takes at most 500 rows, each owner once', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ ownerId: i + 1, expected: 0, next: 1 }));
    await expect(call(values(rows))).rejects.toThrow();
    await expect(call(values(rows.slice(0, 500)))).resolves.toMatchObject({ status: 200 });
    await expect(
      call(
        values([
          { ownerId: 1, expected: 100, next: 400 },
          { ownerId: 1, expected: 100, next: 500 },
        ])
      )
    ).rejects.toThrow();
  });
});
