import { describe, expect, it } from 'vitest';
import { pgliteFromSnapshot } from './pglite-snapshot';

const key = (name: string) => `pglite-snapshot.test:${name}`;

describe('pgliteFromSnapshot', () => {
  it('gives each call its own copy of the built database', async () => {
    const build = async (db: Awaited<ReturnType<typeof pgliteFromSnapshot>>) => {
      await db.exec('CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT)');
      await db.exec(`INSERT INTO t (v) VALUES ('seeded-a'), ('seeded-b')`);
    };
    const a = await pgliteFromSnapshot(key('copies'), build);
    const b = await pgliteFromSnapshot(key('copies'), build);
    try {
      await a.exec(`INSERT INTO t (v) VALUES ('only-in-a')`);
      expect((await a.query<{ n: number }>('SELECT count(*)::int AS n FROM t')).rows[0].n).toBe(3);
      expect((await b.query<{ n: number }>('SELECT count(*)::int AS n FROM t')).rows[0].n).toBe(2);
      // The sequence resumes right after the seeded rows (no WAL replay jump), in every copy.
      const next = await b.query<{ id: number }>(`INSERT INTO t (v) VALUES ('x') RETURNING id`);
      expect(next.rows[0].id).toBe(3);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('builds once per key, and again for a different key', async () => {
    let builds = 0;
    const build = async () => {
      builds++;
    };
    const dbs = [
      await pgliteFromSnapshot(key('once'), build),
      await pgliteFromSnapshot(key('once'), build),
      await pgliteFromSnapshot(key('once-other'), build),
    ];
    await Promise.all(dbs.map((d) => d.close()));
    expect(builds).toBe(2);
  });

  it('passes its options to every copy, and does not carry session settings', async () => {
    const parsers = { 25: (v: string) => `parsed:${v}` }; // text
    const db = await pgliteFromSnapshot(
      key('options'),
      async (t) => {
        await t.exec(`SET TIME ZONE 'Pacific/Chatham'`);
      },
      { parsers }
    );
    try {
      expect((await db.query<{ s: string }>(`SELECT 'v'::text AS s`)).rows[0].s).toBe('parsed:v');
      const tz = (await db.query<{ TimeZone: string }>('SHOW TIME ZONE')).rows[0];
      expect(Object.values(tz)[0]).not.toBe('Pacific/Chatham');
    } finally {
      await db.close();
    }
  });

  it('does not cache a failed build', async () => {
    let calls = 0;
    const build = async () => {
      calls++;
      if (calls === 1) throw new Error('first build fails');
    };
    await expect(pgliteFromSnapshot(key('retry'), build)).rejects.toThrow('first build fails');
    const db = await pgliteFromSnapshot(key('retry'), build);
    await db.close();
    expect(calls).toBe(2);
  });
});
