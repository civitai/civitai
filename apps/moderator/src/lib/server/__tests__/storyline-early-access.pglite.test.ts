import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { getStorylineEarlyAccessSignups } = await import('../storyline-early-access.service');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Storyline" ("id" INTEGER PRIMARY KEY, "title" TEXT NOT NULL);
CREATE TABLE "StorylineEarlyAccessSignup" (
  "userId" INTEGER PRIMARY KEY,
  "storylineId" INTEGER,
  "createdAt" TIMESTAMP NOT NULL
);
INSERT INTO "User" VALUES (1, 'first'), (2, 'second'), (3, 'third');
INSERT INTO "Storyline" VALUES (10, 'The Patch');
INSERT INTO "StorylineEarlyAccessSignup" VALUES
  (1, 10, '2026-10-01'),
  (2, NULL, '2026-10-03'),
  (3, 99, '2026-10-02');
`;

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('storyline early access sign-ups', () => {
  it('lists who signed up and when, newest first, with where they signed up from', async () => {
    const { items, total } = await getStorylineEarlyAccessSignups({ limit: 10 });
    expect(total).toBe(3);
    expect(items.map((i) => [i.username, i.storylineId, i.storylineTitle])).toEqual([
      ['second', null, null],
      // The storyline it was signed up from has since gone: still a sign-up.
      ['third', 99, null],
      ['first', 10, 'The Patch'],
    ]);
    expect(items[0].createdAt).toEqual(new Date('2026-10-03T00:00:00Z'));
  });

  it('pages, and counts every sign-up whatever the page', async () => {
    const second = await getStorylineEarlyAccessSignups({ limit: 2, offset: 2 });
    expect([second.items.map((i) => i.userId), second.total]).toEqual([[1], 3]);
  });
});
