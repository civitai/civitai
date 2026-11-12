import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));
const { mockCreateNotification } = vi.hoisted(() => ({ mockCreateNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { waitingGatesSql } from '~/server/jobs/resolve-pre-publish-gates';
import { countFailedAttempt } from '~/server/services/pre-publish-gate/gate.service';

/** The resolver's queue, against Postgres: gated models found through the gate's log. */

const gate = (state: string, requestedAt: string, publishedAt?: string) =>
  JSON.stringify({
    prePublishGate: {
      state,
      runId: 'r',
      requestedAt,
      ...(publishedAt ? { publishedAt, publishedAtMs: new Date(publishedAt).getTime() } : {}),
    },
  });

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, "deletedAt" timestamp(3), meta jsonb);
    CREATE TABLE "ModelPublishCheck" (
      id serial PRIMARY KEY, "modelId" int NOT NULL, "check" text NOT NULL, outcome text NOT NULL,
      detail jsonb
    );
  `);
});
afterAll(() => db.close());

// 1, 2: waiting, 2 asked first. 3: scheduled for later. 4: scheduled, its time has come.
// 5: refused since. 6: deleted. 7: pending in meta with no gate log row. 8: a date past year
// 9999, which Postgres cannot cast: not due, and the query must not fail on it.
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Model", "ModelPublishCheck";
    INSERT INTO "Model" VALUES
      (1, 7, NULL, '${gate('pending', '2026-11-09T02:00:00Z')}'),
      (2, 7, NULL, '${gate('pending', '2026-11-09T01:00:00Z')}'),
      (3, 7, NULL, '${gate('pending', '2026-11-09T01:00:00Z', '2999-01-01T00:00:00Z')}'),
      (4, 7, NULL, '${gate('pending', '2026-11-08T01:00:00Z', '2026-11-08T12:00:00Z')}'),
      (5, 7, NULL, '${gate('refused', '2026-11-09T01:00:00Z')}'),
      (6, 7, now(), '${gate('pending', '2026-11-09T01:00:00Z')}'),
      (7, 7, NULL, '${gate('pending', '2026-11-09T01:00:00Z')}'),
      (8, 7, NULL, '${gate('pending', '2026-11-09T01:00:00Z', '+010000-01-01T00:00:00.000Z')}');
    INSERT INTO "ModelPublishCheck" ("modelId", "check", outcome, detail) VALUES
      (1, 'gate', 'pending', NULL), (1, 'images', 'pending', NULL),
      (2, 'gate', 'pending', NULL),
      (3, 'gate', 'pass', '{"scheduled": true}'),
      (4, 'gate', 'pass', '{"scheduled": true}'),
      (5, 'gate', 'pending', NULL),
      (6, 'gate', 'pending', NULL),
      (8, 'gate', 'pass', '{"scheduled": true}');
  `);
});

const ids = async (limit = 100) => {
  const sql = waitingGatesSql(limit);
  return (await db.query<{ id: number }>(sql.text, sql.values)).rows.map((r) => r.id);
};

describe('the resolver queue', () => {
  it('takes waiting and due scheduled runs, oldest ask first, and nothing else', async () => {
    expect(await ids()).toEqual([4, 2, 1]);
  });

  it('stops at its limit', async () => {
    expect(await ids(2)).toEqual([4, 2]);
  });
});

describe('a resolver pass that errors after the gate passed', () => {
  beforeEach(() => {
    mockCreateNotification.mockReset();
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...v: unknown[]
    ) => {
      const flat = Prisma.sql(strings, ...(v as never[]));
      return (await db.query(flat.text, flat.values as unknown[])).rows;
    }) as never);
    dbMock.dbWrite.model.findUnique.mockResolvedValue({ userId: 7, name: 'A style' } as never);
  });
  // What the gate writes for model 2's run when it passes, before the publish runs.
  const gatePassed = () =>
    db.query(
      `UPDATE "Model" SET meta = jsonb_set(meta, '{prePublishGate,state}', '"passed"') WHERE id = 2`
    );
  const state = async () =>
    (
      await db.query<{ state: string; attempts: number | null }>(
        `SELECT meta->'prePublishGate'->>'state' AS state,
          (meta->'prePublishGate'->>'attempts')::int AS attempts FROM "Model" WHERE id = 2`
      )
    ).rows[0];

  it('goes back in the queue, with the attempt counted', async () => {
    await gatePassed();
    expect(await ids()).not.toContain(2);
    await countFailedAttempt(2, 'r');
    expect(await ids()).toContain(2);
    expect(await state()).toEqual({ state: 'pending', attempts: 1 });
  });

  it('ends, refused, once it has failed too often', async () => {
    for (let i = 0; i < 12; i++) {
      await gatePassed();
      await countFailedAttempt(2, 'r');
    }
    expect(await state()).toEqual({ state: 'refused', attempts: 12 });
    expect(await ids()).not.toContain(2);
    // The owner was told it would publish once checked: they hear it didn't, once.
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        type: 'pre-publish-gate-result',
        key: 'pre-publish-gate-result:r',
        details: expect.objectContaining({ modelId: 2, outcome: 'unfinished' }),
      })
    );
    // A later pass for the ended run changes nothing and tells no one again.
    await countFailedAttempt(2, 'r');
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it('tells no one while the run is still being retried (control)', async () => {
    await gatePassed();
    await countFailedAttempt(2, 'r');
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("leaves another run's record alone (control)", async () => {
    await gatePassed();
    await countFailedAttempt(2, 'another-run');
    expect(await state()).toEqual({ state: 'passed', attempts: null });
  });
});
