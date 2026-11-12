import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { existsSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { restore, SCRIPT_BASENAME as RESTORE } from '../oneoffs/restore-com-faces';
import {
  apply,
  type Deps,
  type Face,
  type RunLog,
  runEntityType,
  scan,
  SCRIPT_BASENAME as SWEEP,
  sha256,
} from '../oneoffs/sweep-com-faces';

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/redis/queues', () => ({ addToQueue: vi.fn(), checkoutQueue: vi.fn() }));

const { comFaceRemovalSql } = await import('~/server/services/model-com-face-recheck.service');

const face = (id: number): Face => ({
  id,
  userId: 1,
  name: `m${id}`,
  description: null,
  sfwCoverImageId: id * 10,
});
const pace = { concurrency: 2, delayMs: 0 };

function deps(verdicts: Record<number, 'allowed' | 'detected' | 'unavailable' | 'throws'>) {
  const ids = Object.keys(verdicts).map(Number);
  return {
    faces: vi.fn(async (after: number, take: number) =>
      ids
        .filter((id) => id > after)
        .slice(0, take)
        .map(face)
    ),
    check: vi.fn(async (f: Face) => {
      const v = verdicts[f.id];
      if (v === 'throws') throw new Error('down');
      return v === 'detected' ? { status: v, reason: 'r' } : { status: v };
    }),
    remove: vi.fn(async () => true),
    logRun: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
  } satisfies Deps;
}

describe('dry run', () => {
  it('counts every face and writes nothing', async () => {
    const d = deps({ 1: 'allowed', 2: 'detected', 3: 'unavailable', 4: 'throws', 5: 'detected' });
    const { counts, file } = await scan(d, pace);

    expect(counts).toEqual({ faces: 5, allowed: 1, detected: 2, unavailable: 2 });
    expect(file.detected).toEqual([
      { id: 2, sfwCoverImageId: 20, reason: 'r' },
      { id: 5, sfwCoverImageId: 50, reason: 'r' },
    ]);
    expect(file.unavailable).toEqual([3, 4]);
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.logRun).not.toHaveBeenCalled();
  });
});

describe('apply', () => {
  const fileText = JSON.stringify({
    kind: 'com-face-sweep-dry-run',
    createdAt: '2026-11-12T00:00:00.000Z',
    detected: [
      { id: 2, sfwCoverImageId: 20, reason: 'r' },
      { id: 5, sfwCoverImageId: 50 },
      { id: 7, sfwCoverImageId: 70 },
    ],
    unavailable: [],
  });

  it('refuses a file whose count is not --expect, before any write', async () => {
    const d = deps({});
    await expect(apply(d, fileText, { ...pace, expect: 2 })).rejects.toThrow('lists 3');
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.logRun).not.toHaveBeenCalled();
  });

  it('removes exactly the file, without checking again, and logs one batch row', async () => {
    const d = deps({});
    d.remove.mockImplementation(async (m) => {
      if (m.id === 7) throw new Error('db');
      return m.id === 2;
    });
    const log = await apply(d, fileText, { ...pace, expect: 3 });

    expect(d.check).not.toHaveBeenCalled();
    expect(d.remove.mock.calls.map(([m]) => m.id).sort()).toEqual([2, 5, 7]);
    expect(log).toMatchObject({
      removed: [{ id: 2, sfwCoverImageId: 20 }],
      skipped: [5],
      failed: [{ id: 7, sfwCoverImageId: 70 }],
      runFileSha256: sha256(fileText),
    });
    expect(d.logRun).toHaveBeenCalledTimes(1);
    expect(d.logRun).toHaveBeenCalledWith({
      activity: 'comFaceSweep',
      entityType: runEntityType(log.runId, sha256(fileText)),
      entityId: 1,
    });
  });
});

describe('undo', () => {
  let pg: PGlite;
  const raw = () => pgliteRaw(pg);
  const at = (iso: string, sfwCoverImageId = 10) => ({
    at: iso,
    sfwCoverImageId,
    reason: 'detected' as const,
  });
  const log: RunLog = {
    kind: 'com-face-sweep-apply',
    runId: 'run-1',
    runFileSha256: 'a'.repeat(64),
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T11:00:00.000Z',
    removed: [
      ...[1, 2, 3, 4, 6, 7].map((id) => ({ id, sfwCoverImageId: id === 4 ? 12 : 10 })),
      // 8: the log names a different cover than the marker holds.
      { id: 8, sfwCoverImageId: 13 },
    ],
    skipped: [],
    failed: [{ id: 5, sfwCoverImageId: 10 }],
  };
  const cover = async (id: number) =>
    (
      await pg.query<{ sfwCoverImageId: number | null; meta: Record<string, unknown> }>(
        `SELECT "sfwCoverImageId", meta FROM "Model" WHERE id = $1`,
        [id]
      )
    ).rows[0];

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Model" (id int PRIMARY KEY, "sfwCoverImageId" int, meta jsonb);
      CREATE TABLE "Image" (id int PRIMARY KEY);
      INSERT INTO "Image" VALUES (10), (13);
      INSERT INTO "Model" SELECT g, CASE g WHEN 4 THEN 12 ELSE 10 END, '{"keep":1}'
        FROM generate_series(1, 8) g;
    `);
    // As the sweep wrote them, inside the run's window. 4's cover is an image since deleted.
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const coverId = id === 4 ? 12 : 10;
      const marker = at('2026-11-12T10:30:00.000Z', coverId);
      // 6: taken off by the re-check's no-verdict path, not by this sweep.
      const reason = id === 6 ? ('recheck-unverified' as const) : marker.reason;
      await raw().executeRaw(comFaceRemovalSql(id, coverId, { ...marker, reason }));
    }
    // 2: the owner picked a cover since. 3: removed again later, by a listing edit's re-check.
    await pg.exec(
      `UPDATE "Model" SET "sfwCoverImageId" = 11, meta = meta - 'comFaceRemoved' WHERE id = 2`
    );
    await pg.exec(
      `UPDATE "Model" SET "sfwCoverImageId" = 10, meta = meta - 'comFaceRemoved' WHERE id = 3`
    );
    await raw().executeRaw(comFaceRemovalSql(3, 10, at('2026-11-12T12:00:00.000Z')));
    // 7: a cover is set again with the marker still there.
    await pg.exec(`UPDATE "Model" SET "sfwCoverImageId" = 11 WHERE id = 7`);
  });

  const run = (write: boolean) => async (q: Prisma.Sql) =>
    write ? raw().executeRaw(q) : (await raw().queryRaw(q)).length;

  it('dry run counts and writes nothing', async () => {
    const d = { run: run(false), finish: vi.fn(), logRun: vi.fn() };
    const before = (await pg.query(`SELECT * FROM "Model" ORDER BY id`)).rows;
    const result = await restore(d, JSON.stringify(log), { write: false });

    expect(result).toMatchObject({ restored: [1, 5], skipped: [2, 3, 4, 6, 7, 8] });
    expect((await pg.query(`SELECT * FROM "Model" ORDER BY id`)).rows).toEqual(before);
    expect(d.finish).not.toHaveBeenCalled();
    expect(d.logRun).not.toHaveBeenCalled();
  });

  it('puts back only covers nothing has moved, then recomputes and logs one batch row', async () => {
    const d = {
      run: run(true),
      finish: vi.fn(async () => undefined),
      logRun: vi.fn(async () => undefined),
    };
    const result = await restore(d, JSON.stringify(log), { write: true });

    expect(result).toMatchObject({ restored: [1, 5], skipped: [2, 3, 4, 6, 7, 8] });
    expect(await cover(1)).toEqual({ sfwCoverImageId: 10, meta: { keep: 1 } });
    expect((await cover(2)).sfwCoverImageId).toBe(11);
    expect((await cover(3)).sfwCoverImageId).toBeNull();
    expect((await cover(4)).sfwCoverImageId).toBeNull();
    expect(d.finish.mock.calls.map(([id]) => id)).toEqual([1, 5]);
    expect(d.logRun).toHaveBeenCalledTimes(1);
    expect(d.logRun).toHaveBeenCalledWith({
      activity: 'comFaceSweepUndo',
      entityType: runEntityType('run-1', 'a'.repeat(64)),
      entityId: 2,
    });
  });

  it('limits to --ids and refuses an id the run never touched', async () => {
    const d = { run: run(false), finish: vi.fn(), logRun: vi.fn() };
    expect(await restore(d, JSON.stringify(log), { ids: [1], write: false })).toMatchObject({
      restored: [1],
      skipped: [],
    });
    await expect(restore(d, JSON.stringify(log), { ids: [1, 99], write: false })).rejects.toThrow(
      'not in this run'
    );
  });
});

it('runs only under their own file names, so a rename cannot turn a run into a silent no-op', () => {
  for (const name of [SWEEP, RESTORE])
    expect(existsSync(path.join(__dirname, '../oneoffs', `${name}.ts`))).toBe(true);
});
