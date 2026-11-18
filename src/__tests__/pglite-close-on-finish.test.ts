import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { keepPgliteForFile, openTrackedPglites } from './pglite-tracker';

// The tests in this file run in order and read what an EARLIER test left behind, which is the
// point: the closing happens between tests, in pglite-close-on-finish.ts's hooks.

let fromFile: PGlite;
let fromTest: PGlite;
let fromCreate: PGlite;
let kept: PGlite;

beforeAll(async () => {
  fromFile = await PGlite.create();
});

describe('pglite-close-on-finish', () => {
  it('lets a test use the instances it opens, and the ones its file opened', async () => {
    fromTest = new PGlite();
    fromCreate = await PGlite.create();
    kept = await PGlite.create();
    keepPgliteForFile(kept);
    for (const db of [fromTest, fromCreate, kept, fromFile]) {
      expect((await db.query<{ x: number }>('SELECT 1 AS x')).rows[0].x).toBe(1);
      expect(db.closed).toBe(false);
    }
    expect(openTrackedPglites()).toBe(4);
  });

  it('closes what that test opened once it has finished (positive control)', () => {
    expect(fromTest.closed).toBe(true);
    expect(fromCreate.closed).toBe(true);
  });

  it('keeps the file-scoped and kept instances open for later tests (negative control)', async () => {
    expect(fromFile.closed).toBe(false);
    expect(kept.closed).toBe(false);
    expect((await fromFile.query<{ x: number }>('SELECT 2 AS x')).rows[0].x).toBe(2);
    expect((await kept.query<{ x: number }>('SELECT 3 AS x')).rows[0].x).toBe(3);
    expect(openTrackedPglites()).toBe(2);
  });

  it('tracks copies made with clone()', async () => {
    const copy = await fromFile.clone();
    expect(copy.closed).toBe(false);
    expect(openTrackedPglites()).toBe(3);
  });

  it('closed the clone with the test that made it', () => {
    expect(openTrackedPglites()).toBe(2);
  });
});
