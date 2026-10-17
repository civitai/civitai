import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { TagTrainingRow } from '~/server/services/resource-intent-tags/build';
import {
  genObservationOf,
  genObservationsSql,
  genTrainingRow,
  observationUserHash,
  readPostedSample,
  retryingQuery,
  standbyQuery,
  tagTrainingWindow,
} from '~/server/services/resource-intent-tags/sources';

describe('resource-intent-tags sources', () => {
  it("hashes a posted user id exactly as the observations' keyed hash does", () => {
    // Expected values computed independently: int(HMAC-SHA256(key, b'user\0' + str(id)).hexdigest()[:16], 16).
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    expect(observationUserHash(key, 42)).toBe('9339344538256439646');
    expect(observationUserHash(key, 1234567)).toBe('3778669012177265338');
  });

  it('maps an observation, skipping versions the map does not know', () => {
    const o = genObservationOf({
      u: '77',
      p: 'a kite',
      v: ['5', 6, 9],
      liked: 1,
      favorite: 0,
      disliked: '0',
    });
    expect(o).toEqual({
      user: '77',
      prompt: 'a kite',
      versionIds: [5, 6, 9],
      liked: true,
      favorite: false,
      disliked: false,
    });
    const versions = new Map([
      [5, { modelId: 50, type: 'Checkpoint', baseModel: 'E1' }],
      [9, { modelId: 90, type: 'LORA', baseModel: 'E1' }],
    ]);
    expect(genTrainingRow(o, versions).resources).toEqual([
      { modelId: 50, type: 'Checkpoint', baseModel: 'E1' },
      { modelId: 90, type: 'LORA', baseModel: 'E1' },
    ]);
  });

  it('samples each hour by its first minutes, inside the window', () => {
    const sql = genObservationsSql(
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
      2
    );
    expect(sql).toContain("time >= toDateTime('2026-09-01 00:00:00', 'UTC')");
    expect(sql).toContain("time < toDateTime('2026-10-01 00:00:00', 'UTC')");
    expect(sql.match(/toMinute\(toTimeZone\(time, 'UTC'\)\) < 2/g)?.length).toBe(2);
    expect(() => genObservationsSql(new Date(), new Date(), 0)).toThrow('sliceMinutes');
  });

  it('ends the window a whole UTC day before the build day', () => {
    expect(tagTrainingWindow(new Date('2026-10-16T23:59:00Z'))).toEqual({
      start: new Date('2026-07-17T00:00:00Z'),
      end: new Date('2026-10-15T00:00:00Z'),
    });
  });

  it('reads nothing from a server that is not a standby, inside a read-only transaction', async () => {
    const run = (standby: boolean, log: string[]) =>
      standbyQuery(
        (fn) =>
          fn({
            $executeRawUnsafe: async (q: string) => (log.push(q), 0),
            $queryRaw: async <T>(q: Prisma.Sql) => {
              log.push(q.sql);
              return (q.sql.includes('pg_is_in_recovery') ? [{ standby }] : [{ id: 1 }]) as T;
            },
          }),
        1000
      );
    const primaryLog: string[] = [];
    await expect(run(false, primaryLog)({ sql: 'SELECT 1' } as Prisma.Sql)).rejects.toThrow(
      'not to a standby'
    );
    expect(primaryLog).not.toContain('SELECT 1');
    const log: string[] = [];
    await expect(run(true, log)({ sql: 'SELECT 1' } as Prisma.Sql)).resolves.toEqual([{ id: 1 }]);
    expect(log[0]).toBe('SET TRANSACTION READ ONLY');
    expect(log.at(-1)).toBe('SELECT 1');
  });

  it('hands on a posted image whose attachments resolve to nothing with no resources', async () => {
    const query = async (q: Prisma.Sql) => {
      if (q.sql.includes('max(id)')) return [{ max: 100 }];
      if (q.sql.includes('ORDER BY id LIMIT 1')) {
        const id = q.values[0] as number;
        return [{ id, createdAt: new Date(id < 40 ? '2026-01-01' : '2026-03-01') }];
      }
      return [
        { userId: 1, prompt: 'a', resources: null, reactions: 0, tips: 0 },
        {
          userId: 2,
          prompt: 'b',
          resources: [{ modelId: 3, type: 'LORA', baseModel: 'E' }],
          reactions: 4,
          tips: 1,
        },
      ];
    };
    const got: TagTrainingRow[] = [];
    const r = await readPostedSample(query, {
      start: new Date('2026-02-01'),
      end: new Date('2026-04-01'),
      mod: 6,
      idBatch: 1000,
      userKey: (id) => `u${id}`,
      onBatch: (rows) => void got.push(...rows),
    });
    expect(r).toMatchObject({ idLo: 40, batches: 1 });
    expect(got.map((x) => [x.user, x.resources.length])).toEqual([
      ['u1', 0],
      ['u2', 1],
    ]);
  });

  it('retries a failed statement, and gives up after the last try', async () => {
    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw new Error('connection closed');
      return [{ ok: 1 }];
    };
    await expect(retryingQuery(flaky, 3, 0)({} as Prisma.Sql)).resolves.toEqual([{ ok: 1 }]);
    expect(calls).toBe(3);
    calls = -10;
    await expect(retryingQuery(flaky, 3, 0)({} as Prisma.Sql)).rejects.toThrow('connection closed');
    expect(calls).toBe(-7);
  });
});
